import { atom, read, update } from 'claude-code'
import type { CoreEngineInterface, Register, RenderChildren, Timer } from 'claude-code'

import type { AgentWork, AgentNode, AgentStatus, FastState, ResourceCounts } from '../types'
import { ARCH, register as registerArchitect, startArchitect } from './architect'

const PANE = 'agent-tree'
const ROOT_ID = 'main'
const MAX_AGENTS = 200
const PROMPT_CAP = 4000
// Elapsed times of running subagents refresh at this pace between events;
// every tool call or model request redraws anyway.
const TICK_MS = 5000
// The timeline draws this many rows at most; the rest are named as a count.
const SVG_ROWS = 60
// Bump when AgentNode changes: values the old code stored then read as absent.
const SHAPE = { shape: 'agent-node-v4' } as const
// An ETA needs this many past runs of the same kind; fewer shows "ETA ?", not a guess.
const ETA_MIN_RUNS = 3
const HISTORY_CAP = 50
const STORE_HISTORY = 'runHistory'

const newNode = (id: string, parentId: string | null): AgentNode => ({
  id,
  parentId,
  name: '',
  kind: '',
  model: '',
  effort: '',
  effortFrom: '',
  summary: '',
  prompt: '',
  promptChars: 0,
  status: 'done',
  startedAt: 0,
  endedAt: null,
  activeMs: 0,
  runAt: 0,
  etaKey: '',
  ctx: 0,
  out: 0,
  turnOut: 0,
  tools: 0,
})

const newRoot = (): AgentNode => ({ ...newNode(ROOT_ID, null), name: 'This session', kind: 'main', etaKey: ROOT_ID })

const agents = atom({ plugin: 'agent-tree', key: 'agents' } as const, [], SHAPE)
const root = atom({ plugin: 'agent-tree', key: 'root' } as const, newRoot(), SHAPE)
const now = atom({ plugin: 'agent-tree', key: 'now' } as const, 0)
const costUsd = atom({ plugin: 'agent-tree', key: 'costUsd' } as const, null)
const collapsed = atom({ plugin: 'agent-tree', key: 'collapsed' } as const, [])
const expanded = atom({ plugin: 'agent-tree', key: 'expanded' } as const, [])
const runHistory = atom({ plugin: 'agent-tree', key: 'runHistory' } as const, {})

// "claude-sonnet-5-5" -> "Sonnet 5.5"; anything else is shown as the API named it.
export const prettyModel = (id: string): string => {
  const m = /claude-(opus|sonnet|haiku|fable)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/i.exec(id)
  if (!m) return id
  const family = m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase()
  return `${family} ${m[2]}${m[3] ? '.' + m[3] : ''}`
}

export const fmtDuration = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

// Time an agent has actually spent: its finished runs plus the one under way.
export const timeSpent = (n: AgentNode, t: number): number =>
  n.activeMs + (n.status === 'running' && n.runAt ? Math.max(0, t - n.runAt) : 0)

// A run begins (no change if one is under way) or ends (its time banked).
const beginRun = (a: AgentNode, t: number): AgentNode =>
  a.status === 'running' && a.runAt ? a : { ...a, status: 'running', endedAt: null, runAt: t }
const bankRun = (a: AgentNode, t: number): AgentNode => ({ ...a, activeMs: timeSpent(a, t), runAt: 0 })

