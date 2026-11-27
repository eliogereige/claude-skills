import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { UsageReading, WindowReading } from '../types'

// A weather forecast of the plan's usage windows (the context window is not shown
// here): the 5-hour and the weekly window, each with its sky, a gauge, a sparkline
// of the last turns and when it resets. On the desktop the windows are cards side by
// side across the whole band, in one SVG (animated icon, gauge with a pace marker,
// sparkline), shown as a plain image so the band shows through (the interactive frame
// paints white); in the terminal, a colored gauge line.

const TURNS = 12
const BARS = '▁▂▃▄▅▆▇█'
const CELLS = 10
const FIVE_HOURS_MS = 5 * 3600 * 1000
const WEEK_MS = 7 * 24 * 3600 * 1000

const fiveHourHistory = atom({ plugin: 'token-weather', key: 'fiveHourHistory' } as const, [])
const weekHistory = atom({ plugin: 'token-weather', key: 'weekHistory' } as const, [])
const last = atom({ plugin: 'token-weather', key: 'last' } as const, null)
const isHidden = atom({ plugin: 'token-weather', key: 'isHidden' } as const, false)
const tick = atom({ plugin: 'token-weather', key: 'tick' } as const, 0) // redraws the band on a timer
const launch = atom({ plugin: 'token-weather', key: 'launch' } as const, null)

type Sky = 'clear' | 'sunny' | 'cloudy' | 'showers' | 'storm'

const forecast = (percent: number): { icon: string; sky: Sky; color: string } => {
  if (percent < 25) return { icon: '☀', sky: 'clear', color: '#3fb950' }
  if (percent < 50) return { icon: '🌤', sky: 'sunny', color: '#7cc142' }
  if (percent < 70) return { icon: '⛅', sky: 'cloudy', color: '#e3b341' }
  if (percent < 90) return { icon: '🌧', sky: 'showers', color: '#f0883e' }
  return { icon: '⛈', sky: 'storm', color: '#f85149' }
}

const resetText = (resetsAt: string | null, now: number) => {
  if (resetsAt === null) return ''
  const ms = Date.parse(resetsAt) - now
  if (!(ms > 0)) return 'resets now'
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  if (hours >= 24) {
    const day = new Date(Date.parse(resetsAt)).toLocaleDateString(undefined, { weekday: 'short' })
    return `resets ${day}`
  }

  return `resets in ${hours > 0 ? `${hours}h${String(minutes).padStart(2, '0')}` : `${minutes}m`}`
}

/** How far through the window the clock is, 0-100: where an even burn would stand now. */
const elapsedOf = (window: WindowReading, length: number, now: number) => {
  if (window.resetsAt === null) return null
  const left = Date.parse(window.resetsAt) - now

  return Math.min(100, Math.max(0, 100 * (1 - left / length)))
}

// Ahead of the week's clock by more than 10 points: burning too fast.
const paceText = (week: WindowReading, now: number) => {
  const elapsed = elapsedOf(week, WEEK_MS, now)
  if (elapsed === null) return ''
  if (week.percent > elapsed + 10) return '🔥 ahead of pace'
  if (week.percent < elapsed - 20) return '👍 under pace'

  return ''
}

async function readUsage($: EngineInterface): Promise<UsageReading | null> {
  const { rateLimits } = await $.session.usage()
  const pick = (kind: string): WindowReading | null => {
    const found = rateLimits.find(limit => limit.kind === kind)
    return found ? { percent: found.percentUsed, resetsAt: found.resetsAt ?? null } : null
  }
  const fiveHour = pick('five_hour')
  const week = pick('seven_day')
  if (fiveHour === null && week === null) return null

  return { fiveHour, week, at: await $.clock.now() }
}

async function refresh($: EngineInterface, isTurn: boolean) {
  const reading = await readUsage($)
  if (reading === null) return
  await update($, last, () => reading)
  if (isTurn) {
    if (reading.fiveHour) await update($, fiveHourHistory, list => [...list, reading.fiveHour!.percent].slice(-TURNS))
    if (reading.week) await update($, weekHistory, list => [...list, reading.week!.percent].slice(-TURNS))
  }
}

// ---------------------------------------------------------------- the desktop's cards

