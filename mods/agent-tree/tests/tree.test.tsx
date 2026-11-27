import { expect, mock, test } from 'claude-code/testing'

import { etaLabel, etaMs, fmtDuration, fmtEffort, fmtTokens, graphSvg, isHarnessMessage, layout, prettyModel, summarize } from '../hooks/register'
import type { AgentNode } from '../types'

const NOW = Date.parse('2026-11-02T12:00:00Z')

test('formats models, tokens, durations, effort and one-line summaries', () => {
  expect(prettyModel('claude-sonnet-5-5')).toBe('Sonnet 5.5')
  expect(prettyModel('claude-opus-5-5[1m]')).toBe('Opus 5.5')
  expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
  expect(prettyModel('gpt-x')).toBe('gpt-x')
  expect(fmtTokens(950)).toBe('950')
  expect(fmtTokens(4_210)).toBe('4.2k')
  expect(fmtTokens(48_400)).toBe('48k')
  expect(fmtDuration(14_000)).toBe('14s')
  expect(fmtDuration(80_000)).toBe('1m 20s')
  expect(fmtEffort('xhigh')).toBe('xhigh')
  expect(fmtEffort(32_000)).toBe('32k budget')
  expect(fmtEffort(undefined)).toBe('none')
  expect(summarize('**Find** the three cheapest competitors. Then write a table.')).toBe('Find the three cheapest competitors.')
  const long = summarize('word '.repeat(60))
  expect(long.endsWith('…')).toBe(true)
  expect(long.length).toBeLessThanOrEqual(90)
})

test('a harness message wakes the root but does not replace the task', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('prompt.submit', (_, e) => e as never)
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)

  expect(isHarnessMessage('<task-notification>\n<task-id>x</task-id>')).toBe(true)
  expect(isHarnessMessage('  <system-reminder>hi</system-reminder>')).toBe(true)
  expect(isHarnessMessage('Fix the <div> layout')).toBe(false)
  expect(isHarnessMessage('a < b and c > d')).toBe(false)

  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true } as never)
  await $.prompt.submit({ text: 'Refactor the parser module' } as never)
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1000, isAborted: false, turnId: 'a' } as never)
  await $.prompt.submit({ text: '<task-notification>\n<task-id>bbumxepge</task-id>\n<status>failed</status>\n</task-notification>' } as never)

  const pane = await $.ui.mount({
    plugin: 'agent-tree', surface: 'terminal', component: 'Pane', requestId: 'agent-tree',
    viewport: { columns: 70, rows: 40 },
    props: { title: 'Agents', isFocused: false, bodyColumns: 66, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  } as never)
  const text = (await pane.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
  expect(text).toContain('Refactor the parser module')
  expect(text).not.toContain('task-notification')
  expect(text).toContain('running') // the notification still woke the main turn
  await pane.unmount()
})

const LONG_PROMPT =
  'Survey the pricing pages of our five closest competitors. For each one, record plan names, ' +
  'monthly and annual prices, seat limits and any usage caps, then summarise the differences in a table ' +
  'with a short note on positioning. Cite every page you read.'

