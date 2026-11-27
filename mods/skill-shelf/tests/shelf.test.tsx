import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { hashText, matchesQuery, parseSummaries, score, suggest, summaryPrompt, words } from '../hooks/shelf'
import { isDraftToMatch, launchTarget } from '../hooks/register'

const NOW = 10 * 86_400_000
const HOME = 'C:\\Users\\me'

const PANE = {
  plugin: 'skill-shelf',
  component: 'Pane',
  requestId: 'skill-shelf',
  props: {
    title: 'Skill shelf',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

// A fake machine: two user skill folders, one plugin with a skills/ folder, one agent file,
// and the engine's command and tool lists. Stands for the engine beneath the plugin.
function machine($: Engine, on: On, stored: Record<string, unknown> = {}, commands?: { name: string; description: string; source: string }[]) {
  const fills: string[] = []
  const files: Record<string, string> = {
    [`${HOME}\\.claude\\plugins\\installed_plugins.json`]: JSON.stringify({
      plugins: { 'superpowers@official': [{ installPath: 'C:\\cache\\superpowers\\7.0.0' }] },
    }),
    [`${HOME}\\.claude\\agents\\garde-fou.md`]: '---\nname: garde-fou\ndescription: Cautious independent reviewer\n---\nbody',
  }
  const dirs: Record<string, { name: string; kind: 'file' | 'dir' }[]> = {
    [`${HOME}\\.claude\\skills`]: [
      { name: 'focus', kind: 'dir' },
      { name: 'grilling', kind: 'dir' },
    ],
    'C:\\cache\\superpowers\\7.0.0\\skills': [
      { name: 'brainstorming', kind: 'dir' },
      { name: 'systematic-debugging', kind: 'dir' },
    ],
    [`${HOME}\\.claude\\agents`]: [{ name: 'garde-fou.md', kind: 'file' }],
  }
  let draft = ''
  mock.store(on, { since: NOW - 3 * 86_400_000, ...stored })
  mock.env(on, { USERPROFILE: HOME })
  mock.clock(on, { now: NOW })
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: { command: 'skill-shelf' } }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('fs.exists', (_, e) => ({ value: e.path in files || e.path in dirs }) as never)
  on('fs.list', (_, e) => ({ value: (dirs[e.path] ?? []).map(d => ({ ...d, size: 0, mtimeMs: 0, isLink: false })) }) as never)
  on('fs.read', (_, e) => ({ value: files[e.path] ?? '' }) as never)
  on('settings.read', () => ({
    value: { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node lint.js /grilling --quiet' }] }] } },
  }) as never)
  on('command.list', () => ({
    value: commands ?? [
      { name: 'focus', description: 'Focused way of working on a substantial task', source: 'user' },
      { name: 'grilling', description: 'Grill the user about a plan', source: 'user' },
      { name: 'superpowers:brainstorming', description: 'Explore ideas before creative work', source: 'plugin', plugin: 'superpowers' },
      { name: 'superpowers:systematic-debugging', description: 'Find the root cause of a failing test or bug', source: 'plugin', plugin: 'superpowers' },
      { name: 'review-pr', description: 'Review a pull request', source: 'user' },
      { name: 'compact', description: 'Compact the conversation', source: 'builtin' },
      { name: 'skill-shelf', description: 'this mod', source: 'plugin' },
    ],
  }) as never)
  on('tool.list', () => ({
    value: [
      { name: 'Bash', description: 'Run a shell command', mcp: false },
      { name: 'mcp__lab__plot_curve', description: 'Plot a dose response curve', mcp: true },
    ],
  }) as never)
  on('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }) as never)
  on('prompt.fill', (_, e) => {
    fills.push(e.text)
    return { isFilled: true, text: e.text } as never
  })
  on('prompt.submit', (_, e) => ({ text: e.text }) as never)
  on('tool.call', () => ({ result: {} }) as never)

  return {
    fills,
    setDraft: (text: string) => {
      draft = text
    },
    start: () => $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true }),
  }
}

const lines = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string; key: string | undefined }[]> }) =>
  (await ui.findAll({ type: 'Box' })).filter(b => b.key?.startsWith('line:')).map(b => ({ key: b.key!.slice(5), text: b.text.replace(/^Use(?=\/|[a-z])/, '') }))