const FONT = 'font-family="system-ui, -apple-system, Segoe UI, sans-serif"'
const MUTED = '#8b949e'
const CARD_H = 44
const TOP_GAP = 10 // clear of Clawd's grass above
const SVG_H = CARD_H + TOP_GAP
const GAP = 8

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const SUN = '#f5b72b'
const CLOUD = '#c3ccd5'
const RAIN = '#58a6ff'

const sunAt = (cx: number, cy: number, r: number) => {
  const rays = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4
    const p = (d: number) => `${(cx + Math.cos(a) * d).toFixed(1)} ${(cy + Math.sin(a) * d).toFixed(1)}`
    return `M${p(r + 2)}L${p(r + 4.2)}`
  }).join('')
  return (
    `<g><path d="${rays}" stroke="${SUN}" stroke-width="1.8" stroke-linecap="round"/>` +
    `<animateTransform attributeName="transform" type="rotate" from="0 ${cx} ${cy}" to="360 ${cx} ${cy}" dur="14s" repeatCount="indefinite"/></g>` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${SUN}"/>`
  )
}

const cloudAt = (dx: number, dy: number, fill: string, drift: boolean) =>
  `<g transform="translate(${dx} ${dy})"><g fill="${fill}">` +
  '<circle cx="7" cy="9" r="4"/><circle cx="12" cy="6.5" r="5.2"/><circle cx="17" cy="9.5" r="3.6"/><rect x="3" y="9" width="17.5" height="4.2" rx="2.1"/>' +
  '</g>' +
  (drift ? '<animateTransform attributeName="transform" type="translate" additive="sum" values="0 0;1.2 0;0 0" dur="5s" repeatCount="indefinite"/>' : '') +
  '</g>'

/** A 28x28 weather icon, gently animated. */
const iconOf = (sky: Sky) => {
  switch (sky) {
    case 'clear':
      return sunAt(14, 14, 5.5)
    case 'sunny':
      return sunAt(11, 10, 4.5) + cloudAt(5, 11, CLOUD, true)
    case 'cloudy':
      return sunAt(9, 8, 3.6) + cloudAt(2, 8, CLOUD, true) + cloudAt(7, 12, '#aab4be', false)
    case 'showers': {
      const drops = [8, 13, 18]
        .map(
          (x, i) =>
            `<path d="M${x} 20v3.5" stroke="${RAIN}" stroke-width="1.8" stroke-linecap="round">` +
            `<animateTransform attributeName="transform" type="translate" values="0 -2;0 3" dur="0.9s" begin="${i * 0.3}s" repeatCount="indefinite"/>` +
            `<animate attributeName="opacity" values="1;0" dur="0.9s" begin="${i * 0.3}s" repeatCount="indefinite"/></path>`,
        )
        .join('')
      return cloudAt(2, 4, '#9aa5b1', true) + drops
    }
    case 'storm':
      return (
        cloudAt(2, 3, '#6e7681', false) +
        `<path d="M14 15l-3.5 6h3l-2 5.5 6-7.5h-3.2l2-4z" fill="${SUN}">` +
        '<animate attributeName="opacity" values="1;1;0.2;1;0.2;1" dur="2.4s" repeatCount="indefinite"/></path>'
      )
  }
}

const sparkPath = (values: readonly number[], x: number, y: number, w: number, h: number) => {
  const step = w / Math.max(1, values.length - 1)
  return values
    .map((v, i) => `${i === 0 ? 'M' : 'L'}${(x + i * step).toFixed(1)} ${(y + h - (Math.min(100, Math.max(0, v)) / 100) * h).toFixed(1)}`)
    .join('')
}

type Card = { title: string; window: WindowReading; history: number[]; elapsed: number | null; note: string }

/**
 * One card, filling its share of the row: drawn in a nested SVG `share` percent wide,
 * the icon and words anchored to its left edge, the gauge and percentage to its right
 * (in an SVG placed at 100%, drawing at negative x), so the cards stretch to any width.
 */
