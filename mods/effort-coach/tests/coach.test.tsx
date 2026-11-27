import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { neighbour, parseLevel } from '../hooks/suggest'
import { route, sanitizePolicy } from '../hooks/policy'

// Stands for the engine beneath the plugin. `answers` are what the person picks or types in
// the effort dialog, in order; `asked` collects each dialog's question; `sent` the effort of
// each main-thread request; `agents` the Agent inputs that reached the engine.
function engine($: Engine, on: On, answers: string[] = []) {
  const asked: { question: string; options: string[] }[] = []
  const sent: (string | number | undefined)[] = []
  const agents: Record<string, unknown>[] = []
  const toasts: string[] = []
  const status: (string | undefined)[] = []
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('ui.toast', (_, e) => {
    toasts.push((e as { text: string }).text)
    return { value: undefined } as never
  })
  on('ui.status', (_, e) => {
    status.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('tool.call', { tool: 'AskUserQuestion' }, (_, e) => {
    const q = e.questions[0]!
    asked.push({ question: q.question, options: q.options.map(o => o.label) })
    const answer = answers.shift()
    if (answer === undefined) throw new Error('dismissed')
    return { result: { questions: e.questions, answers: { [q.question]: answer } } } as never
  })
  on('tool.call', { tool: 'Agent' }, (_, e) => {
    agents.push({ ...e })
    return { result: {} } as never
  })
  on('turn.step', async function* (_, e) {
    sent.push(e.effort)
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [] } as never
  })
  let n = 0
  // One request; a subagent's carries its agentId and the session's level as the engine would send it.
  const step = async (turnId: string, index: number, agentId?: string) => {
    const stream = $.turn.step({ turnId, index, model: 'claude', effort: 'high', messageCount: 1, ...(agentId !== undefined && { agentId }) } as never) as unknown as AsyncIterable<unknown>
    for await (const _ of stream) void _
  }
  const turn = async (text: string) => {
    const turnId = `t${n++}`
    await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)
    await $.turn.start({ text, turnId } as never)
    await step(turnId, 0)
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId })
  }
  const start = async () => {
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true } as never)
    await turn('hello there, first prompt of the day') // learns the session's level: high
  }
  return { asked, sent, agents, toasts, status, step, turn, start }
}

test('a subagent starting mid-prompt neither takes nor clears the prompt’s level', async ($, on) => {
  const x = engine($, on, ['Use low'])
  await x.start()
  await $.prompt.submit({ text: 'thanks!', wait: false, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'thanks!', turnId: 'm1' } as never)
  await x.step('m1', 0)
  await $.turn.start({ text: 'sub', turnId: 'a1', agentId: 'x' } as never)
  await x.step('a1', 0, 'x')
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 'a1', agentId: 'x' } as never)
  await x.step('m1', 1)
  // start's one turn on high, then the main turn on low twice, the subagent untouched in between.
  expect(x.sent).toEqual(['high', 'low', 'high', 'low'])
})

test('a prompt typed over a running turn is not coached', async ($, on) => {
  const x = engine($, on, ['Use low'])
  await x.start()
  await $.prompt.submit({ text: 'thanks!', wait: false, turnId: 'running', origin: { kind: 'composer' } } as never)
  expect(x.asked).toHaveLength(0)
  await $.turn.start({ text: '', turnId: 'next' } as never)
  await x.step('next', 0)
  expect(x.sent).toEqual(['high', 'high'])
})

test('the dialog offers the suggestion, its milder neighbour, keep and stop; the neighbour applies', async ($, on) => {
  const x = engine($, on, ['Use medium'])
  await x.start()
  await x.turn('thanks!') // suggests low on a high session
  expect(x.asked[0]?.options).toEqual(['Use low', 'Use medium', 'Keep high', 'Stop asking this session'])
  expect(x.asked[0]?.question.endsWith('?')).toBe(true)
  expect(x.asked[0]?.question).toMatch(/cache/)
  expect(x.sent).toEqual(['high', 'medium'])
  // Taken as the button, not parsed as text typed under Other (which toasts).
  expect(x.toasts).toEqual([])
})

