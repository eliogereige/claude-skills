import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-03T12:00:00Z')

test('forecasts the 5-hour and weekly usage windows, not the context', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  let fiveHour = 18
  on('session.usage', () => ({ value: {
    startedAt: NOW,
    context: { window: 1_000_000, tokens: 50_000, percent: 5 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: fiveHour, resetsAt: new Date(NOW + 2 * 3_600_000 + 10 * 60_000).toISOString() },
      { kind: 'seven_day', percentUsed: 81, resetsAt: new Date(NOW + 3 * 24 * 3_600_000).toISOString() },
    ],
  } }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('turn.complete', (_, e) => ({ text: e.answer }) as never)
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true } as never)
  for (const used of [24, 31]) {
    fiveHour = used
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, turnId: `t${used}` })
  }

  const band = (surface: 'terminal' | 'desktop') => ({ plugin: 'token-weather', surface, component: 'AbovePrompt' as const,
    viewport: { columns: 120, rows: 40 },
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} } })

  // Terminal: a colored gauge line per window.
  const term = await $.ui.mount(band('terminal'))
  const text = (await term.findAll({ type: 'Text' })).map(t => t.text).join('')  expect(text).toContain('5-hour')
  expect(text).toContain('31%')
  expect(text).toContain('sunny')
  expect(text).toContain('resets in 2h10')
  expect(text).toContain('81%')
  expect(text).toContain('showers')
  expect(text).toContain('ahead of pace') // 81% used with 4 of 7 days gone
  expect(text).not.toContain('context')
  await term.unmount()

  // Desktop: one SVG of weather cards, animated icons, a gauge and a sparkline each.
  const desk = await $.ui.mount(band('desktop'))
  const svg = await desk.find({ type: 'Svg' })
  const source = String(svg?.props.source ?? '')  expect(String(svg?.props.alt)).toContain('5-hour sunny 31%, resets in 2h10')
  expect(String(svg?.props.alt)).toContain('Week showers 81%')
  expect(source).toContain('<animateTransform') // the sun's rays turn, the rain falls
  expect(source).toContain('31%')
  expect(source).toContain('ahead of pace')
  expect(source.length).toBeLessThan(131_072)
  await desk.unmount()
  void clock
})

test('three launcher buttons ask the other mods for their panes, without running a command', async ($, on) => {
  mock.clock(on, { now: NOW })
  const runs: string[] = []
  const writes: unknown[] = []
  const toasts: string[] = []
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 1, tokens: 0, percent: 0 }, rateLimits: [] } }) as never)
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  // architect's mod is "off" here: only two of the three commands exist.
  on('command.list', () => ({ value: [{ name: 'agent-tree', description: '', source: 'plugin' }, { name: 'skill-shelf', description: '', source: 'plugin' }] }) as never)
  on('command.run', (_, e) => {
    runs.push(e.command)
    return { text: '' } as never
  })
  on('state.set', (_, e) => {
    if ((e as { key: string }).key === 'launch') writes.push((e as { value: unknown }).value)
    return { value: { isSet: true, version: writes.length } } as never
  })
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined } as never
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true } as never)

  const mount = (surface: 'terminal' | 'desktop' | 'vscode', hasSurvey = false) => $.ui.mount({ plugin: 'token-weather', surface, component: 'AbovePrompt' as const,
    viewport: { columns: 120, rows: 40 },
    props: { hasSurvey, isCollapsed: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { offset: 0, bodyRows: 20 }, view: {} } })

  // No usage reading yet: the launcher still shows, on every surface.
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await mount(surface)
    const buttons = (await ui.findAll({ type: 'Button' })).map(b => [b.key, b.text])
    expect(buttons).toEqual([['open:agent-tree', 'Agents'], ['open:architect', 'Architect'], ['open:skill-shelf', 'Skill shelf']])
    await ui.unmount()
  }

  const ui = await mount('vscode')
  await ui.press({ key: 'open:agent-tree' })
  await ui.press({ key: 'open:skill-shelf' })
  // (This stand-in records writes without storing them, so `n` is not checked here.)
  expect(writes.map(w => (w as { target: string }).target)).toEqual(['agent-tree', 'skill-shelf'])
  // A mod that is off answers with a toast, not silence, and writes nothing.
  await ui.press({ key: 'open:architect' })
  expect(writes).toHaveLength(2)
  expect(toasts.join(' ')).toContain('Architect is not available')
  // No slash command runs, so nothing is echoed in the transcript.
  expect(runs).toEqual([])
  await ui.unmount()

  // A survey takes the band; the launcher steps aside.
  const survey = await mount('terminal', true)
  expect(await survey.findAll({ type: 'Button' })).toEqual([])
  await survey.unmount()
})
