import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { TEMPLATES, compile, fitWidth, parseMessage } from '../hooks/architect'
import { CARD_W, route } from '../hooks/canvas'
import { addFiles, deletedPaths, fileOpsOf, launchTarget, programOf, resourceOf } from '../hooks/register'

const NOW = Date.parse('2026-11-02T12:00:00Z')

const PANE = (requestId: string) => ({
  plugin: 'agent-tree', surface: 'desktop' as const, component: 'Pane' as const, requestId,
  viewport: { columns: 100, rows: 80 },
  props: { title: 'x', isFocused: false, bodyColumns: 96, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 80 }, view: {} },
})

const texts = async (pane: { findAll: (q: { type: string }) => Promise<Array<{ text: string }>> }) =>
  (await pane.findAll({ type: 'Text' })).map(t => t.text).join(' | ')

test('resources: the program a command runs, MCP servers, web and files', () => {
  expect(programOf('cd app && FOO=1 npm test')).toBe('npm')
  expect(programOf('git status; git diff')).toBe('git')
  expect(programOf('C:\\tools\\gh.exe pr view 3')).toBe('gh')
  expect(programOf('cd x')).toBe(null)
  expect(resourceOf('mcp__github__create_issue', {})).toBe('MCP github')
  expect(resourceOf('Bash', { command: 'python -I run.py' })).toBe('python')
  expect(resourceOf('WebFetch', {})).toBe('web')
  expect(resourceOf('Read', {})).toBe('files')
  expect(resourceOf('Agent', {})).toBe(null)
})

test('a design compiles to stages, names, models and effort; problems block it', () => {
  const t = TEMPLATES['Build, test, review']!()
  expect(compile(t).problems).toContain('The architecture has no goal.')
  const c = compile({ ...t, goal: 'Add CSV export to the report page' })
  expect(c.problems).toEqual([])
  // Scout, then Builder, then Tester and Reviewer side by side.
  expect(c.stages).toEqual([['Scout'], ['Builder'], ['Tester', 'Reviewer']])
  expect(c.text).toContain('Goal: Add CSV export to the report page')
  expect(c.text).toContain('You are the orchestrator:')
  expect(c.text).toContain('name: "builder", description: "Builder", model: "opus", effort: "high"')
  expect(c.text).toContain('Reviewer reviews Builder\'s output')
  expect(c.text).toContain('It uses: CLI "test runner"')
  // A loop of hand-offs with no first step is named, not run.
  const loop = compile({ ...t, goal: 'g', edges: [...t.edges, { from: 'n3', to: 'n2', kind: 'then' }] })
  expect(loop.problems.some(p => p.startsWith('A loop of hand-offs has no first step'))).toBe(true)
  // Resources only link by "uses", from an agent.
  const bad = compile({ ...t, goal: 'g', edges: [{ from: 'n6', to: 'n2', kind: 'then' }] })
  expect(bad.problems.some(p => p.includes('only agents hand off or review'))).toBe(true)
})

test('canvas messages are checked, and links route between cards', () => {
  expect(parseMessage({ type: 'move', id: 'n1', x: 3, y: 4 })).toEqual({ type: 'move', id: 'n1', x: 3, y: 4 })
  expect(parseMessage({ type: 'move', id: 'n1', x: -1, y: 4 })).toBe(null)
  expect(parseMessage('drop table')).toBe(null)
  const cells = route({ x: 0, y: 0 }, { x: 40, y: 6 })
  expect(cells[cells.length - 1]![2]).toBe('▶')
  expect(cells.some(c => c[2] === '┐')).toBe(true)
  expect(route({ x: 0, y: 0 }, { x: 4, y: 0 })).toEqual([]) // overlapping cards: no line
})