const cardSvg = (card: Card, index: number, count: number, now: number) => {
  const sky = forecast(card.window.percent)
  const percent = Math.round(card.window.percent)
  const sub = [resetText(card.window.resetsAt, now), card.note].filter(Boolean).join(' · ')
  const share = 100 / count
  // Half the gap on each inner edge.
  const left = index === 0 ? 0 : GAP / 2
  const right = index === count - 1 ? 0 : GAP / 2
  // The gauge, with a tick where an even burn would be by now; above the trend line when there is one.
  // Drawn at each of GAUGES' widths; the SVG's own media queries show the one that fits.
  const hasTrend = card.history.length > 1
  const gy = hasTrend ? 13 : 18.5
  const gauges = GAUGES.map(({ name, gw }) => {
    if (gw === 0) return ''
    const gx = -(right + 70 + gw)
    const fill = Math.max(percent > 0 ? 3 : 0, (Math.min(100, percent) / 100) * gw)
    const tick =
      card.elapsed === null
        ? ''
        : `<rect x="${(gx + (card.elapsed / 100) * gw - 0.75).toFixed(1)}" y="${gy - 2}" width="1.5" height="11" rx="0.75" fill="${MUTED}"/>`
    const spark = hasTrend
      ? `<path d="${sparkPath(card.history, gx, 26, gw, 10)}" fill="none" stroke="${sky.color}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" opacity="0.85"/>`
      : ''
    return (
      `<g class="${name}">` +
      `<rect x="${gx}" y="${gy}" width="${gw}" height="7" rx="3.5" fill="${MUTED}" fill-opacity="0.25"/>` +
      `<rect x="${gx}" y="${gy}" width="${fill.toFixed(1)}" height="7" rx="3.5" fill="${sky.color}"/>` +
      tick +
      spark +
      '</g>'
    )
  }).join('')

  return (
    `<svg x="${(index * share).toFixed(4)}%" y="${TOP_GAP}" width="${share.toFixed(4)}%" height="${CARD_H}" overflow="visible">` +
    `<rect x="${left + 0.5}" y="0.5" height="${CARD_H - 1}" rx="9" style="width: calc(100% - ${left + right + 1}px)" ` +
    `fill="${sky.color}" fill-opacity="0.09" stroke="${sky.color}" stroke-opacity="0.38"/>` +
    `<g transform="translate(${left + 8} 8)">${iconOf(sky.sky)}</g>` +
    `<text x="${left + 44}" y="19" font-size="12.5" font-weight="650" fill="${sky.color}">${escape(card.title)}<tspan font-weight="450" fill="${MUTED}"> · ${sky.sky}</tspan></text>` +
    `<text x="${left + 44}" y="34" font-size="10.5" fill="${MUTED}">${escape(sub)}</text>` +
    `<svg x="100%" y="0" width="1" height="${CARD_H}" overflow="visible">` +
    gauges +
    `<text x="${-(right + 14)}" y="28" font-size="17" font-weight="700" text-anchor="end" fill="${sky.color}">${percent}%</text>` +
    '</svg>' +
    '</svg>'
  )
}

// The gauge's width by the band's: room for the words on the left, the gauge and the
// percentage on the right; on a narrow band the gauge goes and the percentage stays.
const GAUGES = [
  { name: 'g-wide', gw: 120, from: 820 },
  { name: 'g-mid', gw: 64, from: 700 },
  { name: 'g-none', gw: 0, from: 0 },
]
const GAUGE_CSS =
  '<style>' +
  GAUGES.map(({ name }) => `.${name}{display:none}`).join('') +
  GAUGES.map(({ name, from }, i) => {
    const below = GAUGES[i - 1]?.from
    const query = [from > 0 ? `(min-width:${from}px)` : '', below !== undefined ? `(max-width:${below - 0.02}px)` : ''].filter(Boolean)
    return `@media ${query.join(' and ') || 'all'}{.${name}{display:inline}}`
  }).join('') +
  '</style>'