test('the status line is empty unless a per-prompt level is in force, and clears when that turn ends', async ($, on) => {
  const x = engine($, on, ['Use low'])
  await x.start()
  expect(x.status.length).toBeGreaterThan(0)
  expect(x.status.every(s => s === undefined)).toBe(true)
  await $.prompt.submit({ text: 'thanks!', wait: false, origin: { kind: 'composer' } } as never)
  await $.turn.start({ text: 'thanks!', turnId: 's1' } as never)
  expect(x.status.at(-1)).toBe('effort → low (this prompt)')
  await x.step('s1', 0)
  await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: 's1' })
  expect(x.status.at(-1)).toBe(undefined)
})

test('a level typed under Other is applied, any of the five; text naming none keeps the level', async ($, on) => {
  const x = engine($, on, ['max please', 'something else', 'low or high'])
  await x.start()
  await x.turn('thanks!')
  await x.turn('ok cool')
  await x.turn('nice')
  expect(x.sent).toEqual(['high', 'max', 'high', 'high'])
  expect(x.toasts.filter(t => /names no single level/.test(t))).toHaveLength(2)
})

test('stop asking mutes the dialog for the session', async ($, on) => {
  const x = engine($, on, ['Stop asking this session'])
  await x.start()
  await x.turn('thanks!') // muted here
  await x.turn('ok cool') // not asked again
  expect(x.asked).toHaveLength(1)
  expect(x.sent).toEqual(['high', 'high', 'high'])
})

test('a dismissed dialog keeps the session level', async ($, on) => {
  const x = engine($, on, []) // no answer: the dialog rejects, as when dismissed
  await x.start()
  await x.turn('thanks!')
  expect(x.asked).toHaveLength(1)
  expect(x.sent).toEqual(['high', 'high'])
})

test('neighbour and parseLevel', () => {
  expect(neighbour('low', 'high')).toBe('medium')
  expect(neighbour('xhigh', 'medium')).toBe('high')
  expect(neighbour('max', 'medium')).toBe('xhigh')
  expect(neighbour('low', 'medium')).toBe(null) // the neighbour would be the current one
  expect(parseLevel('XHIGH')).toBe('xhigh')
  expect(parseLevel('go high')).toBe('high')
  expect(parseLevel('high and higher')).toBe('high')
  expect(parseLevel('low or max')).toBe(null)
  expect(parseLevel('whatever')).toBe(null)
})

test('the Agent policy reroutes an unset Explore, respects what Claude set, and force overrides', async ($, on) => {
  const x = engine($, on)
  await x.start()
  const call = (input: Record<string, unknown>) => $.tool.call({ tool: 'Agent', description: 'find it', prompt: 'p', ...input } as never)

  await call({ subagent_type: 'Explore' })
  await call({ subagent_type: 'Explore', model: 'sonnet' }) // model explicit: kept; effort filled
  await call({ subagent_type: 'general-purpose' }) // no rule: untouched
  await call({}) // omitted type is general-purpose: untouched
  await $.command.run({ command: 'effort-coach', args: 'agents Explore haiku low force' } as never)
  await call({ subagent_type: 'Explore', model: 'opus', effort: 'max' })
  await call({ subagent_type: 'fork' }) // never rerouted

  const got = x.agents.map(a => [a.subagent_type, a.model, a.effort])
  expect(got).toEqual([
    ['Explore', 'haiku', 'low'],
    ['Explore', 'sonnet', 'low'],
    ['general-purpose', undefined, undefined],
    [undefined, undefined, undefined],
    ['Explore', 'haiku', 'low'],
    ['fork', undefined, undefined],
  ])
  // Reroutes are told in a toast and never touch the status line.
  expect(x.toasts.filter(t => /subagent →/.test(t))).toEqual([
    'Explore subagent → haiku/low',
    'Explore subagent → sonnet/low',
    'Explore subagent → haiku/low',
  ])
  expect(x.status.every(s => s === undefined)).toBe(true)
})