// A map card's time. A running agent shows whole minutes, so the drawing
// changes at most once a minute; the list below keeps the live seconds.
export const cardTime = (n: AgentNode, t: number): string => {
  if (!n.startedAt) return ''
  const ms = timeSpent(n, t)
  if (n.status !== 'running') return fmtDuration(ms)
  const m = Math.floor(ms / 60_000)
  return m < 1 ? '<1m' : m < 60 ? `${m}m+` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m+`
}

// Time left in this run, an estimate from past runs of the same kind: the median
// of those that ran longer than this one has so far, less its elapsed time. Runs
// are long-tailed, so an agent past the usual length gets a longer estimate, not
// zero. null: too few runs to say. 'over': longer than every run on record.
export const etaMs = (samples: readonly number[], elapsed: number): number | 'over' | null => {
  if (samples.length < ETA_MIN_RUNS) return null
  const longer = samples.filter(s => s > elapsed).sort((a, b) => a - b)
  if (longer.length === 0) return 'over'
  const mid = longer.length / 2
  const median = longer.length % 2 ? longer[Math.floor(mid)]! : (longer[mid - 1]! + longer[mid]!) / 2
  return median - elapsed
}

// Minutes only: an estimate should not read more exact than it is.
export const etaLabel = (samples: readonly number[], elapsed: number): string => {
  const left = etaMs(samples, elapsed)
  if (left === null) return 'ETA ?'
  if (left === 'over') return 'past usual'
  const m = Math.ceil(left / 60_000)
  if (left < 60_000) return '<1m left'
  return m < 60 ? `~${m}m left` : `~${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m left`
}

const runElapsed = (n: AgentNode, t: number): number => (n.runAt ? Math.max(0, t - n.runAt) : 0)

export const fmtTokens = (n: number): string =>
  n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1_000_000).toFixed(1)}M`

export const fmtEffort = (effort: string | number | undefined): string =>
  effort === undefined ? 'none' : typeof effort === 'number' ? `${fmtTokens(effort)} budget` : effort

// One readable line out of a prompt: its first sentence, markdown stripped,
// cut at a word boundary.
export const summarize = (text: string, max = 90): string => {
  // Underscores stay: snake_case names (compute_re.py, case_A) must read right.
  const flat = text.replace(/[`*#>|]+/g, '').replace(/\s+/g, ' ').trim()
  const first = /^(.{16,}?[.!?])(?:\s|$)/.exec(flat)?.[1] ?? flat
  if (first.length <= max) return first
  const cut = first.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '') + '…'
}

// A prompt that opens with a markup tag (`<task-notification>`, `<system-reminder>`)
// came from the harness, not the person: the root keeps the last real task.
export const isHarnessMessage = (text: string): boolean => /^\s*<[a-z][\w-]*[\s>]/i.test(text)

const capPrompt = (text: string): string => (text.length > PROMPT_CAP ? text.slice(0, PROMPT_CAP) : text)

export const effortLabel = (n: AgentNode): string =>
  n.effort === '' ? 'effort ?' : n.effort === 'none' ? 'no effort' : n.effortFrom === 'asked' ? `${n.effort} (asked)` : n.effort

const statusOf = (reason: string): AgentStatus =>
  reason === 'answer' ? 'done' : reason === 'aborted' ? 'stopped' : 'failed'

const GLYPH: Record<AgentStatus, { glyph: string; label: string; color: string }> = {
  running: { glyph: '●', label: 'running', color: 'claude' },
  done: { glyph: '✓', label: 'done', color: 'success' },
  stopped: { glyph: '■', label: 'stopped', color: 'inactive' },
  failed: { glyph: '✕', label: 'failed', color: 'error' },
}

// Siblings whose runs overlap form one wave: they ran in parallel. Waves
// follow one another in time, sequentially.
export const waves = (kids: readonly AgentNode[]): AgentNode[][] => {
  const out: AgentNode[][] = []
  let end = -Infinity
  for (const k of [...kids].sort((a, b) => a.startedAt - b.startedAt)) {
    const kEnd = k.endedAt ?? Infinity
    const last = out[out.length - 1]
    if (last && k.startedAt < end) {
      last.push(k)
      end = Math.max(end, kEnd)
    } else {
      out.push([k])
      end = kEnd
    }
  }
  return out
}

type Row = {
  node: AgentNode
  depth: number
  parentIdx: number
  /** Tree glyphs before the row's first line, and before its other lines. */
  lead: string
  cont: string
  /** Size of the parallel wave this row opens (0 when it opens none, or runs alone). */
  waveOpens: number
  waveRunning: number
}

// Depth-first rows in start order, the folded subtrees left out.
export const layout = (r: AgentNode, list: readonly AgentNode[], folded: ReadonlySet<string>): Row[] => {
  const children = new Map<string, AgentNode[]>()
  for (const a of list) {
    const p = a.parentId ?? ROOT_ID
    children.set(p, [...(children.get(p) ?? []), a])
  }
  const rows: Row[] = []
  const walk = (node: AgentNode, depth: number, parentIdx: number, lead: string, cont: string, wave: AgentNode[] | null) => {
    const isWaveHead = wave !== null && wave.length > 1 && wave[0] === node
    rows.push({
      node,
      depth,
      parentIdx,
      lead,
      cont,
      waveOpens: isWaveHead ? wave.length : 0,
      waveRunning: isWaveHead ? wave.filter(w => w.status === 'running').length : 0,
    })
    if (folded.has(node.id)) return
    const idx = rows.length - 1
    const groups = waves(children.get(node.id) ?? [])
    const flat = groups.flat()
    flat.forEach((kid, i) => {
      const isLast = i === flat.length - 1
      const group = groups.find(g => g.includes(kid))!
      walk(kid, depth + 1, idx, cont + (isLast ? '└─ ' : '├─ '), cont + (isLast ? '   ' : '│  '), group)
    })
  }
  walk(r, 0, -1, '', '', null)
  return rows
}

export const childCount = (id: string, list: readonly AgentNode[]): number =>
  list.reduce((n, a) => n + (a.parentId === id ? 1 : 0), 0)

// XML-safe text: the four specials escaped, and the characters XML 1.0
// forbids (C0 controls but tab, LF, CR; lone surrogates) dropped, so one
// pasted ANSI escape cannot void the whole map.
const esc = (s: string): string =>
  s
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

// The engine refuses an Svg source past 131072 characters; the map keeps
// this much below it, and the hover prompts share what the cards leave.
export const SVG_BUDGET = 120_000

const STATUS_GLYPH: Record<AgentStatus, string> = { running: '●', done: '✓', stopped: '■', failed: '✕' }

const clip = (s: string, room: number): string => (s.length > room ? s.slice(0, Math.max(1, room - 1)) + '…' : s)

// Where a card's hover prompt goes once the drawing's size is known; esc
// strips this control character from every text, so it marks nothing else.
const TIP = '\u0001'

// The workflow map: one card per agent, nested by who started whom, a curved
// spawn edge from parent to child (dashes flowing while the child runs), and
// a tinted band around siblings that ran in parallel. Only what changes the
// picture goes in (no ticking seconds, no counts), so the source, and the frame
// the surface draws it in, stay the same between most redraws.
export const graphSvg = (
  rows: readonly Row[],
  W = 460,
  used: ResourceCounts = {},
  rootBadge = '',
  t = 0,
  history: Readonly<Record<string, number[]>> = {},
): { source: string; width: number; height: number } => {
  const drawn = rows.slice(0, SVG_ROWS)
  const hidden = rows.length - drawn.length
  const GAP = 12
  const TOP = 6
  const INDENT = 22
  // What each agent reached outside itself, by name in first-use order: the
  // counts live in the list below, so a call adds nothing here until a new
  // resource appears.
  const chipsOf = drawn.map(r => Object.keys(used[r.node.id] ?? {}))
  const heightOf = drawn.map((_, i) => (chipsOf[i]!.length > 0 ? 74 : 56))
  const tops: number[] = []
  drawn.forEach((_, i) => tops.push(i === 0 ? TOP : tops[i - 1]! + heightOf[i - 1]! + GAP))
  const yOf = (i: number) => (i < drawn.length ? tops[i]! : (tops[i - 1] ?? TOP) + (heightOf[i - 1] ?? 0) + GAP)
  const xOf = (depth: number) => 6 + depth * INDENT
  // Last row of each row's subtree, so a parallel band covers its members' children.
  const end = drawn.map((_, i) => i)
  for (let i = drawn.length - 1; i >= 0; i--) {
    const p = drawn[i]!.parentIdx
    if (p >= 0 && p < drawn.length) end[p] = Math.max(end[p]!, end[i]!)
  }
  const H = yOf(drawn.length) - GAP + (hidden > 0 ? 22 : 6)

  const bands: string[] = []
  const edges: string[] = []
  const cards: string[] = []
  drawn.forEach((row, i) => {
    if (row.waveOpens > 1) {
      // The wave's members are this row's next siblings; the band ends after the last one's subtree.
      let last = i
      let seen = 0
      for (let j = i; j < drawn.length && seen < row.waveOpens; j++) {
        if (drawn[j]!.parentIdx === row.parentIdx) {
          seen++
          last = end[j]!
        }
      }
      const x = xOf(row.depth) - 4
      const y = yOf(i) - 5
      const h = yOf(last) + heightOf[last]! + 5 - y
      bands.push(
        `<rect class="band" x="${x}" y="${y}" width="${W - x - 2}" height="${h}" rx="10"/>`,
        `<text class="bandl" x="${W - 10}" y="${y + h - 6}" text-anchor="end">∥ parallel ×${row.waveOpens}</text>`,
      )
    }
  })

  drawn.forEach((row, i) => {
    const n = row.node
    const x = xOf(row.depth)
    const y = yOf(i)
    const w = W - x - 6
    const CARD = heightOf[i]!
    if (row.parentIdx >= 0 && row.parentIdx < drawn.length) {
      const px = xOf(drawn[row.parentIdx]!.depth) + 12
      const py = yOf(row.parentIdx) + heightOf[row.parentIdx]!
      const cy = y + 28
      const cls = n.status === 'running' ? 'edge flow' : n.status === 'failed' ? 'edge fail' : 'edge'
      edges.push(`<path class="${cls}" d="M${px} ${py} V${cy - 10} Q${px} ${cy} ${px + 10} ${cy} H${x}"/>`)
    }
    const pill = `${n.model || 'model ?'} · ${effortLabel(n)}${row.depth === 0 && rootBadge ? ` · ${rootBadge}` : ''}`
    const pillW = Math.round(pill.length * 6.6 + 16)
    const nameRoom = Math.floor((w - pillW - 36) / 8)
    // The ETA from whole minutes of the run, so the card still changes once a minute at most.
    const samples = history[n.etaKey] ?? []
    const eta =
      n.status === 'running' && samples.length >= ETA_MIN_RUNS
        ? etaLabel(samples, Math.floor(runElapsed(n, t) / 60_000) * 60_000)
        : ''
    const spent = [cardTime(n, t), eta].filter(Boolean).join(' · ')
    const sumRoom = Math.floor((w - 26 - (spent ? spent.length * 7 + 10 : 0)) / 6.9)
    cards.push(
      `<g class="card ${n.status}${row.depth === 0 ? ' root' : ''}">${TIP}${i}${TIP}`,
      `<rect class="box" x="${x}" y="${y}" width="${w}" height="${CARD}" rx="8"/>`,
      `<rect class="strip" x="${x}" y="${y}" width="4" height="${CARD}" rx="2"/>`,
      `<text class="glyph" x="${x + 13}" y="${y + 23}">${STATUS_GLYPH[n.status]}</text>`,
      `<text class="name" x="${x + 28}" y="${y + 23}">${esc(clip(n.name, nameRoom))}</text>`,
      `<rect class="pill" x="${x + w - pillW - 8}" y="${y + 9}" width="${pillW}" height="20" rx="10"/>`,
      `<text class="pillt" x="${x + w - 8 - pillW / 2}" y="${y + 23}" text-anchor="middle">${esc(pill)}</text>`,
      `<text class="sum" x="${x + 13}" y="${y + 45}">${esc(clip(n.summary, sumRoom))}</text>`,
      spent ? `<text class="time" x="${x + w - 8}" y="${y + 45}" text-anchor="end">${esc(spent)}</text>` : '',
      chipsOf[i]!.length > 0 ? `<text class="res" x="${x + 13}" y="${y + 63}">⌁ ${esc(clip(chipsOf[i]!.join(' · '), sumRoom))}</text>` : '',
      `</g>`,
    )
  })
  if (hidden > 0) cards.push(`<text class="sum" x="8" y="${H - 6}">+${hidden} more agents, listed below</text>`)

  const css =
    `:root{--fg:#2b2a27;--mut:#6f6d66;--box:rgba(120,118,110,.07);--line:rgba(120,118,110,.38);--band:rgba(217,119,87,.07);--acc:#C2603F}` +
    `@media (prefers-color-scheme:dark){:root{--fg:#ecebe6;--mut:#a4a29a;--box:rgba(255,255,255,.045);--line:rgba(255,255,255,.22);--band:rgba(217,119,87,.10);--acc:#E8946F}}` +
    `text{font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}` +
    `.box{fill:var(--box);stroke:var(--line)}.root .box{stroke-width:1.2}` +
    `.running .box{stroke:#D97757;animation:pulse 1.8s ease-in-out infinite}.failed .box{stroke:#C8553D}` +
    `.strip{fill:var(--line)}.running .strip{fill:#D97757}.done .strip{fill:#4E9A6A}.failed .strip{fill:#C8553D}.stopped .strip{fill:#9C9A93}` +
    `.glyph{font-size:12px;fill:var(--mut)}.running .glyph{fill:#D97757}.done .glyph{fill:#4E9A6A}.failed .glyph{fill:#C8553D}` +
    `.name{font-size:14px;font-weight:600;fill:var(--fg)}.stopped .name{fill:var(--mut)}` +
    `.time{font-size:12px;font-weight:600;fill:var(--mut);font-variant-numeric:tabular-nums}.running .time{fill:#D97757}` +
    `.sum{font-size:12.5px;fill:var(--mut)}.res{font-size:11.5px;font-weight:500;fill:#5B8DD6}` +
    `.pill{fill:none;stroke:var(--acc);stroke-opacity:.45}.pillt{font-size:11.5px;font-weight:500;fill:var(--acc)}` +
    `.edge{fill:none;stroke:var(--line);stroke-width:1.4}.edge.fail{stroke:#C8553D;stroke-opacity:.6}` +
    `.edge.flow{stroke:#D97757;stroke-dasharray:4 4;animation:flow .9s linear infinite}` +
    `.band{fill:var(--band);stroke:#D97757;stroke-opacity:.25;stroke-dasharray:3 3}.bandl{font-size:10.5px;font-weight:600;letter-spacing:.04em;fill:var(--acc)}` +
    `.card:hover .box{stroke:var(--acc);stroke-width:1.5}` +
    `@keyframes flow{to{stroke-dashoffset:-8}}@keyframes pulse{50%{stroke-opacity:.35}}` +
    `@media (prefers-reduced-motion:reduce){.edge.flow,.running .box{animation:none}}`
  const skeleton =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<style>${css}</style>` +
    bands.join('') +
    edges.join('') +
    cards.join('') +
    `</svg>`
  // The hover prompts get what the drawing leaves of the budget, shared out
  // evenly and measured after escaping; a share too small for a useful line
  // draws no tooltip rather than a stub.
  const share = Math.min(1500, Math.floor((SVG_BUDGET - skeleton.length) / Math.max(1, drawn.length)) - 16)
  const tipOf = (i: number): string => {
    if (share < 60) return ''
    const n = drawn[i]!.node
    let raw = (n.prompt || n.summary).slice(0, share)
    let text = esc(raw)
    while (text.length > share) {
      raw = raw.slice(0, Math.floor(raw.length * 0.8))
      text = esc(raw)
    }
    return text ? `<title>${text}</title>` : ''
  }
  const source = skeleton.replace(new RegExp(`${TIP}(\\d+)${TIP}`, 'g'), (_, i: string) => tipOf(Number(i)))
  return { source, width: W, height: H }
}

const resources = atom({ plugin: 'agent-tree', key: 'resources' } as const, {})

// The program a shell command runs first, past `cd`/`export` steps and env
// assignments: `cd app && FOO=1 npm test` is `npm`.
export const programOf = (command: string): string | null => {
  for (const part of command.split(/&&|\|\||[;|\n]/)) {
    const words = part.trim().split(/\s+/).filter(w => w && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) && w !== 'sudo')
    const first = words[0]?.replace(/^["']|["']$/g, '')
    if (!first || ['cd', 'export', 'set', 'source', '.', 'Set-Location'].includes(first)) continue
    return first.split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase()
  }
  return null
}

// What a tool call reaches outside the agent: an MCP server, a CLI program,
// the web, the files; null for the calls that start or talk to agents.
export const resourceOf = (tool: string, input: Readonly<Record<string, unknown>>): string | null => {
  if (tool.startsWith('mcp__')) return `MCP ${tool.split('__')[1] ?? '?'}`
  if (tool === 'Bash' || tool === 'PowerShell') return programOf(String(input.command ?? ''))
  if (tool === 'WebFetch' || tool === 'WebSearch') return 'web'
  if (['Read', 'Write', 'Edit', 'Grep', 'Glob', 'NotebookEdit'].includes(tool)) return 'files'
  // The session's own machinery (agents, tasks, questions, skills) reaches nothing outside.
  if (/^(Agent|SendMessage|Task\w*|TodoWrite|AskUserQuestion|Skill|ToolSearch|ExitPlanMode|EnterPlanMode|ScheduleWakeup|Monitor)$/.test(tool)) return null
  return tool
}
const MAX_RESOURCES = 24
const errors = atom({ plugin: 'agent-tree', key: 'errors' } as const, { count: 0, last: '' })

// Fast mode, as the desktop app reports it: no engine event says whether it is
// on, so the main loop's turns ask the app's own session tool (get_session on
// "self", whose `fastMode` is on, off or cooldown and, when something blocks
// it, why). Where that tool is missing or the call is refused (the terminal,
// other surfaces, a denied permission) the state is `unknown` and the session
// stops asking: never a guess.
const GET_SESSION = 'mcp__ccd_session_mgmt__get_session'
const FAST_POLL_MS = 15_000
const fast = atom({ plugin: 'agent-tree', key: 'fast' } as const, { state: 'unknown', why: 'not asked yet', checkedAt: 0 })
let fastUnavailable = false
let fastAskedAt = -Infinity

// `fastMode` out of get_session's text: a JSON body (a bare state, or an
// object with its state and the reason), else a `fastMode: <state>` line.
export const parseFast = (text: string): { state: FastState; why: string } => {
  const stateOf = (v: unknown): FastState | null =>
    v === 'on' || v === 'off' || v === 'cooldown' ? v : v === true ? 'on' : v === false ? 'off' : null
  try {
    const body = JSON.parse(text) as Record<string, unknown>
    const f = body?.fastMode
    if (f === undefined) return { state: 'unknown', why: 'the app has not reported fast mode for this session yet' }
    if (typeof f === 'object' && f !== null) {
      const o = f as Record<string, unknown>
      const s = stateOf(o.state ?? o.status ?? o.mode)
      const why = typeof o.reason === 'string' ? o.reason : typeof o.why === 'string' ? o.why : ''
      if (s) return { state: s, why }
    }
    const s = stateOf(f)
    if (s) return { state: s, why: '' }
    return { state: 'unknown', why: `unrecognised fastMode value: ${JSON.stringify(f).slice(0, 80)}` }
  } catch {
    const m = /fastMode"?\s*[:=]\s*"?(on|off|cooldown)\b/i.exec(text)
    if (m) return { state: m[1]!.toLowerCase() as FastState, why: '' }
    return { state: 'unknown', why: 'get_session answered without a readable fastMode' }
  }
}

async function pollFast($: Pick<CoreEngineInterface, 'tool' | 'state' | 'clock'>): Promise<void> {
  const t = await $.clock.now()
  if (fastUnavailable || t - fastAskedAt < FAST_POLL_MS) return
  fastAskedAt = t
  const give = (state: FastState, why: string) => update($, fast, () => ({ state, why, checkedAt: t }))
  try {
    const r = await $.tool.call({ tool: GET_SESSION, session_id: 'self' })
    if (r.deny !== undefined) {
      fastUnavailable = true
      await give('unknown', `the desktop app's session tool was refused: ${r.deny}`)
    } else if (r.isError) {
      fastUnavailable = true
      await give('unknown', `the desktop app's session tool failed: ${String(r.text ?? '').slice(0, 120)}`)
    } else {
      const p = parseFast(String(r.text ?? ''))
      await give(p.state, p.why)
    }
  } catch (err) {
    // No such tool here (the terminal, or the app's tools not connected).
    fastUnavailable = true
    await give('unknown', `no desktop app session tool here (${err instanceof Error ? err.message : String(err)})`.slice(0, 200))
  }
}

// Bookkeeping never blocks the session, but a failure is counted and shown,
// never swallowed: the pane's header says the tree may be incomplete.
async function noteError($: Pick<CoreEngineInterface, 'state'>, where: string, err: unknown): Promise<void> {
  const last = `${where}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200)
  try {
    await update($, errors, x => ({ count: x.count + 1, last }))
  } catch {
    // The error store itself failed: nothing left to record it in.
  }
}

let ticker: Timer | null = null
// The Agent call's own arguments, by tool_use_id, until its spawn reads them.
const asked = new Map<string, { effort?: string }>()

// A clock only while a subagent runs, so its elapsed time stays live; the
// main loop's own events redraw it often enough.
async function syncTicker($: Pick<CoreEngineInterface, 'state' | 'clock'>): Promise<void> {
  const isLive = (await read($, agents)).some(a => a.status === 'running')
  if (isLive && !ticker) {
    ticker = $.clock.every(TICK_MS, () =>
      void $.clock
        .now()
        .then(t => update($, now, () => t))
        .catch(err => noteError($, 'ticker', err)),
    )
  } else if (!isLive && ticker) {
    ticker.cancel()
    ticker = null
    const t = await $.clock.now()
    await update($, now, () => t)
  }
}

const work = atom({ plugin: 'agent-tree', key: 'work' } as const, {} as Record<string, AgentWork>)
const MAX_FILES = 40
export const OUTPUT_CAP = 2000
const emptyWork = (): AgentWork => ({ skills: [], files: [], output: '', outputChars: 0 })

/** Paths a shell command deletes, best effort: rm / del / erase / rmdir / Remove-Item / unlink with plain path arguments. */
export function deletedPaths(command: string): string[] {
  const out: string[] = []
  for (const part of command.split(/&&|\|\||;|\|/)) {
    const words = part.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? []
    if (!/^(rm|del|erase|rmdir|rd|unlink|Remove-Item|ri)$/i.test(words[0] ?? '')) continue
    for (const w of words.slice(1)) {
      if (w.startsWith('-') || /^\/[a-z]$/i.test(w)) continue // flags: -rf, -Recurse, /s, /q
      out.push(w.replace(/^["']|["']$/g, ''))
    }
  }
  return out
}

/** The file ops one tool call makes: Write (created or edited, by whether the file existed), Edit, NotebookEdit, shell deletes. */
export function fileOpsOf(tool: string, input: Readonly<Record<string, unknown>>, existed: boolean): AgentWork['files'] {
  const path = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : ''
  if (tool === 'Write' && path) return [{ path, op: existed ? 'edited' : 'created' }]
  if ((tool === 'Edit' || tool === 'NotebookEdit') && path) return [{ path, op: 'edited' }]
  if ((tool === 'Bash' || tool === 'PowerShell') && typeof input.command === 'string') return deletedPaths(input.command).map(p => ({ path: p, op: 'deleted' as const }))
  return []
}

/** Merges ops into a work record: a path keeps its first place, its latest op, and a file created then edited stays "created". */
export function addFiles(w: AgentWork, ops: AgentWork['files']): AgentWork {
  const files = [...w.files]
  for (const op of ops) {
    const at = files.findIndex(f => f.path === op.path)
    if (at < 0) {
      if (files.length < MAX_FILES) files.push(op)
    } else files[at] = { path: op.path, op: files[at]!.op === 'created' && op.op === 'edited' ? 'created' : op.op }
  }
  return { ...w, files }
}

const patchAgent = (id: string, fn: (a: AgentNode) => AgentNode) => (list: AgentNode[]) =>
  list.map(a => (a.id === id ? fn(a) : a))

/** The pane a token-weather launcher press asks for (its write to token-weather/launch), or undefined for any other write. */
export function launchTarget(write: unknown): string | undefined {
  const w = write as { plugin?: unknown; key?: unknown; value?: { target?: unknown } | null }
  if (w.plugin !== 'token-weather' || w.key !== 'launch') return undefined
  return typeof w.value?.target === 'string' ? w.value.target : undefined
}

export const register: Register = (on, options) => {
  registerArchitect(on, options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'agent-tree',
      description: 'Show the live workflow of agents in this session',
    })
    try {
      await startArchitect($)
    } catch (err) {
      await noteError($, 'architect start', err)
    }
    try {
      const kept = await $.store.get(STORE_HISTORY)
      if (kept && typeof kept === 'object') await update($, runHistory, () => kept as Record<string, number[]>)
    } catch (err) {
      await noteError($, 'run history', err)
    }
    await syncTicker($)
    return next(e)
  })

  // token-weather's launcher buttons: a press writes token-weather/launch, and the mod that owns the
  // pane opens it here. Read at run time, so this mod needs no dependency on token-weather.
  on('state.set', async ($, e, next) => {
    const done = await next(e)
    const target = launchTarget(e)
    if (target !== undefined) {
      const pane = target === 'agent-tree' ? { id: PANE, title: 'Agents' } : target === 'architect' ? { id: ARCH, title: 'Architect' } : null
      if (pane) {
        // A toast, not noteError: that would land in the very pane that did not open.
        const opened = await $.ui.open(pane).catch(err => ({ isPlaced: false as const, reason: err instanceof Error ? err.message : String(err) }))
        if (!opened.isPlaced) await $.ui.toast(`${pane.title} could not be shown: ${opened.reason}`)
      }
    }
    return done
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'agent-tree' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Agents' })
    return { text: 'Agent tree opened.' }
  })

  on('prompt.submit', async ($, e, next) => {
    // Bookkeeping never stands between the person and their prompt.
    try {
      const t = await $.clock.now()
      await update($, root, r => ({
        ...beginRun(r, t),
        ...(isHarnessMessage(e.text) ? {} : { summary: summarize(e.text) || r.summary, prompt: capPrompt(e.text) || r.prompt, promptChars: e.text.length || r.promptChars }),
        startedAt: r.startedAt || t,
      }))
    } catch (err) {
      await noteError($, 'prompt.submit', err)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (result.deny !== undefined || !result.agentId) return result

    try {
      const id = result.agentId
      const t = await $.clock.now()
      const ask = asked.get(e.tool_use_id)
      asked.delete(e.tool_use_id)
      const title = e.name || e.description || e.subagentType
      const node: AgentNode = {
        ...newNode(id, e.parentAgentId ?? ROOT_ID),
        name: title,
        kind: [e.workflow ? `workflow · ${e.subagentType}` : e.fork ? 'fork' : e.subagentType, e.background ? 'background' : '']
          .filter(Boolean)
          .join(' · '),
        model: prettyModel(result.model || e.parentModel),
        effort: ask?.effort ?? '',
        effortFrom: ask?.effort ? 'asked' : '',
        summary: e.name && e.description ? e.description : summarize(e.prompt),
        prompt: capPrompt(e.prompt),
        promptChars: e.prompt.length,
        status: 'running',
        startedAt: t,
        runAt: t,
        etaKey: e.subagentType,
      }
      await update($, agents, list => {
        const old = list.find(a => a.id === id)
        // A resumed agent keeps its record, counts and banked time; it runs again.
        if (old) return list.map(a => (a.id === id ? beginRun(old, t) : a))
        const known = new Set(list.map(a => a.id))
        const placed = { ...node, parentId: known.has(node.parentId!) ? node.parentId : ROOT_ID }
        return [...list, placed].slice(-MAX_AGENTS)
      })
      void $.ui.open({ id: PANE, title: 'Agents' }).catch(err => noteError($, 'ui.open', err))
      await syncTicker($)
    } catch (err) {
      await noteError($, 'agent.spawn', err)
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId) {
      const id = e.agentId
      const t = await $.clock.now()
      await update($, agents, patchAgent(id, a => beginRun(a, t)))
      await syncTicker($)
    } else {
      // Not awaited: asking the app never holds up the turn.
      void pollFast($).catch(err => noteError($, 'fast mode', err))
    }
    return next(e)
  })

  // Each model request names the model and effort it is sent with (as this
  // hook sees it; one beneath may still rewrite them) and, once answered, the
  // model that answered, its context size and its output.
  on('turn.step', async function* ($, e, next) {
    const id = e.agentId
    const model = prettyModel(e.model)
    const effort = fmtEffort(e.effort)
    try {
      const cur = id ? (await read($, agents)).find(a => a.id === id) : await read($, root)
      if (cur && (cur.model !== model || cur.effort !== effort || cur.effortFrom !== 'request')) {
        const set = (a: AgentNode): AgentNode => ({ ...a, model, effort, effortFrom: 'request' })
        if (id) await update($, agents, patchAgent(id, set))
        else await update($, root, set)
      }
    } catch (err) {
      await noteError($, 'turn.step', err)
    }
    const response = yield* next(e)
    try {
      const u = response.usage
      if (u) {
        const add = (a: AgentNode): AgentNode => ({
          ...a,
          model: prettyModel(u.model) || a.model,
          ctx: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
          turnOut: a.turnOut + u.output_tokens,
        })
        if (id) await update($, agents, patchAgent(id, add))
        else await update($, root, add)
      }
    } catch (err) {
      await noteError($, 'turn.step', err)
    }
    return response
  })

  on('tool.call', async ($, e, next) => {
    // This mod's own call (the fast-mode question) is not the session's work.
    if (next.origin.plugin === 'agent-tree') return next(e)
    try {
      if (e.tool === 'Agent' && e.effort) asked.set(e.tool_use_id, { effort: e.effort })
      const id = e.agentId
      const res = resourceOf(e.tool, e as unknown as Record<string, unknown>)
      if (res) {
        const who = id ?? ROOT_ID
        await update($, resources, all => {
          const mine = all[who] ?? {}
          if (!(res in mine) && Object.keys(mine).length >= MAX_RESOURCES) return all
          return { ...all, [who]: { ...mine, [res]: (mine[res] ?? 0) + 1 } }
        })
      }
      if (id) await update($, agents, patchAgent(id, a => ({ ...a, tools: a.tools + 1 })))
      else await update($, root, r => ({ ...r, tools: r.tools + 1 }))
    } catch (err) {
      await noteError($, 'tool.call', err)
    }
    // Skills and files: known only once the call ran (a denied or failed call touched nothing).
    let existed = false
    const input = e as unknown as Record<string, unknown>
    try {
      if (e.tool === 'Write' && typeof input.file_path === 'string') existed = await $.fs.exists(input.file_path)
    } catch {
      existed = false // unknown: counted as created; the pane says "created" for a Write to a path it could not check
    }
    const result = await next(e)
    try {
      const failed = (result as { deny?: unknown; isError?: unknown }).deny !== undefined || (result as { isError?: unknown }).isError === true
      const who = e.agentId ?? ROOT_ID
      const skill = e.tool === 'Skill' && typeof input.skill === 'string' ? input.skill.replace(/^\//, '') : ''
      const ops = failed ? [] : fileOpsOf(e.tool, input, existed)
      if (!failed && (skill || ops.length > 0)) {
        await update($, work, all => {
          let w = all[who] ?? emptyWork()
          if (skill && !w.skills.includes(skill)) w = { ...w, skills: [...w.skills, skill] }
          if (ops.length > 0) w = addFiles(w, ops)
          return { ...all, [who]: w }
        })
      }
    } catch (err) {
      await noteError($, 'tool.call', err)
    }
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) void pollFast($).catch(err => noteError($, 'fast mode', err))
    const t = await $.clock.now()
    const u = e.usage
    const status = statusOf(e.reason)
    // Only runs that finished well teach the ETA: a stopped or failed one says nothing of a normal length.
    try {
      const cur = e.agentId ? (await read($, agents)).find(a => a.id === e.agentId) : await read($, root)
      if (cur && status === 'done' && cur.status === 'running' && cur.runAt && cur.etaKey) {
        const ran = runElapsed(cur, t)
        const all = await update($, runHistory, h => ({ ...h, [cur.etaKey]: [...(h[cur.etaKey] ?? []), ran].slice(-HISTORY_CAP) }))
        await $.store.set(STORE_HISTORY, all)
      }
    } catch (err) {
      await noteError($, 'run history', err)
    }
    // The turn's usage sums its requests; the steps' running count stands in
    // where it has none (an interrupt), so output is never counted twice.
    const finish = (a: AgentNode): AgentNode => ({
      ...bankRun(a, t),
      status,
      endedAt: t,
      out: a.out + (u ? u.output_tokens : a.turnOut),
      turnOut: 0,
      model: a.model || (u ? prettyModel(u.model) : ''),
    })
    if (e.agentId) await update($, agents, patchAgent(e.agentId, finish))
    else await update($, root, finish)
    if (e.agentId && e.answer.trim() !== '') {
      const id = e.agentId
      await update($, work, all => ({ ...all, [id]: { ...(all[id] ?? emptyWork()), output: e.answer.trim().slice(0, OUTPUT_CAP), outputChars: e.answer.trim().length } }))
    }
    await syncTicker($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const usd = e.cost?.usd
    if (typeof usd === 'number') await update($, costUsd, () => usd)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const isTerminal = e.surface === 'terminal'
    const list = await read($, agents)
    const stored = await read($, root)
    // A value stored before the harness filter existed may hold a notification.
    const r = isHarnessMessage(stored.prompt) ? { ...stored, summary: '', prompt: '', promptChars: 0 } : stored
    const err = await read($, errors)
    const tick = await read($, now)
    const cost = await read($, costUsd)
    const folded = new Set(await read($, collapsed))
    const open = new Set(await read($, expanded))
    const used = await read($, resources)
    const did = await read($, work)
    const history = await read($, runHistory)
    const t = Math.max(tick, await $.clock.now())
    const fastNow = await read($, fast)
    const fastBadge = fastNow.state === 'on' ? '⚡ fast' : fastNow.state === 'cooldown' ? 'fast cooldown' : ''
    // Under the main agent: what fast mode costs while it is on or cooling
    // down, and why the state is unknown when it is; nothing while it is off.
    const fastNote =
      fastNow.state === 'on' || fastNow.state === 'cooldown'
        ? `Fast mode (from the desktop app): same tokens, about 2× the price per token (Opus 5.5: $8/$40 vs $4/$20 per MTok); the $ figure above is the engine's own total.${fastNow.why ? ` ${fastNow.why}` : ''}`
        : fastNow.state === 'unknown' && fastNow.checkedAt > 0
          ? `fast: unknown (${fastNow.why})`
          : ''
    const modelLine = (n: AgentNode) => `${n.model || 'model ?'} · ${effortLabel(n)}${n.id === ROOT_ID && fastBadge ? ` · ${fastBadge}` : ''}`
    const rows = layout(r, list, folded)

    const count = (s: AgentStatus) => list.filter(a => a.status === s).length
    const running = count('running')
    const stats = [
      `${list.length} subagent${list.length === 1 ? '' : 's'}`,
      running ? `${running} running` : '',
      count('done') ? `${count('done')} done` : '',
      count('failed') ? `${count('failed')} failed` : '',
      count('stopped') ? `${count('stopped')} stopped` : '',
      cost !== null ? `$${cost.toFixed(2)}` : '',
    ].filter(Boolean)

    const flip = (id: string) => (ids: string[]) => (ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id])
    const toggleFold = (id: string) => update($, collapsed, flip(id))
    const toggleOpen = (id: string) => update($, expanded, flip(id))

    const badgeOf = (n: AgentNode) =>
      n.id === ROOT_ID && n.status !== 'running' && n.status !== 'failed'
        ? { glyph: '○', label: 'idle', color: 'inactive' }
        : GLYPH[n.status]

    const metrics = (n: AgentNode): string =>
      [
        // First, so a narrow pane's truncation never takes it.
        n.startedAt ? fmtDuration(timeSpent(n, t)) : '',
        n.status === 'running' ? etaLabel(history[n.etaKey] ?? [], runElapsed(n, t)) : '',
        n.kind,
        n.ctx ? `${fmtTokens(n.ctx)} ctx` : '',
        n.out + n.turnOut ? `${fmtTokens(n.out + n.turnOut)} out` : '',
        Object.entries(used[n.id] ?? {})
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k} ×${v}`)
          .join(', '),
        `${n.tools} tool${n.tools === 1 ? '' : 's'}`,
        did[n.id]?.skills.length ? `${did[n.id]!.skills.length} skill${did[n.id]!.skills.length === 1 ? '' : 's'}` : '',
        did[n.id]?.files.length ? `${did[n.id]!.files.length} file${did[n.id]!.files.length === 1 ? '' : 's'}` : '',
      ]
        .filter(Boolean)
        .join(' · ')

    // Shown under the prompt when an agent is opened: skills, files (+ created, ~ edited, − deleted), output.
    const OP = { created: '+', edited: '~', deleted: '−' } as const
    const workLines = (n: AgentNode): { label: string; text: string }[] => {
      const w = did[n.id]
      if (!w) return []
      const lines: { label: string; text: string }[] = []
      if (w.skills.length > 0) lines.push({ label: 'Skills', text: w.skills.map(k => `/${k}`).join(', ') })
      if (w.files.length > 0) lines.push({ label: 'Files', text: w.files.map(f => `${OP[f.op]} ${f.path}`).join('\n') })
      if (w.output !== '') lines.push({ label: 'Output', text: w.outputChars > w.output.length ? `${w.output}\n(${OUTPUT_CAP} of ${w.outputChars} characters kept)` : w.output })
      return lines
    }

    const fullPrompt = (n: AgentNode): string =>
      n.promptChars > n.prompt.length ? `${n.prompt}\n… (${PROMPT_CAP} of ${n.promptChars} characters kept)` : n.prompt

    const waveLabel = (row: Row): string =>
      row.waveOpens > 1
        ? `⇉ ${row.waveOpens} in parallel${row.waveRunning ? ` · ${row.waveRunning} running` : ''}`
        : ''

    // Terminal: a dense text tree, glyph-ruled, three lines per agent.
    const terminalRow = (row: Row): RenderChildren => {
      const n = row.node
      const b = badgeOf(n)
      const kids = childCount(n.id, list)
      const isOpen = open.has(n.id)
      const wave = waveLabel(row)
      return (
        <Box key={`n-${n.id}`} flexDirection="column">
          {wave !== '' && <Text dimColor wrap="truncate-end">{row.cont.slice(0, -3)}│ {wave}</Text>}
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Text wrap="truncate-end">
              <Text dimColor>{row.lead}</Text>
              <Text color={b.color}>{b.glyph} </Text>
              <Text weight="semibold" dimColor={n.status === 'stopped'}>{n.name}</Text>
            </Text>
            <Text color="suggestion">{modelLine(n)}</Text>
          </Box>
          {n.summary !== '' && (
            <Button key={`p-${n.id}`} plain onPress={() => void toggleOpen(n.id)}>
              <Text dimColor>{row.cont}  </Text>
              <Text>{isOpen ? '▾ ' : '▸ '}{n.summary}</Text>
            </Button>
          )}
          {isOpen && <Text dimColor wrap="wrap">{fullPrompt(n)}</Text>}
          {isOpen &&
            workLines(n).map(l => (
              <Text key={`w-${n.id}-${l.label}`} wrap="wrap">
                <Text weight="semibold">{l.label}: </Text>
                <Text dimColor>{l.text}</Text>
              </Text>
            ))}
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Text dimColor wrap="truncate-end">{row.cont}  <Text color={b.color}>{b.label}</Text> · {metrics(n)}</Text>
            {kids > 0 && (
              <Button key={`f-${n.id}`} plain onPress={() => void toggleFold(n.id)}>
                <Text dimColor>{folded.has(n.id) ? `› ${kids}` : `⌄ ${kids}`}</Text>
              </Button>
            )}
          </Box>
          {n.id === ROOT_ID && fastNote !== '' && (
            <Text dimColor={fastNow.state === 'unknown'} color={fastNow.state === 'unknown' ? undefined : 'warning'} wrap="wrap">
              {row.cont}  {fastNote}
            </Text>
          )}
        </Box>
      )
    }

    // Graphical surfaces: the map above draws the workflow; this inspector
    // carries what changes by the second, one row per agent, the full prompt
    // a press away.
    const inspectorRow = (row: Row): RenderChildren => {
      const n = row.node
      const b = badgeOf(n)
      const kids = childCount(n.id, list)
      const isOpen = open.has(n.id)
      return (
        <Box key={`n-${n.id}`} flexDirection="column" marginLeft={row.depth * 2}>
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Button key={`p-${n.id}`} plain onPress={() => void toggleOpen(n.id)}>
              <Text color={b.color}>{isOpen ? '▾ ' : '▸ '}{b.glyph} </Text>
              <Text weight="semibold" dimColor={n.status === 'stopped'}>{n.name}</Text>
            </Button>
            <Text size="caption" color="suggestion" weight="medium">{modelLine(n)}</Text>
          </Box>
          <Box flexDirection="row" justifyContent="space-between" gap={1} paddingLeft={2}>
            <Text size="caption" dimColor tabular wrap="truncate-end">
              <Text color={b.color}>{b.label}</Text> · {metrics(n)}
            </Text>
            {kids > 0 && (
              <Button key={`f-${n.id}`} plain onPress={() => void toggleFold(n.id)}>
                <Text size="caption" dimColor>{folded.has(n.id) ? `show ${kids}` : `hide ${kids}`}</Text>
              </Button>
            )}
          </Box>
          {n.id === ROOT_ID && fastNote !== '' && (
            <Text size="caption" color={fastNow.state === 'unknown' ? undefined : 'warning'} dimColor={fastNow.state === 'unknown'} wrap="wrap">
              {'  '}{fastNote}
            </Text>
          )}
          {isOpen && (
            <Box flexDirection="column" paddingLeft={2} marginTop="xs" gap="xs">
              <Text size="footnote" weight="medium">{n.summary}</Text>
              <Text size="footnote" dimColor wrap="wrap">{fullPrompt(n)}</Text>
              {workLines(n).map(l => (
                <Box key={`w-${n.id}-${l.label}`} flexDirection="column">
                  <Text size="footnote" weight="medium">{l.label}</Text>
                  <Text size="footnote" dimColor wrap="wrap">{l.text}</Text>
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    const Svg = !isTerminal && 'Svg' in ui ? ui.Svg : undefined
    // Drawn at the pane's own width so it is never scaled down: about 8 CSS px a
    // cell on the desktop (an estimate, not a value the engine gives).
    const mapW = Math.max(300, Math.min(560, e.props.bodyColumns * 8))
    const map = Svg && list.length > 0 ? graphSvg(rows, mapW, used, fastBadge, t, history) : null

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text weight="semibold" color="claude">✦ Agents</Text>
          <Box flexDirection="row" gap={1}>
            <Text dimColor size="caption" tabular wrap="truncate-start">{stats.join(' · ')}</Text>
          </Box>
        </Box>
        {err.count > 0 && (
          <Text size="caption" color="warning" wrap="truncate-end">
            ⚠ {err.count} update{err.count === 1 ? '' : 's'} failed; the tree may be incomplete. Last: {err.last}
          </Text>
        )}
        {Svg && map && (
          <Svg
            source={map.source}
            width={map.width}
            height={map.height}
            isInteractive
            alt={`Workflow map of ${rows.length} agents: each card is an agent with its model and effort, lines join a parent to the agents it started, and a band groups agents that ran in parallel.`}
          />
        )}
        {(
          <Box flexDirection="column" gap={isTerminal ? 0 : 1}>
            {rows.map(isTerminal ? terminalRow : inspectorRow)}
          </Box>
        )}
        {list.length === 0 && <Text dimColor size="caption">No subagents yet: they join the map as Claude starts them.</Text>}
      </Box>
    )
  })
}