test('the Architect: add a Haiku helper, drag it, link it, launch the design', async ($, on) => {
  mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>()
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('store.get', (_, e) => ({ value: store.get((e as { key: string }).key) }) as never)
  on('store.set', (_, e) => {
    const { key, value } = e as { key: string; value: unknown }
    store.set(key, value)
    return { value: undefined } as never
  })
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push((e as { text: string }).text)
    return e as never
  })

  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true } as never)
  const pane = await $.ui.mount(PANE('agent-architect'))

  // Launch is refused while the design has problems, and says why.
  await pane.press({ key: 'launch' })
  expect(sent).toEqual([])
  expect(await texts(pane)).toContain('Not launched: The architecture has no goal.')

  await pane.input({ key: 'arch-goal', text: 'Ship the README' })
  await pane.press({ key: 'add-builder' })
  await pane.input({ key: 'node-objective', text: 'Write the feature.' })
  await pane.press({ key: 'add-helper' })
  let shown = await texts(pane)
  expect(shown).toContain('Helper (Haiku)')
  // The helper starts on Haiku with effort left unset (a preset level could be dropped).
  const canvas = (await pane.findAll({ type: 'Client' }))[0] as unknown as { props: { props: { nodes: Array<{ id: string; label: string; line2: string; x: number; y: number }> } } }
  const helper = canvas.props.props.nodes.find(n => n.label.startsWith('Helper'))!
  expect(helper.line2).toBe('haiku')
  await pane.input({ key: 'node-objective', text: 'Write README.md from the builder\'s notes. Commit it.' })

  // Drag the helper on the canvas: down on it, move, up.
  await pane.pointer({ type: 'down', x: helper.x + 2, y: helper.y + 1, button: 'left' })
  await pane.pointer({ type: 'move', x: helper.x + 12, y: helper.y + 9, button: 'left' })
  await pane.pointer({ type: 'up', x: helper.x + 12, y: helper.y + 9, button: 'left' })
  const moved = (store.get('architect.current') as { nodes: Array<{ id: string; x: number; y: number }> }).nodes.find(n => n.id === helper.id)!
  expect([moved.x, moved.y]).toEqual([helper.x + 10, helper.y + 8])

  // Link: builder hands off to the helper.
  await pane.post({ type: 'select', id: 'n1' })
  await pane.press({ key: 'link-then' })
  expect(await texts(pane)).toContain('Click the card that Builder hands off to.')
  await pane.post({ type: 'link', to: helper.id })
  shown = await texts(pane)
  expect(shown).toContain('Linked.')
  expect(shown).toContain('Runs in 2 stages: Builder  →  Helper (Haiku)')

  await pane.press({ key: 'launch' })
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('Goal: Ship the README')
  expect(sent[0]).toContain('name: "helper-haiku", description: "Helper (Haiku)", model: "haiku")')
  expect(sent[0]).not.toContain('effort: "low"')
  expect(sent[0]).toContain('Give it the results of: Builder.')
  await pane.unmount()
})

test('the Agents pane names what each agent reached: CLIs, MCP servers, web', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('tool.call', () => ({ result: { text: 'ok' } }) as never)
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }) as never)
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true } as never)
  await $.agent.spawn({
    tool_use_id: 'tu1', prompt: 'Open an issue.', description: 'Triage', subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' }, parentModel: 'claude-opus-5-5', background: true, fork: false,
  } as never)
  for (const command of ['gh issue list', 'cd repo && gh pr view 1']) {
    await $.tool.call({ tool: 'Bash', command, tool_use_id: command, agentId: 'agent-1' } as never)
  }
  await $.tool.call({ tool: 'mcp__github__create_issue', tool_use_id: 'm1', agentId: 'agent-1' } as never)
  await $.tool.call({ tool: 'WebFetch', url: 'https://example.com', tool_use_id: 'w1', agentId: 'agent-1' } as never)

  const pane = await $.ui.mount(PANE('agent-tree'))
  expect(await texts(pane)).toContain('gh ×2, MCP github ×1, web ×1')
  const svg = String((await pane.findAll({ type: 'Svg' }))[0]!.props.source)
  expect(svg).toContain('⌁ gh · MCP github · web')
  await pane.unmount()
})

const architect = async ($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], bodyColumns = 96) => {
  mock.clock(on, { now: NOW })
  const store = new Map<string, unknown>()
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('store.get', (_, e) => ({ value: store.get((e as { key: string }).key) }) as never)
  on('store.set', (_, e) => {
    const { key, value } = e as { key: string; value: unknown }
    store.set(key, value)
    return { value: undefined } as never
  })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true } as never)
  const base = PANE('agent-architect')
  const pane = await $.ui.mount({ ...base, props: { ...base.props, bodyColumns } })
  const cardAt = async (id: string) => {
    const box = await pane.find({ key: `card-${id}`, in: 'canvas' })
    return [box?.props.left, box?.props.top]
  }
  return { pane, store, cardAt }
}

test('after New, a re-used card id is drawn where it is stored, not where an old drag left it', async ($, on) => {
  const { pane, cardAt } = await architect($, on)
  await pane.press({ key: 'add-builder' })
  expect(await cardAt('n1')).toEqual([0, 0])
  await pane.pointer({ type: 'down', x: 2, y: 1, button: 'left' })
  await pane.pointer({ type: 'move', x: 32, y: 7, button: 'left' })
  await pane.pointer({ type: 'up', x: 32, y: 7, button: 'left' })
  expect(await cardAt('n1')).toEqual([30, 6])
  await pane.press({ key: 'new' })
  await pane.press({ key: 'add-builder' })
  expect(await cardAt('n1')).toEqual([0, 0])
  await pane.unmount()
})