test('route: no rule, a fill, a force', () => {
  const policy = { Plan: { effort: 'high' as const }, Explore: { model: 'haiku' as const, force: true } }
  expect(route({ subagent_type: 'Plan', effort: 'low' }, policy).isChanged).toBe(false)
  expect(route({ subagent_type: 'Plan' }, policy)).toEqual({ type: 'Plan', model: undefined, effort: 'high', isChanged: true })
  expect(route({ subagent_type: 'Explore', model: 'opus' }, policy).model).toBe('haiku')
  expect(route({ subagent_type: 'other' }, policy).isChanged).toBe(false)
  // A fork ignores model and effort, so even a rule naming it changes nothing.
  expect(route({ subagent_type: 'fork' }, { fork: { model: 'haiku', effort: 'low', force: true } }).isChanged).toBe(false)
})

test('/effort-coach agents sets, refuses an unknown word, and removes a rule', async ($, on) => {
  const x = engine($, on)
  await x.start()
  const run = async (args: string) => ((await $.command.run({ command: 'effort-coach', args } as never)) as { text: string }).text
  expect(await run('agents Plan sonnet medium')).toBe('Plan → sonnet · medium')
  expect(await run('agents Plan turbo')).toMatch(/^Not changed: "turbo" is not a model/)
  expect(await run('agents')).toMatch(/Plan → sonnet · medium/)
  expect(await run('agents Plan off')).toMatch(/removed/)
  expect(await run('agents')).not.toMatch(/Plan/)
  expect(await run('agents reset')).toMatch(/Explore → haiku · low/)
  expect(await run('agents fork haiku')).toMatch(/^Not changed: a fork/)
  expect(await run('agents explore sonnet')).toBe('Explore → sonnet · its effort (taken as Explore)')
  expect(await run('agents my-agent haiku')).toMatch(/not a subagent type this mod knows of/)
})

test('a malformed stored policy keeps its good rules and reports the rest', () => {
  const { policy, dropped } = sanitizePolicy({
    Explore: { model: 'haiku', effort: 'low', force: 'yes' },
    Plan: { model: 'gpt-5' },
    Empty: {},
    Bad: null,
    Ok: { effort: 'max', force: true },
  })
  expect(policy).toEqual({ Explore: { model: 'haiku', effort: 'low' }, Ok: { effort: 'max', force: true } })
  expect(dropped).toEqual(['Plan', 'Empty', 'Bad'])
  expect(sanitizePolicy('nonsense').dropped).toEqual(['(the whole stored policy)'])
})

const PANE = {
  plugin: 'effort-coach',
  component: 'Pane',
  requestId: 'effort-coach',
  props: { title: 'Effort coach', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('the pane shows effort, mode, rules and reroutes, and its buttons edit the policy, on every surface', async ($, on) => {
  const x = engine($, on)
  await x.start()
  await $.tool.call({ tool: 'Agent', description: 'find the config', prompt: 'p', subagent_type: 'Explore' } as never)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^Effort:/ }))?.text).toBe('Effort: high')
    expect((await ui.find({ type: 'Text', text: /^Coach:/ }))?.text).toBe('Coach: ask')
    expect(await ui.find({ type: 'Text', text: /^Explore → haiku · low$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Explore “find the config” default\/default → haiku\/low/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Cache:/ })).toBeDefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'force:Explore' })
  expect(await ui.find({ type: 'Text', text: /^Explore → haiku · low · force$/ })).toBeDefined()
  await ui.press({ key: 'remove:claude-code-guide' })
  expect(await ui.find({ type: 'Text', text: /^claude-code-guide/ })).toBeUndefined()
  await ui.press({ key: 'mode:off' })
  expect((await ui.find({ type: 'Text', text: /^Coach:/ }))?.text).toBe('Coach: off')
  await ui.unmount()
})

test('the policy edited in one session is read back in the next', async ($, on) => {
  const x = engine($, on)
  await x.start()
  await $.command.run({ command: 'effort-coach', args: 'agents Plan opus' } as never)
  await x.start() // a new session.start reads the store
  const text = ((await $.command.run({ command: 'effort-coach', args: 'agents' } as never)) as { text: string }).text
  expect(text).toMatch(/Plan → opus · its effort/)
})