test('draws parent, two parallel subagents and a nested one, with model, effort and one-line task', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('prompt.submit', (_, e) => e as never)
  on('tool.call', () => ({ result: { text: 'ok' } }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn',
      usage: { input_tokens: 500, output_tokens: 1200, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 1500, model: e.model },
    } as never
  })
  const ids = ['agent-res', 'agent-cod', 'agent-scr']
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: ids.shift() }) as never)

  const step = async (agentId: string | undefined, model: string, effort?: 'low' | 'medium' | 'high') => {
    const s = $.turn.step({ turnId: `t-${agentId ?? 'main'}`, index: 0, model, messageCount: 3, ...(effort ? { effort } : {}), ...(agentId ? { agentId } : {}) } as never)
    for await (const _ of s) void _
  }
  const spawn = async (tu: string, description: string, prompt: string, parentAgentId?: string, effort?: 'low') => {
    // The Agent tool call wraps its spawn: its `effort` argument is what was asked.
    await $.tool.call({ tool: 'Agent', tool_use_id: tu, description, prompt, ...(effort ? { effort } : {}), ...(parentAgentId ? { agentId: parentAgentId } : {}) } as never)
    await $.agent.spawn({
      tool_use_id: tu, prompt, description, subagentType: 'general-purpose',
      provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
      ...(parentAgentId ? { parentAgentId } : {}),
    } as never)
  }

  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true } as never)
  await $.prompt.submit({ text: 'Launch the new pricing page by Friday' } as never)
  await step(undefined, 'claude-opus-5-5', 'high')

  // Two siblings started together run in parallel; the scraper is nested under the researcher.
  await spawn('tu-res', 'Survey competitor pricing', LONG_PROMPT)
  await spawn('tu-cod', 'Build pricing page', 'Implement the pricing page in app/pricing. Use the existing card component.', undefined, 'low')
  await clock.advance(5_000)
  await spawn('tu-scr', 'Scrape one site', 'Fetch acme.example/pricing and return the plan table as JSON.', 'agent-res')
  await step('agent-res', 'claude-sonnet-5-5', 'medium')
  await step('agent-scr', 'claude-haiku-4-5') // a request without effort: the model takes none
  await clock.advance(17_000)
  const usage = { input_tokens: 500, output_tokens: 1200, cache_read_input_tokens: 40_000, cache_creation_input_tokens: 1500, model: 'claude-haiku-4-5' }
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 17_000, isAborted: false, turnId: 't-agent-scr', agentId: 'agent-scr', usage } as never)
  await $.turn.complete({ reason: 'error', answer: '', durationMs: 22_000, isAborted: false, turnId: 'x2', agentId: 'agent-cod' } as never)

  const mount = (surface: 'desktop' | 'terminal') =>
    $.ui.mount({
      plugin: 'agent-tree', surface, component: 'Pane', requestId: 'agent-tree',
      viewport: { columns: 70, rows: 80 },
      props: { title: 'Agents', isFocused: false, bodyColumns: 66, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
    } as never)

  for (const surface of ['desktop', 'terminal'] as const) {
    const pane = await mount(surface)
    const text = (await pane.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
    expect(text).toContain('3 subagents · 1 running · 1 done · 1 failed')
    expect(text).toContain('This session')
    // Model and effort for every agent: observed on a request, asked by the Agent call, or absent.
    expect(text).toContain('Opus 5.5 · high')
    expect(text).toContain('Sonnet 5.5 · medium')
    expect(text).toContain('Sonnet 5.5 · low (asked)')
    expect(text).toContain('Haiku 4.5 · no effort')
    // The task as one line (the call's description), the full prompt kept back.
    expect(text).toContain('Survey competitor pricing')
    expect(text).not.toContain('Cite every page you read.')
    // Parallel siblings are marked, the nested agent drawn under its parent.
    if (surface === 'terminal') expect(text).toContain('⇉ 2 in parallel')
    expect(text.indexOf('Survey competitor pricing')).toBeLessThan(text.indexOf('Scrape one site'))
    expect(text.indexOf('Scrape one site')).toBeLessThan(text.indexOf('Build pricing page'))
    // Status, time, context, output and tools of the finished nested agent.
    expect(text).toContain('done · 17s · general-purpose · background · 42k ctx · 1.2k out · 0 tools')
    expect(text).toContain('failed')
    // A running agent's time is live, on the engine's clock.
    expect(text).toContain('running · 22s · ETA ? · general-purpose · background')

    const svgs = await pane.findAll({ type: 'Svg' })
    if (surface === 'desktop') {
      expect(svgs).toHaveLength(1)
      const source = String(svgs[0]!.props.source)
      expect(source).toContain('Scrape one site')
      expect(source).toContain('Survey the pricing pages of our five closest competitors.')
      expect(source).toContain('parallel ×2')
      expect(source).toContain('edge flow') // the running child's edge animates
      // Cards carry the time: exact once finished, whole minutes while running.
      expect(source).toContain('>17s</text>')
      expect(source).toContain('>&lt;1m</text>')
      expect(source.length).toBeLessThan(131_072)
    } else {
      expect(svgs).toHaveLength(0)
      expect(text).toContain('Survey the pricing pages of our five closest competitors.')
      expect(text).toContain('├─ ')
      expect(text).toContain('└─ ')
    }

    // Pressing the task line shows the whole prompt.
    await pane.press({ key: 'p-agent-res' })
    const after = (await pane.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
    expect(after).toContain('Cite every page you read.')
    await pane.press({ key: 'p-agent-res' })

    await pane.unmount()
  }
})

test('time spent counts running time only: idle gaps and resumes add nothing', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('prompt.submit', (_, e) => e as never)
  on('tool.call', () => ({ result: { text: 'ok' } }) as never)
  on('turn.start', (_, e) => e as never)
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-a' }) as never)

  const paneText = async (surface: 'desktop' | 'terminal') => {
    const pane = await $.ui.mount({
      plugin: 'agent-tree', surface, component: 'Pane', requestId: 'agent-tree',
      viewport: { columns: 70, rows: 40 },
      props: { title: 'Agents', isFocused: false, bodyColumns: 66, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    } as never)
    const text = (await pane.findAll({ type: 'Text' })).map(x => x.text).join(' | ')
    const svgs = await pane.findAll({ type: 'Svg' })
    const source = svgs[0] ? String(svgs[0].props.source) : ''
    await pane.unmount()
    return { text, source }
  }
  const done = (agentId?: string) =>
    $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: agentId ?? 'main', ...(agentId ? { agentId } : {}) } as never)

  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true } as never)
  // The session: 7s, then a long idle gap, then 3s of the next prompt.
  await $.prompt.submit({ text: 'First task for the session' } as never)
  await $.agent.spawn({
    tool_use_id: 'tu', prompt: 'Do the thing.', description: 'Do the thing', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
  } as never)
  await clock.advance(7_000)
  await done()
  await clock.advance(3_000)
  await done('agent-a') // the subagent ran 10s
  expect((await paneText('terminal')).text).toContain('done · 10s · general-purpose')

  await clock.advance(100_000)
  await $.prompt.submit({ text: 'Second task for the session' } as never)
  await $.turn.start({ turnId: 'r', agentId: 'agent-a' } as never) // resumed
  await clock.advance(3_000)
  const during = await paneText('terminal')
  expect(during.text).toContain('running · 10s · ETA ? · main') // session: 7s + 3s
  expect(during.text).toContain('running · 13s · ETA ? · general-purpose') // agent: 10s + 3s

  // A second prompt or event mid-run does not restart the run's clock.
  await $.prompt.submit({ text: '<task-notification>x</task-notification>' } as never)
  await $.turn.start({ turnId: 'r2', agentId: 'agent-a' } as never)
  await clock.advance(120_000)
  const card = await paneText('desktop')
  expect(card.source).toContain('>2m+</text>') // running: whole minutes, 13s + 2m

  await done('agent-a')
  await done()
  const end = await paneText('desktop')
  expect(end.text).toContain('2m 13s')
  expect(end.source).toContain('>2m 13s</text>') // finished: exact, on the card too
  expect(end.source).toContain('>2m 10s</text>') // the session: 7s + 3s + 2m
})