test('a click with no drag, then a hovering pointer, leaves the card where it was', async ($, on) => {
  const { pane, store, cardAt } = await architect($, on)
  await pane.press({ key: 'add-builder' })
  await pane.pointer({ type: 'down', x: 2, y: 1, button: 'left' })
  await pane.pointer({ type: 'up', x: 2, y: 1, button: 'left' })
  await pane.pointer({ type: 'move', x: 40, y: 10 }) // hover: no button held
  expect(await cardAt('n1')).toEqual([0, 0])
  // A drag whose up never arrives ends at the first move with no button held.
  await pane.pointer({ type: 'down', x: 2, y: 1, button: 'left' })
  await pane.pointer({ type: 'move', x: 12, y: 3, button: 'left' })
  await pane.pointer({ type: 'move', x: 50, y: 12 })
  await pane.pointer({ type: 'move', x: 60, y: 14 })
  const stored = (store.get('architect.current') as { nodes: Array<{ x: number; y: number }> }).nodes[0]!
  expect([stored.x, stored.y]).toEqual([48, 11])
  expect(await cardAt('n1')).toEqual([48, 11])
  await pane.unmount()
})

test('templates and new cards stay inside a narrow canvas', async ($, on) => {
  for (const make of Object.values(TEMPLATES)) {
    const d = fitWidth(make(), 56)
    for (const n of d.nodes) expect(n.x + CARD_W).toBeLessThanOrEqual(56)
  }
  const { pane, store } = await architect($, on, 60)
  await pane.select({ key: 'template', value: 'Build, test, review' })
  for (const n of (store.get('architect.current') as { nodes: Array<{ x: number }> }).nodes) expect(n.x + CARD_W).toBeLessThanOrEqual(56)
  for (let i = 0; i < 5; i++) await pane.press({ key: 'add-doer' })
  for (const n of (store.get('architect.current') as { nodes: Array<{ x: number }> }).nodes) expect(n.x + CARD_W).toBeLessThanOrEqual(56)
  await pane.unmount()
})
test('the header carries no buttons; token-weather launcher writes are routed to the right pane', async ($, on) => {
  mock.clock(on, { now: NOW })
  const opened: string[] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('ui.open', (_, e) => {
    opened.push((e as { id: string }).id)
    return { value: { isPlaced: true } } as never
  })
  await $.session.start({ cwd: '.', surface: 'desktop', isInteractive: true } as never)

  const pane = await $.ui.mount(PANE('agent-tree'))
  // minimize, Architect and Skill shelf moved to token-weather's band.
  const keys = (await pane.findAll({ type: 'Button' })).map(b => b.key)
  for (const gone of ['compact', 'open-architect', 'open-skill-shelf']) expect(keys).not.toContain(gone)
  await pane.unmount()

  // What token-weather's press writes, and writes it must ignore. (The test engine cannot raise another
  // plugin's state.set, so the hook's routing is checked here and the live open in a session.)
  expect(launchTarget({ plugin: 'token-weather', key: 'launch', value: { target: 'architect', n: 1 } })).toBe('architect')
  expect(launchTarget({ plugin: 'token-weather', key: 'launch', value: { target: 'agent-tree', n: 2 } })).toBe('agent-tree')
  expect(launchTarget({ plugin: 'token-weather', key: 'isHidden', value: true })).toBe(undefined)
  expect(launchTarget({ plugin: 'agent-tree', key: 'launch', value: { target: 'agent-tree' } })).toBe(undefined)
  expect(launchTarget({ plugin: 'token-weather', key: 'launch', value: null })).toBe(undefined)
  void opened
})

test('what a subagent did: files from Write/Edit/NotebookEdit and shell deletes, merged per path', () => {
  expect(fileOpsOf('Write', { file_path: 'C:/a/new.py' }, false)).toEqual([{ path: 'C:/a/new.py', op: 'created' }])
  expect(fileOpsOf('Write', { file_path: 'C:/a/old.py' }, true)).toEqual([{ path: 'C:/a/old.py', op: 'edited' }])
  expect(fileOpsOf('Edit', { file_path: 'x.ts' }, false)).toEqual([{ path: 'x.ts', op: 'edited' }])
  expect(fileOpsOf('NotebookEdit', { notebook_path: 'n.ipynb' }, false)).toEqual([{ path: 'n.ipynb', op: 'edited' }])
  expect(fileOpsOf('Read', { file_path: 'x.ts' }, true)).toEqual([])
  expect(deletedPaths('cd out && rm -rf build "my file.txt"; ls')).toEqual(['build', 'my file.txt'])
  expect(deletedPaths('Remove-Item -Recurse -Force C:/tmp/x')).toEqual(['C:/tmp/x'])
  expect(deletedPaths('del /q old.log | echo done')).toEqual(['old.log'])
  expect(deletedPaths('git rm --cached a.txt')).toEqual([]) // only plain delete commands, not git's
  expect(fileOpsOf('Bash', { command: 'rm a.txt' }, false)).toEqual([{ path: 'a.txt', op: 'deleted' }])

  const empty = { skills: [], files: [], output: '', outputChars: 0 }
  const w = addFiles(addFiles(empty, [{ path: 'a', op: 'created' }, { path: 'b', op: 'edited' }]), [{ path: 'a', op: 'edited' }, { path: 'b', op: 'deleted' }])
  expect(w.files).toEqual([{ path: 'a', op: 'created' }, { path: 'b', op: 'deleted' }])
})