/** The cards side by side across the whole band. */
const cardsSvg = (cards: Card[], now: number) => {
  const body = cards.map((card, i) => cardSvg(card, i, cards.length, now)).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="${SVG_H}" ${FONT}>${GAUGE_CSS}${body}</svg>`
}

// ---------------------------------------------------------------- the terminal's line

const gauge = (percent: number) => {
  const full = Math.min(CELLS, Math.max(0, Math.round((percent / 100) * CELLS)))
  return { full: '━'.repeat(full), empty: '━'.repeat(CELLS - full) }
}

const sparkline = (values: readonly number[]) =>
  values.map(v => BARS[Math.min(7, Math.max(0, Math.round((v / 100) * 7)))]).join('')

// Shortcuts to other mods' panes. A press writes `launch`; the owning mod hooks that write
// (`state.set` on token-weather/launch) and opens its own pane. No slash command runs, so
// nothing is echoed in the transcript. A mod that is off (its command missing) gets a toast instead.
const LAUNCH = [
  { label: 'Agents', target: 'agent-tree' },
  { label: 'Architect', target: 'architect' },
  { label: 'Skill shelf', target: 'skill-shelf' },
] as const

async function open($: EngineInterface, l: (typeof LAUNCH)[number]): Promise<void> {
  const installed = (await $.command.list()).some(c => c.name === l.target)
  if (!installed) {
    await $.ui.toast(`${l.label} is not available: the mod behind /${l.target} is off or missing.`)
    return
  }
  await update($, launch, was => ({ target: l.target, n: (was?.n ?? 0) + 1 }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'weather',
      description: 'Show or hide the usage forecast (5-hour and weekly windows) above the prompt',
    })
    await update($, isHidden, () => false) // every session starts with the forecast shown
    await refresh($, false)
    // Keeps the reset countdowns current between turns.
    $.clock.every(60_000, () => void refresh($, false))
    $.clock.every(15_000, () => void update($, tick, n => n + 1))

    return next(e)
  })

  on('command.run', { command: 'weather' }, async $ => {
    let isNowHidden = false
    await update($, isHidden, was => (isNowHidden = !was))

    return { text: isNowHidden ? 'Token Weather hidden.' : 'Token Weather shown.' }
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await refresh($, true)

    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // Whatever else draws in the band (Clawd, a survey) stays, above the forecast.
    const below = await next(e)
    if (e.props.hasSurvey) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    // Always there, forecast hidden or not: one press opens another mod's pane instead of hunting for its tab.
    const launcher = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {LAUNCH.map(l => (
          <Button key={`open:${l.target}`} onPress={() => void open($, l).catch(err => $.ui.toast(`Could not open ${l.label}: ${err instanceof Error ? err.message : String(err)}`))}>
            {l.label}
          </Button>
        ))}
      </Box>
    )

    const reading = (await read($, isHidden)) ? null : await read($, last)
    if (reading === null) {
      return (
        <Box flexDirection="column">
          {below}
          {launcher}
        </Box>
      )
    }

    const now = await $.clock.now()
    const cards: Card[] = []
    if (reading.fiveHour) {
      cards.push({
        title: '5-hour',
        window: reading.fiveHour,
        history: await read($, fiveHourHistory),
        elapsed: elapsedOf(reading.fiveHour, FIVE_HOURS_MS, now),
        note: '',
      })
    }
    if (reading.week) {
      cards.push({
        title: 'Week',
        window: reading.week,
        history: await read($, weekHistory),
        elapsed: elapsedOf(reading.week, WEEK_MS, now),
        note: paceText(reading.week, now),
      })
    }
    const summary = cards
      .map(c => `${c.title} ${forecast(c.window.percent).sky} ${Math.round(c.window.percent)}%, ${resetText(c.window.resetsAt, now)}`)
      .join('; ')

    if (e.surface !== 'terminal') {
      // Full width, no Hide button: /weather shows or hides it.
      const { Svg } = $.ui.resolve(e)
      return (
        <Box flexDirection="column">
          {below}
          {/* The gap keeps the launcher clear of the cards: the desktop app drew the row over their bottom edge. */}
          <Box flexDirection="column" gap={1}>
            <Svg source={cardsSvg(cards, now)} alt={`Usage forecast: ${summary}`} height={SVG_H} />
            {launcher}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="row" flexWrap="wrap" columnGap={3}>
          {cards.map(card => {
            const sky = forecast(card.window.percent)
            const bar = gauge(card.window.percent)
            return (
              <Box flexDirection="row">
                <Text color={sky.color}>{sky.icon} </Text>
                <Text bold color={sky.color}>{card.title} </Text>
                <Text color={sky.color}>{bar.full}</Text>
                <Text dimColor>{bar.empty}</Text>
                <Text bold color={sky.color}> {Math.round(card.window.percent)}%</Text>
                <Text dimColor> {sky.sky}</Text>
                {card.history.length > 1 && <Text color={sky.color}> {sparkline(card.history)}</Text>}
                <Text dimColor>
                  {' · '}
                  {[resetText(card.window.resetsAt, now), card.note].filter(Boolean).join(' · ')}
                </Text>
              </Box>
            )
          })}
          <Button key="hide" label="Hide" onPress={() => update($, isHidden, () => true)} />
        </Box>
        {launcher}
      </Box>
    )
})
}