test('the ETA estimate: never a guess, and a long run gets a longer estimate, not zero', () => {
  const runs = [60_000, 120_000, 180_000]
  expect(etaMs([60_000, 120_000], 1_000)).toBe(null) // too few runs
  expect(etaLabel([60_000, 120_000], 1_000)).toBe('ETA ?')
  expect(etaMs(runs, 30_000)).toBe(90_000) // median 120s of all three, less 30s
  expect(etaMs(runs, 90_000)).toBe(60_000) // only 120s and 180s ran longer: median 150s, less 90s
  expect(etaMs(runs, 150_000)).toBe(30_000) // only 180s ran longer
  expect(etaMs(runs, 200_000)).toBe('over')
  expect(etaLabel(runs, 30_000)).toBe('~2m left') // 90s rounds up
  expect(etaLabel(runs, 150_000)).toBe('<1m left')
  expect(etaLabel(runs, 200_000)).toBe('past usual')
  expect(etaLabel([7_200_000, 7_200_000, 7_200_000], 0)).toBe('~2h 00m left')
})

test('a running agent shows an ETA from stored runs; only finished-well runs are recorded', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('prompt.submit', (_, e) => e as never)
  on('tool.call', () => ({ result: { text: 'ok' } }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  const ids = ['agent-a', 'agent-b']
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: ids.shift() }) as never)
  const stored = new Map<string, unknown>([['runHistory', { 'general-purpose': [60_000, 120_000, 180_000] }]])
  on('store.get', (_, e) => ({ value: stored.get((e as { key: string }).key) }) as never)
  on('store.set', (_, e) => {
    const { key, value } = e as { key: string; value: unknown }
    stored.set(key, value)
    return { value: undefined } as never
  })

  const look = async () => {
    const pane = await $.ui.mount({
      plugin: 'agent-tree', surface: 'desktop', component: 'Pane', requestId: 'agent-tree',
      viewport: { columns: 70, rows: 40 },
      props: { title: 'Agents', isFocused: false, bodyColumns: 66, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    } as never)
    const text = (await pane.findAll({ type: 'Text' })).map(x => x.text).join(' | ')
    const svgs = await pane.findAll({ type: 'Svg' })
    const source = svgs[0] ? String(svgs[0].props.source) : ''
    await pane.unmount()
    return { text, source }
  }
  const spawn = (tu: string) =>
    $.agent.spawn({
      tool_use_id: tu, prompt: 'Do the thing.', description: 'Do the thing', subagentType: 'general-purpose',
      provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
    } as never)
  const end = (agentId: string, reason: string) =>
    $.turn.complete({ reason, answer: '', durationMs: 1, isAborted: false, turnId: agentId, agentId } as never)
  const kept = () => (stored.get('runHistory') as Record<string, number[]>)['general-purpose']

  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true } as never)
  await spawn('tu-a')
  await clock.advance(30_000)
  let seen = await look()
  expect(seen.text).toContain('running · 30s · ~2m left · general-purpose')
  expect(seen.source).toContain('>&lt;1m · ~2m left</text>')

  await clock.advance(170_000) // 200s: longer than every run on record
  expect((await look()).text).toContain('running · 3m 20s · past usual')

  await end('agent-a', 'answer')
  seen = await look()
  expect(seen.text).toContain('done · 3m 20s · general-purpose') // finished: no ETA
  expect(seen.text).not.toContain('past usual')
  expect(kept()).toEqual([60_000, 120_000, 180_000, 200_000])

  await spawn('tu-b')
  await clock.advance(5_000)
  await end('agent-b', 'error') // a failed run teaches nothing
  expect(kept()).toHaveLength(4)
})