const texts = async (ui: { findAll: (q: { type: string }) => Promise<{ text: string; key: string | undefined }[]> }) =>
  (await ui.findAll({ type: 'Button' })).map(b => ({ key: b.key, text: b.text }))

test('groups what is installed and flags what never fires on its own', async ($, on) => {
  const m = machine($, on, {
    // focus: run by hand only (still never auto). brainstorming: the model ran it.
    'use:slash:focus': { auto: 0, manual: 2, last: NOW - 2 * 86_400_000 },
    'use:slash:superpowers:brainstorming': { auto: 5, manual: 0, last: NOW - 3_600_000 },
  })
  await m.start()

  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const rows = await lines(ui)
    const byKey = (key: string) => rows.find(b => b.key === key)?.text
    // Desktop draws every Button as a chip: the name is text and a small Use button launches. The terminal's name is the control.
    const use = (await texts(ui)).find(b => b.key === 'slash:focus')?.text
    expect(use).toBe(surface === 'terminal' ? '/focus' : 'Use')

    // Skills come from folders (user and plugin); the rest of the slash list is commands.
    const headings = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    // Headings count what is shown: brainstorming is a skill the model fired, so it is off the default shelf.
    expect(headings).toContain('Skills 2')
    expect(headings).toContain('Commands 1')
    expect(headings).toContain('Agents 1')
    expect(headings).toContain('Tools 1')

    expect(byKey('slash:focus')).toBe('/focusyou 2× · last 2d ago')
    expect(byKey('slash:superpowers:systematic-debugging')).toBe('/superpowers:systematic-debugging')
    expect(byKey('slash:review-pr')).toBe('/review-pr')
    expect(byKey('agent:garde-fou')).toBe('garde-fou')
    expect(byKey('tool:mcp__lab__plot_curve')).toBe('mcp__lab__plot_curve')
    // Fired by the model, named in a settings hook, built in, or the mod itself: not on the default shelf.
    expect(byKey('slash:superpowers:brainstorming')).toBe(undefined)
    expect(byKey('slash:grilling')).toBe(undefined)
    expect(byKey('slash:compact')).toBe(undefined)
    expect(byKey('tool:Bash')).toBe(undefined)
    expect(byKey('slash:skill-shelf')).toBe(undefined)

    // Everything shows the auto ones too, with what they are.
    await ui.press({ key: 'all' })
    const everything = await lines(ui)
    const allHeadings = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(allHeadings).toContain('Skills 4')
    expect(allHeadings).toContain('Commands 2')
    expect(allHeadings).toContain('Tools 2')
    expect(everything.find(b => b.key === 'slash:superpowers:brainstorming')?.text).toBe(
      '/superpowers:brainstormingClaude 5× · last 1h ago',
    )
    expect(everything.find(b => b.key === 'slash:grilling')?.text).toBe('/grillingnamed in a hook')
    expect(everything.find(b => b.key === 'slash:compact')?.text).toBe('/compactmanual onlybuilt in')
    expect(everything.find(b => b.key === 'slash:focus')?.text).toBe('/focusmanual onlyyou 2× · last 2d ago')
    await ui.press({ key: 'all' })
    await ui.unmount()
  }
})

