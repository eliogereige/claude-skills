import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { parseFast } from '../hooks/register'

// The tests below run in this order on one module: each starts on its own
// later clock (the mod asks the app at most every 15 s), and the refusal
// cases come last because a refusal stops the asking for the session.
const HOUR = 3_600_000
const BASE = Date.parse('2026-11-02T12:00:00Z')
const GET = 'mcp__ccd_session_mgmt__get_session'

const PANE = (surface: 'desktop' | 'terminal') => ({
  plugin: 'agent-tree', surface, component: 'Pane' as const, requestId: 'agent-tree',
  viewport: { columns: 100, rows: 60 },
  props: { title: 'Agents', isFocused: false, bodyColumns: 96, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} },
})

type Answer = (e: { tool: string; session_id?: string }) => unknown

const run = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], hour: number, answer: Answer) => {
  const clock = mock.clock(on, { now: BASE + hour * HOUR })
  const asked: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('command.list', () => ({ value: [] }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('turn.start', (_, e) => ({ turnId: (e as { turnId: string }).turnId }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('tool.call', (_, e) => {
    const call = e as unknown as { tool: string; session_id?: string }
    if (call.tool === GET) {
      asked.push(call.session_id ?? '')
      return answer(call) as never
    }
    return { result: { text: 'ok' } } as never
  })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true } as never)
  await $.turn.start({ turnId: 't1' } as never)
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 10, isAborted: false, turnId: 't1' } as never)
  const read = async (surface: 'desktop' | 'terminal') => {
    const pane = await $.ui.mount(PANE(surface))
    const text = (await pane.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
    const svg = (await pane.findAll({ type: 'Svg' })).map(s => String(s.props.source)).join('')
    await pane.unmount()
    return { text, svg }
  }
  return { asked, read, clock }
}

const answered = (body: unknown) => () => ({ result: {}, text: JSON.stringify(body) })

test('reads fastMode in each shape get_session may give', () => {
  expect(parseFast('{"fastMode":"on"}')).toEqual({ state: 'on', why: '' })
  expect(parseFast('{"fastMode":{"state":"cooldown","reason":"rate limited until 14:05"}}')).toEqual({ state: 'cooldown', why: 'rate limited until 14:05' })
  expect(parseFast('{"title":"x"}').state).toBe('unknown') // not reported yet
  expect(parseFast('fastMode: off').state).toBe('off')
  expect(parseFast('{"fastMode":"turbo"}').why).toContain('unrecognised')
})

test('fast mode on: the main agent wears "⚡ fast", with the price note; the call is not counted', async ($, on) => {
  const { asked, read } = await run($, on, 1, answered({ title: 's', fastMode: 'on' }))
  expect(asked).toEqual(['self']) // asked once: turn start and end fall inside one 15 s window
  const { text, svg } = await read('desktop')
  expect(text).toContain('model ? · effort ? · ⚡ fast') // no model request seen in this test, so model and effort are '?'
  expect(text).toContain('Fast mode (from the desktop app): same tokens, about 2× the price per token (Opus 5.5: $8/$40 vs $4/$20 per MTok)')
  expect(text).toContain('0 tools') // the mod's own question is not the session's work
  expect(svg).toBe('') // no subagents: no map
})

test('fast mode off: no badge, no note', async ($, on) => {
  const { read } = await run($, on, 2, answered({ fastMode: 'off' }))
  const { text } = await read('desktop')
  expect(text).not.toContain('⚡ fast')
  expect(text).not.toContain('Fast mode')
  expect(text).not.toContain('fast: unknown')
})

test('fast mode cooling down: "fast cooldown", with the app\'s reason', async ($, on) => {
  const { read } = await run($, on, 3, answered({ fastMode: { state: 'cooldown', reason: 'rate limited until 14:05' } }))
  for (const surface of ['desktop', 'terminal'] as const) {
    const { text } = await read(surface)
    expect(text).toContain('· fast cooldown')
    expect(text).toContain('rate limited until 14:05')
  }
})

test('refused: "fast: unknown" with the reason, never a guess, and no more asking', async ($, on) => {
  const { asked, read, clock } = await run($, on, 4, () => ({ deny: 'Permission to use get_session was denied.' }))
  const { text } = await read('terminal')
  expect(text).toContain("fast: unknown (the desktop app's session tool was refused: Permission to use get_session was denied.)")
  expect(text).not.toContain('⚡ fast')
  // A later turn, past the 15 s window, does not ask again.
  await clock.advance(20_000)
  await $.turn.start({ turnId: 't2' } as never)
  expect(asked).toEqual(['self'])
})
