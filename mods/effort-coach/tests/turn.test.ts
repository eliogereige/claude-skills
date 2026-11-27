import { expect, mock, test } from 'claude-code/testing'

test('in auto mode a quick prompt runs on low for its turn only, then back to the session level', async ($, on) => {
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('ui.toast', () => ({ value: undefined }) as never)
  // The bottom of turn.step: records the effort each request went out with.
  const sent: (string | number | undefined)[] = []
  on('turn.step', async function* (_, e) {
    sent.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [] } as never
  })
  const step = async (turnId: string) => {
    const stream = $.turn.step({ turnId, index: 0, model: 'claude', effort: 'high', messageCount: 1 } as never) as unknown as AsyncIterable<unknown>
    for await (const _ of stream) void _
  }

  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true } as never)
  await $.command.run({ command: 'effort-coach', args: 'auto' } as never)
  // A first turn: the coach learns the session's level (high).
  await $.turn.start({ text: 'hi', turnId: 't0' } as never)
  await step('t0')
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't0' })

  // "thanks!" on high: low for this turn.
  await $.prompt.submit({ text: 'thanks!', wait: false, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'thanks!', turnId: 't1' } as never)
  await step('t1')
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1' })

  // The next prompt, nothing special: the session's level again.
  await $.prompt.submit({ text: 'add a legend to the scatter plot', wait: false, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'x', turnId: 't2' } as never)
  await step('t2')

  expect(sent).toEqual(['high', 'low', 'high'])
})