test('suggestions follow the draft as it is typed, stay up after Enter, and a press fills the prompt', async ($, on) => {
  const m = machine($, on)
  // The editor beneath: applies the splice and answers the box it shows.
  on('prompt.edit', (_, e) => {
    const text = e.text.slice(0, e.start) + e.inputText + e.text.slice(e.end)
    return { text, cursor: e.start + e.inputText.length } as never
  })
  const type = (text: string) =>
    ($.prompt as unknown as { edit: (e: object) => Promise<unknown> }).edit({ text: '', cursor: 0, start: 0, end: 0, inputText: text, origin: { kind: 'key' } } as never)
  await m.start()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Start typing/ }))?.text).toBe('Start typing a prompt: matching skills show here as you type.')
  expect(await ui.find({ key: 'match' })).toBe(undefined)

  // Typing, before any Enter, already matches.
  await type('the tests fail with a weird bug, help me debug it')
  const picks = (await texts(ui)).filter(b => b.key?.startsWith('pick:'))
  expect(picks.map(p => p.key)).toEqual(['pick:slash:superpowers:systematic-debugging'])
  // Descriptions wrap, the suggestions' included.
  expect((await ui.find({ type: 'Text', text: /root cause/ }))?.props.wrap).toBe('wrap')

  // Enter clears the box (an empty edit here): the suggestions stay for the prompt that runs.
  await $.prompt.submit({ text: 'the tests fail with a weird bug, help me debug it', origin: { kind: 'composer' } } as never)
  await type('')
  expect((await texts(ui)).filter(b => b.key?.startsWith('pick:')).map(p => p.key)).toEqual(['pick:slash:superpowers:systematic-debugging'])

  // A new draft takes over, and a press puts the slash command ahead of it.
  await type('please review this pull request')
  m.setDraft('please review this pull request')
  const now = (await texts(ui)).filter(b => b.key?.startsWith('pick:'))
  expect(now[0]?.key).toBe('pick:slash:review-pr')
  await ui.press({ key: 'pick:slash:review-pr' })
  expect(m.fills).toEqual(['/review-pr please review this pull request'])

  await type('quantum chromodynamics')
  expect((await ui.find({ type: 'Text', text: /No manual-only item matches/ }))?.text).toBe('No manual-only item matches "quantum chromodynamics".')
  await ui.unmount()
})