test('the map stays under the engine limit with 60 long, markup-heavy prompts', () => {
  const nasty = ('Run "build_report.py" on dataset_A <table> & check & <compare> "results"; \u001b[31m ').repeat(40).slice(0, 1500)
  const node = (i: number, parentId: string | null): AgentNode => ({
    id: i === 0 ? 'main' : `a${i}`, parentId, name: `Agent ${i} with a fairly long name`, kind: 'general-purpose',
    model: 'Sonnet 5.5', effort: 'high', effortFrom: 'request', summary: `Task ${i}: ${nasty.slice(0, 80)}`,
    prompt: nasty, promptChars: nasty.length, status: i % 3 ? 'running' : 'done', startedAt: 1000 + i, endedAt: null, activeMs: 0, runAt: 1000 + i, etaKey: 'general-purpose',
    ctx: 0, out: 0, turnOut: 0, tools: 0,
  })
  const list = Array.from({ length: 70 }, (_, i) => node(i + 1, i < 5 ? 'main' : `a${(i % 5) + 1}`))
  const { source } = graphSvg(layout(node(0, null), list, new Set()), 460)
  expect(source.length).toBeLessThan(131_072)
  expect(source).toContain('<title>')
  expect(source).toContain('+11 more agents')
  expect(source).not.toContain('\u001b')
  expect(source).not.toContain('\u0001')
  expect(source).toContain('build_report.py') // underscores survive
})

test('a failed bookkeeping update is counted and named in the header, not swallowed', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('tool.call', () => ({ result: { text: 'ok' } }) as never)
  // The root's store refuses writes; the error store still works.
  on('store.get', () => ({ value: undefined }) as never)
  on('command.list', () => ({ value: [] }) as never)
  on('state.set', (_, e, next) => (JSON.stringify(e).includes('"root"') ? ({ deny: 'disk full' } as never) : next(e)))

  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true } as never)
  await $.tool.call({ tool: 'Read', input: {}, tool_use_id: 't1' } as never)

  const pane = await $.ui.mount({
    plugin: 'agent-tree', surface: 'desktop', component: 'Pane', requestId: 'agent-tree',
    viewport: { columns: 70, rows: 40 },
    props: { title: 'Agents', isFocused: false, bodyColumns: 66, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  } as never)
  const text = (await pane.findAll({ type: 'Text' })).map(t => t.text).join(' | ')
  expect(text).toContain('1 update failed')
  expect(text).toContain('tool.call: ')
  await pane.unmount()
})