test('long descriptions show a model-written summary; short ones show as written', async ($, on) => {
  const long = 'Review a pull request. ' + 'Checks every changed file for correctness, style, tests and security, and posts comments inline where it finds a problem. '.repeat(3)
  const asked: string[] = []
  const m = machine($, on, {}, [{ name: 'review-pr', description: long, source: 'user' }, { name: 'focus', description: 'Focused way of working', source: 'user' }])
  on('model.complete', (_, e) => {
    const prompt = String((e as { prompt: unknown }).prompt)
    asked.push(prompt)
    const ids = [...prompt.matchAll(/"id":"([^"]+)"/g)].map(x => x[1]!)
    return { value: { isAnswered: true, text: JSON.stringify(Object.fromEntries(ids.map(id => [id, 'Reviews a pull request and comments on problems it finds.']))), usage: {} } } as never
  })
  await m.start()
  // The summaries run in the background after session.start; let them settle.
  await new Promise(r => (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout(() => r(undefined), 0))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const shown = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(shown).toContain('Reviews a pull request and comments on problems it finds.')
  expect(shown.some(t => t.startsWith('Review a pull request. Checks every'))).toBe(false)
  expect(shown).toContain('Focused way of working')
  // One call for the one long description (the short one is not sent).
  expect(asked).toHaveLength(1)
  expect(asked[0]).not.toContain('Focused way of working')
  await ui.unmount()
})

test('a summary reply is parsed defensively', () => {
  const ids = ['a', 'b', 'c']
  expect(parseSummaries('Here: {"a": " Does A.  Use for A. ", "b": 3, "zz": "x"} done', ids)).toEqual({ a: 'Does A. Use for A.' })
  expect(parseSummaries('not json', ids)).toEqual({})
  expect(parseSummaries(JSON.stringify({ c: 'x'.repeat(300) }), ids)).toEqual({})
  expect(hashText('same')).toBe(hashText('same'))
  expect(hashText('same')).not.toBe(hashText('same.'))
  expect(summaryPrompt([{ id: 'a', name: 'n', description: 'd' }])).toContain('at most 3 short lines')
})

test('a model call of a skill counts as auto and takes it off the shelf', async ($, on) => {
  const m = machine($, on)
  await m.start()
  await $.tool.call({ tool: 'Skill', skill: 'focus' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await texts(ui)).find(b => b.key === 'slash:focus')).toBe(undefined)
  await ui.press({ key: 'all' })
  expect((await lines(ui)).find(b => b.key === 'slash:focus')?.text).toBe('/focusClaude 1× · last just now')
  await ui.unmount()
})

test('the keyword match scores name parts above description words', () => {
  const item = { id: 'slash:code-review', kind: 'skill' as const, name: 'code-review', description: 'Reviews the current diff', source: 'builtin', isBuiltin: false }
  expect(score(item, words('review my diff'))).toBe(4)
  expect(suggest('hello there', [item], {}, new Set())).toEqual([])
  expect(suggest('review it', [item], { [item.id]: { auto: 1, manual: 0, last: 0 } }, new Set())).toEqual([])
})

test("token-weather's Skill shelf press is recognised, other writes are not", () => {
  expect(launchTarget({ plugin: 'token-weather', key: 'launch', value: { target: 'skill-shelf', n: 4 } })).toBe('skill-shelf')
  expect(launchTarget({ plugin: 'token-weather', key: 'last', value: null })).toBe(undefined)
  expect(launchTarget({ plugin: 'skill-shelf', key: 'launch', value: { target: 'skill-shelf' } })).toBe(undefined)
})

test('the search matches every word against the name or the description, any case', () => {
  const item = { id: 'slash:superpowers:systematic-debugging', kind: 'skill' as const, name: 'superpowers:systematic-debugging', description: 'Find the root cause of a failing test', source: 'plugin', isBuiltin: false }
  expect(matchesQuery(item, '')).toBe(true)
  expect(matchesQuery(item, '   ')).toBe(true)
  expect(matchesQuery(item, 'DEBUG')).toBe(true)
  expect(matchesQuery(item, '/superpowers:sys')).toBe(true)
  expect(matchesQuery(item, 'root failing')).toBe(true)
  expect(matchesQuery(item, 'debug pdf')).toBe(false)
})

test('the search box filters the lists as you type, points at hidden matches, and clears', async ($, on) => {
  const m = machine($, on, { 'use:slash:superpowers:brainstorming': { auto: 5, manual: 0, last: NOW - 3_600_000 } })
  await m.start()
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'search' })).not.toBe(undefined)
    expect(await ui.find({ key: 'clear' })).toBe(undefined)

    await ui.input({ key: 'search', text: 'debug', kind: 'change' })
    const rows = (await lines(ui)).map(r => r.key)
    expect(rows).toEqual(['slash:superpowers:systematic-debugging'])
    const headings = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    expect(headings).toContain('Skills 1')
    // Groups with no match are left out while searching.
    expect(headings.some(t => t.startsWith('Commands'))).toBe(false)

    // brainstorming is fired by the model, so off the manual-only shelf: the search says where it is.
    await ui.input({ key: 'search', text: 'brainstorm', kind: 'change' })
    expect((await lines(ui)).map(r => r.key)).toEqual([])
    expect((await ui.find({ type: 'Text', text: /more match/ }))?.text).toBe('No manual-only item matches "brainstorm". 1 more match in Show everything.')
    await ui.press({ key: 'all' })
    expect((await lines(ui)).map(r => r.key)).toEqual(['slash:superpowers:brainstorming'])
    await ui.press({ key: 'all' })

    await ui.press({ key: 'clear' })
    expect(await ui.find({ key: 'clear' })).toBe(undefined)
    expect((await lines(ui)).length).toBeGreaterThan(3)
    await ui.unmount()
  }
})

test('mobile, which has no text field, draws the shelf without a search box', async ($, on) => {
  const m = machine($, on)
  await m.start()
  const ui = await $.ui.mount({ ...PANE, surface: 'mobile' })
  expect(await ui.find({ key: 'search' })).toBe(undefined)
  expect((await lines(ui)).length).toBeGreaterThan(3)
  await ui.unmount()
})

test('an empty box or /skill-shelf never replaces what suggestions match', () => {
  expect(isDraftToMatch('debug this')).toBe(true)
  expect(isDraftToMatch('   ')).toBe(false)
  expect(isDraftToMatch('/skill-shelf')).toBe(false)
  expect(isDraftToMatch('/review-pr now')).toBe(false)
})
