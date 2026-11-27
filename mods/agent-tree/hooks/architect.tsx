import { atom, read, update } from 'claude-code'
import type { CoreEngineInterface, Register, RenderChildren } from 'claude-code'

import type { ArchDesign, ArchEdge, ArchNode, ArchRole } from '../types'
import { CARD_H, CARD_W } from './canvas'
import type { CanvasNode, CanvasProps } from './canvas'

// The Architect: a pane where the person lays out an agent architecture
// (roles, models, effort, objectives, who hands off to whom, who reviews
// whom, which resources each uses) on a canvas, then launches it: the design
// goes to Claude as one prompt, and Claude runs it with the Agent tool. The
// agent-tree pane then shows the run live.

export const ARCH = 'agent-architect'
const STORE_CURRENT = 'architect.current'
const STORE_SAVED = 'architect.saved'

type RoleInfo = { name: string; tag: string; color: string; isResource: boolean; hint: string }

// A role's starting model and effort; the person can change both. Helpers do
// mechanical steps that need no judgment, so they start on Haiku. Effort is
// left unset: a model that takes no effort setting is sent none, so a preset
// level could be silently dropped; the Agents pane shows what really ran.
const DEFAULTS: Partial<Record<ArchRole, Pick<ArchNode, 'model' | 'effort'>>> = { helper: { model: 'haiku', effort: '' } }

export const ROLES: Record<ArchRole, RoleInfo> = {
  orchestrator: { name: 'Orchestrator', tag: 'ORCH', color: 'claude', isResource: false, hint: 'plans, dispatches, merges results' },
  researcher: { name: 'Researcher', tag: 'RSCH', color: 'suggestion', isResource: false, hint: 'finds and synthesises sources' },
  crawler: { name: 'Crawler', tag: 'CRWL', color: 'suggestion', isResource: false, hint: 'fetches pages or data at scale' },
  builder: { name: 'Builder', tag: 'BLDR', color: 'success', isResource: false, hint: 'writes code or artefacts' },
  doer: { name: 'Doer', tag: 'DOER', color: 'success', isResource: false, hint: 'carries out one task' },
  tester: { name: 'Tester', tag: 'TEST', color: 'warning', isResource: false, hint: 'runs and writes tests' },
  reviewer: { name: 'Reviewer', tag: 'REVW', color: 'warning', isResource: false, hint: 'checks work, can send it back' },
  judge: { name: 'Judge', tag: 'JUDG', color: 'merged', isResource: false, hint: 'compares variants, picks one' },
  variant: { name: 'A/B variant', tag: 'A/B', color: 'merged', isResource: false, hint: 'one of several competing attempts' },
  helper: { name: 'Helper (Haiku)', tag: 'HLPR', color: 'inactive', isResource: false, hint: 'mechanical steps: commits, READMEs, renames, formatting' },
  mcp: { name: 'MCP server', tag: 'MCP', color: 'ide', isResource: true, hint: 'a connected MCP server' },
  rag: { name: 'RAG index', tag: 'RAG', color: 'ide', isResource: true, hint: 'a document store to retrieve from' },
  cli: { name: 'CLI', tag: 'CLI', color: 'ide', isResource: true, hint: 'a command-line tool' },
  cicd: { name: 'CI/CD', tag: 'CI', color: 'ide', isResource: true, hint: 'a pipeline to run or watch' },
}

const AGENT_ROLES = (Object.keys(ROLES) as ArchRole[]).filter(r => !ROLES[r].isResource)
const RESOURCE_ROLES = (Object.keys(ROLES) as ArchRole[]).filter(r => ROLES[r].isResource)
const MODELS: ArchNode['model'][] = ['inherit', 'opus', 'sonnet', 'haiku', 'fable']
const EFFORTS: ArchNode['effort'][] = ['', 'low', 'medium', 'high', 'xhigh', 'max']

const emptyDesign = (): ArchDesign => ({ name: 'Untitled architecture', goal: '', nodes: [], edges: [], nextId: 1 })

const design = atom({ plugin: 'agent-tree', key: 'design' } as const, emptyDesign())
const selected = atom({ plugin: 'agent-tree', key: 'archSelected' } as const, null)
const linking = atom({ plugin: 'agent-tree', key: 'archLink' } as const, null)
const note = atom({ plugin: 'agent-tree', key: 'archNote' } as const, '')

const isResource = (n: ArchNode) => ROLES[n.role].isResource

const newNode = (d: ArchDesign, role: ArchRole, x: number, y: number): ArchNode => ({
  id: `n${d.nextId}`,
  label: `${ROLES[role].name}${d.nodes.some(n => n.role === role) ? ` ${d.nodes.filter(n => n.role === role).length + 1}` : ''}`,
  role,
  model: DEFAULTS[role]?.model ?? 'inherit',
  effort: DEFAULTS[role]?.effort ?? '',
  objective: '',
  x,
  y,
})

// The first grid slot no card covers, left to right then down.
export const freeSlot = (d: ArchDesign, cols: number): { x: number; y: number } => {
  const stepX = CARD_W + 6
  const stepY = CARD_H + 2
  const perRow = Math.max(1, Math.floor((cols - CARD_W) / stepX) + 1)
  for (let i = 0; i < 400; i++) {
    const x = (i % perRow) * stepX
    const y = Math.floor(i / perRow) * stepY
    const isTaken = d.nodes.some(n => Math.abs(n.x - x) < CARD_W && Math.abs(n.y - y) < CARD_H)
    if (!isTaken) return { x, y }
  }
  return { x: 0, y: d.nodes.length * stepY }
}

// ----- templates -------------------------------------------------------------

type Sketch = Array<[ArchRole, string, string, number, number, ArchNode['model']?, ArchNode['effort']?]>

const fromSketch = (name: string, goal: string, sketch: Sketch, links: Array<[number, number, ArchEdge['kind']]>): ArchDesign => {
  const nodes = sketch.map(([role, label, objective, x, y, model, effort], i) => ({
    id: `n${i + 1}`, label, role, objective, x, y, model: model ?? 'inherit', effort: effort ?? '',
  }))
  const edges = links.map(([a, b, kind]) => ({ from: `n${a + 1}`, to: `n${b + 1}`, kind }))
  return { name, goal, nodes, edges, nextId: nodes.length + 1 }
}

export const TEMPLATES: Record<string, () => ArchDesign> = {
  'Build, test, review': () =>
    fromSketch('Build, test, review', '', [
      ['orchestrator', 'Lead', 'Split the goal into tasks, dispatch them, merge the results.', 0, 0, 'opus', 'high'],
      ['researcher', 'Scout', 'Read the codebase and docs; report what the builder must know.', 30, 0, 'sonnet', 'medium'],
      ['builder', 'Builder', 'Implement the change from the scout\'s report.', 60, 0, 'opus', 'high'],
      ['tester', 'Tester', 'Write and run tests for the change; report failures with output.', 60, 7, 'sonnet', 'medium'],
      ['reviewer', 'Reviewer', 'Review the diff for bugs and scope; approve or send back.', 30, 7, 'opus', 'high'],
      ['cli', 'test runner', 'The project\'s test command.', 90, 7],
    ], [[1, 2, 'then'], [2, 3, 'then'], [4, 2, 'review'], [3, 5, 'uses']]),
  'A/B with a judge': () =>
    fromSketch('A/B with a judge', '', [
      ['variant', 'Variant A', 'Solve the task one way.', 0, 0, 'sonnet', 'high'],
      ['variant', 'Variant B', 'Solve the same task another way.', 0, 7, 'opus', 'medium'],
      ['judge', 'Judge', 'Compare A and B against the goal; pick one and say why.', 32, 3, 'opus', 'high'],
    ], [[0, 2, 'then'], [1, 2, 'then']]),
  'Research swarm': () =>
    fromSketch('Research swarm', '', [
      ['crawler', 'Crawler 1', 'Collect sources on the first sub-question.', 0, 0, 'haiku'],
      ['crawler', 'Crawler 2', 'Collect sources on the second sub-question.', 0, 6, 'haiku'],
      ['crawler', 'Crawler 3', 'Collect sources on the third sub-question.', 0, 12, 'haiku'],
      ['researcher', 'Synthesiser', 'Merge the crawlers\' findings into one cited report.', 32, 6, 'opus', 'high'],
      ['rag', 'notes index', 'Existing notes to check before searching the web.', 64, 0],
      ['reviewer', 'Fact-checker', 'Check every claim in the report against its source.', 64, 12, 'sonnet', 'high'],
    ], [[0, 3, 'then'], [1, 3, 'then'], [2, 3, 'then'], [3, 4, 'uses'], [5, 3, 'review']]),
}

// A template drawn for a wide canvas, its columns squeezed to fit a narrower
// one; cards may then overlap, never fall outside where they can be grabbed.
export const fitWidth = (d: ArchDesign, canvasCols: number): ArchDesign => {
  const right = Math.max(0, ...d.nodes.map(n => n.x + CARD_W))
  if (right <= canvasCols) return d
  const k = (canvasCols - CARD_W) / Math.max(1, right - CARD_W)
  return { ...d, nodes: d.nodes.map(n => ({ ...n, x: Math.round(n.x * k) })) }
}

// ----- compiling a design into a launch prompt --------------------------------

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'

export type Compiled = { text: string; problems: string[]; stages: string[][] }

export const compile = (d: ArchDesign): Compiled => {
  const problems: string[] = []
  const byId = new Map(d.nodes.map(n => [n.id, n]))
  const agents = d.nodes.filter(n => !isResource(n))
  const leads = agents.filter(n => n.role === 'orchestrator')
  const workers = agents.filter(n => n.role !== 'orchestrator')
  if (!d.goal.trim()) problems.push('The architecture has no goal.')
  if (workers.length === 0) problems.push('Add at least one agent besides the orchestrator.')
  for (const n of d.nodes) if (!n.objective.trim()) problems.push(`"${n.label}" has no ${isResource(n) ? 'description' : 'objective'}.`)
  const names = new Map<string, string[]>()
  for (const n of agents) names.set(slug(n.label), [...(names.get(slug(n.label)) ?? []), n.label])
  for (const [name, ls] of names) if (ls.length > 1) problems.push(`${ls.map(l => `"${l}"`).join(' and ')} would both be named "${name}"; rename one.`)
  for (const e of d.edges) {
    const a = byId.get(e.from)
    const b = byId.get(e.to)
    if (!a || !b) continue
    if (e.kind === 'uses' && (isResource(a) || !isResource(b))) problems.push(`"${a.label} uses ${b.label}" must go from an agent to a resource.`)
    if (e.kind !== 'uses' && (isResource(a) || isResource(b))) problems.push(`"${a.label} → ${b.label}": only agents hand off or review; link resources with "uses".`)
  }

  // Order: `then` runs the target after the source; a reviewer runs after
  // what it reviews. Each stage is what can start once the stages before end.
  const after = new Map<string, Set<string>>(workers.map(n => [n.id, new Set()]))
  for (const e of d.edges) {
    if (!after.has(e.from) || !after.has(e.to)) continue
    if (e.kind === 'then') after.get(e.to)!.add(e.from)
    if (e.kind === 'review') after.get(e.from)!.add(e.to)
  }
  const stages: string[][] = []
  const done = new Set<string>()
  while (done.size < workers.length) {
    const ready = workers.filter(n => !done.has(n.id) && [...after.get(n.id)!].every(p => done.has(p)))
    if (ready.length === 0) {
      const stuck = workers.filter(n => !done.has(n.id)).map(n => n.label)
      problems.push(`A loop of hand-offs has no first step: ${stuck.join(', ')}. Make one of them start the loop, or use "reviews".`)
      stages.push(stuck)
      break
    }
    stages.push(ready.map(n => n.label))
    ready.forEach(n => done.add(n.id))
  }

  const usesOf = (n: ArchNode) =>
    d.edges.filter(e => e.from === n.id && e.kind === 'uses').map(e => byId.get(e.to)).filter((r): r is ArchNode => !!r)
  const feedsOf = (n: ArchNode) =>
    d.edges.filter(e => e.to === n.id && e.kind === 'then').map(e => byId.get(e.from)?.label).filter(Boolean)
  const lines: string[] = []
  lines.push(`Run this agent architecture, designed in the Architect pane ("${d.name}"). Follow it as written; stop and ask me only if something blocks you.`)
  lines.push('', `Goal: ${d.goal.trim()}`)
  if (leads.length > 0) {
    lines.push('', 'You are the orchestrator' + (leads.length > 1 ? 's' : '') + ':')
    for (const n of leads) lines.push(`- ${n.label}: ${n.objective.trim()}`)
  } else {
    lines.push('', 'You coordinate: start each agent when its stage comes, pass results along, and merge them.')
  }
  lines.push('', 'Agents. Start each with the Agent tool, using exactly this name, description, model and effort (I chose them):')
  for (const n of workers) {
    const params = [`name: "${slug(n.label)}"`, `description: "${n.label}"`]
    if (n.model !== 'inherit') params.push(`model: "${n.model}"`)
    if (n.effort) params.push(`effort: "${n.effort}"`)
    lines.push(`- ${n.label} (${ROLES[n.role].name.replace(/ \(.*\)$/, '').toLowerCase()}; ${params.join(', ')})`)
    lines.push(`  Objective: ${n.objective.trim()}`)
    const feeds = feedsOf(n)
    if (feeds.length) lines.push(`  Give it the results of: ${feeds.join(', ')}.`)
    const uses = usesOf(n)
    if (uses.length) lines.push(`  It uses: ${uses.map(r => `${ROLES[r.role].name} "${r.label}" (${r.objective.trim()})`).join('; ')}.`)
  }
  lines.push('', 'Order (agents in one stage run in parallel; a stage starts when the one before has finished):')
  stages.forEach((s, i) => lines.push(`${i + 1}. ${s.join(', ')}`))
  const reviews = d.edges.filter(e => e.kind === 'review' && byId.has(e.from) && byId.has(e.to))
  if (reviews.length) {
    lines.push('', 'Review loops (at most 3 rounds each; report it if a loop does not converge):')
    for (const e of reviews) {
      lines.push(`- ${byId.get(e.from)!.label} reviews ${byId.get(e.to)!.label}'s output; if it rejects it, send the feedback back to ${byId.get(e.to)!.label} to revise.`)
    }
  }
  const resources = d.nodes.filter(isResource)
  if (resources.length) {
    lines.push('', 'Resources:')
    for (const r of resources) lines.push(`- ${ROLES[r.role].name} "${r.label}": ${r.objective.trim()}`)
  }
  lines.push('', 'When everything has run: report each agent\'s result in one or two lines, whether the goal was met, and what is left.')
  return { text: lines.join('\n'), problems, stages }
}

// ----- input from the canvas -------------------------------------------------

type CanvasMessage =
  | { type: 'select'; id: string | null }
  | { type: 'move'; id: string; x: number; y: number }
  | { type: 'link'; to: string }

// The canvas is code on the surface: what it posts is checked, not trusted.
export const parseMessage = (data: unknown): CanvasMessage | null => {
  if (typeof data !== 'object' || data === null) return null
  const m = data as Record<string, unknown>
  const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 10_000
  if (m.type === 'select' && (m.id === null || typeof m.id === 'string')) return { type: 'select', id: m.id }
  if (m.type === 'move' && typeof m.id === 'string' && isInt(m.x) && isInt(m.y)) return { type: 'move', id: m.id, x: m.x, y: m.y }
  if (m.type === 'link' && typeof m.to === 'string') return { type: 'link', to: m.to }
  return null
}

// Every change to the design is kept in the session and, across sessions,
// in the mod's store.
async function edit($: Pick<CoreEngineInterface, 'state' | 'store'>, fn: (d: ArchDesign) => ArchDesign): Promise<void> {
  await update($, design, fn)
  await $.store.set(STORE_CURRENT, await read($, design))
}

const isDesign = (v: unknown): v is ArchDesign =>
  typeof v === 'object' &&
  v !== null &&
  Array.isArray((v as ArchDesign).nodes) &&
  Array.isArray((v as ArchDesign).edges) &&
  (v as ArchDesign).nodes.every(n => typeof n === 'object' && n !== null && n.role in ROLES && typeof n.id === 'string')

// Run from the mod's one session.start hook: the command, and the design the
// person was last editing, brought back from the store into a fresh session.
export async function startArchitect($: Pick<CoreEngineInterface, 'state' | 'store' | 'command'>): Promise<void> {
  await $.command.register({ name: 'architect', description: 'Design an agent architecture on a canvas, then launch it' })
  const cur = await read($, design)
  if (cur.nodes.length === 0) {
    const kept = await $.store.get(STORE_CURRENT)
    if (isDesign(kept)) await update($, design, () => kept)
  }
}

export const register: Register = on => {
  on('command.run', { command: 'architect' }, async $ => {
    await $.ui.open({ id: ARCH, title: 'Architect' })
    return { text: 'Architect opened.' }
  })

  on('ui.message', { requestId: ARCH }, async ($, e, next) => {
    const m = parseMessage(e.data)
    if (!m) {
      await update($, note, () => 'The canvas sent something unreadable; it was ignored.')
      return next(e)
    }
    if (m.type === 'select') {
      await update($, selected, () => m.id)
      await update($, linking, () => null)
    } else if (m.type === 'move') {
      await edit($, d => ({ ...d, nodes: d.nodes.map(n => (n.id === m.id ? { ...n, x: m.x, y: m.y } : n)) }))
    } else {
      const link = await read($, linking)
      if (link && link.from !== m.to) {
        const exists = (await read($, design)).edges.some(x => x.from === link.from && x.to === m.to && x.kind === link.kind)
        if (!exists) await edit($, d => ({ ...d, edges: [...d.edges, { from: link.from, to: m.to, kind: link.kind }] }))
        await update($, linking, () => null)
        await update($, selected, () => m.to)
        await update($, note, () => (exists ? 'That link already exists.' : 'Linked.'))
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: ARCH }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    // Mobile draws no fields: its Architect shows the design and takes no edits.
    const Input = 'Input' in ui ? ui.Input : undefined
    const Select = 'Select' in ui ? ui.Select : undefined
    const d = await read($, design)
    const selId = await read($, selected)
    const sel = d.nodes.find(n => n.id === selId) ?? null
    const link = await read($, linking)
    const said = await read($, note)
    const cols = e.props.bodyColumns
    const canvasCols = Math.max(CARD_W + 2, cols - 4)
    const compiled = compile(d)
    const byId = new Map(d.nodes.map(n => [n.id, n]))

    const say = (text: string) => update($, note, () => text)
    const add = async (role: ArchRole) => {
      let n: ArchNode | null = null
      await edit($, x => {
        const at = freeSlot(x, canvasCols)
        n = newNode(x, role, at.x, at.y)
        return { ...x, nodes: [...x.nodes, n], nextId: x.nextId + 1 }
      })
      const made = n as ArchNode | null
      if (!made) return
      await update($, selected, () => made.id)
      await say(`Added ${made.label}. Drag it into place; set its objective below.`)
    }
    const patch = (id: string, p: Partial<ArchNode>) =>
      edit($, x => ({ ...x, nodes: x.nodes.map(n => (n.id === id ? { ...n, ...p } : n)) }))
    const remove = async (id: string) => {
      await edit($, x => ({ ...x, nodes: x.nodes.filter(n => n.id !== id), edges: x.edges.filter(l => l.from !== id && l.to !== id) }))
      await update($, selected, () => null)
    }
    const launch = async (mode: 'submit' | 'fill') => {
      if (compiled.problems.length > 0) {
        await say(`Not launched: ${compiled.problems[0]}${compiled.problems.length > 1 ? ` (+${compiled.problems.length - 1} more below)` : ''}`)
        return
      }
      if (mode === 'submit') {
        const r = await $.prompt.submit({ text: compiled.text, asUser: true })
        if (r.drop !== undefined) {
          await say(`Not launched: the prompt was refused (${r.drop}).`)
          return
        }
        await say(`Launched "${d.name}": sent to Claude. Watch it run in the Agents pane.`)
        void $.ui.open({ id: 'agent-tree', title: 'Agents' }).catch(() => say('Launched, but the Agents pane could not be opened; use /agent-tree.'))
      } else {
        const r = await $.prompt.fill({ text: compiled.text })
        await say(r.isFilled ? 'The launch prompt is in the prompt box: edit it, then press Enter.' : 'The prompt box did not take the text (a dialog may be open); nothing was sent.')
      }
    }

    const canvasNodes: CanvasNode[] = d.nodes.map(n => ({
      id: n.id,
      label: n.label,
      tag: ROLES[n.role].tag,
      color: ROLES[n.role].color,
      line2: isResource(n) ? n.objective || ROLES[n.role].hint : [n.model === 'inherit' ? 'default model' : n.model, n.effort || ''].filter(Boolean).join(' · '),
      isResource: isResource(n),
      x: n.x,
      y: n.y,
    }))
    const canvasRows = Math.max(16, Math.min(48, Math.max(0, ...d.nodes.map(n => n.y + CARD_H)) + 3))
    const canvasProps: CanvasProps = { nodes: canvasNodes, edges: d.edges, selected: sel?.id ?? null, linkFrom: link?.from ?? null, rows: canvasRows }

    const palette = (roles: ArchRole[], prefix: string): RenderChildren => (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        {roles.map(r => (
          <Button key={`${prefix}-${r}`} onPress={() => void add(r)}>
            <Text color={ROLES[r].color}>+ </Text>
            <Text>{ROLES[r].name}</Text>
          </Button>
        ))}
      </Box>
    )

    const linkButtons = (n: ArchNode): RenderChildren =>
      isResource(n) ? (
        <Text dimColor size="caption">Link to a resource from the agent that uses it.</Text>
      ) : (
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Button key="link-then" onPress={() => void update($, linking, () => ({ from: n.id, kind: 'then' as const }))}>→ hands off to…</Button>
          <Button key="link-review" onPress={() => void update($, linking, () => ({ from: n.id, kind: 'review' as const }))}>⟲ reviews…</Button>
          <Button key="link-uses" onPress={() => void update($, linking, () => ({ from: n.id, kind: 'uses' as const }))}>⌁ uses…</Button>
        </Box>
      )

    const inspector = (n: ArchNode): RenderChildren => {
      const links = d.edges
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => l.from === n.id || l.to === n.id)
      return (
        <Box flexDirection="column" gap={1} borderStyle="round" borderColor="subtle" paddingX={1}>
          <Text weight="semibold">
            <Text color={ROLES[n.role].color}>{ROLES[n.role].tag} </Text>
            {n.label}
            <Text dimColor size="caption">  {ROLES[n.role].hint}</Text>
          </Text>
          {Input && (
            <Input key="node-label" label="Name" value={n.label} onInput={v => void patch(n.id, { label: v })} onSubmit={v => void patch(n.id, { label: v })} />
          )}
          {Select && (
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              <Select
                key="node-role"
                label="Role"
                value={n.role}
                options={(Object.keys(ROLES) as ArchRole[]).map(r => ({ value: r, label: ROLES[r].name }))}
                onSelect={v => void patch(n.id, { role: v as ArchRole })}
              />
              {!isResource(n) && (
                <Select key="node-model" label="Model" value={n.model} options={MODELS.map(m => ({ value: m, label: m === 'inherit' ? 'default' : m }))} onSelect={v => void patch(n.id, { model: v as ArchNode['model'] })} />
              )}
              {!isResource(n) && (
                <Select key="node-effort" label="Effort" value={n.effort || 'unset'} options={EFFORTS.map(x => ({ value: x || 'unset', label: x || 'default' }))} onSelect={v => void patch(n.id, { effort: (v === 'unset' ? '' : v) as ArchNode['effort'] })} />
              )}
            </Box>
          )}
          {!isResource(n) && n.model === 'haiku' && n.effort !== '' && (
            <Text size="caption" color="warning" wrap="wrap">
              Haiku may not take an effort setting; if not, it runs without one. The Agents pane shows what it really ran with.
            </Text>
          )}
          {Input && (
            <Input
              key="node-objective"
              label={isResource(n) ? 'What it is' : 'Objective'}
              rows={3}
              placeholder={isResource(n) ? 'server name, index, command…' : 'what this agent must deliver'}
              value={n.objective}
              onInput={v => void patch(n.id, { objective: v })}
              onSubmit={v => void patch(n.id, { objective: v })}
            />
          )}
          {linkButtons(n)}
          {links.length > 0 && (
            <Box flexDirection="column">
              {links.map(({ l, i }) => (
                <Box key={`edge-row-${i}`} flexDirection="row" justifyContent="space-between" gap={1}>
                  <Text size="caption" dimColor wrap="truncate-end">
                    {byId.get(l.from)?.label} {l.kind === 'then' ? '→ hands off to' : l.kind === 'review' ? '⟲ reviews' : '⌁ uses'} {byId.get(l.to)?.label}
                  </Text>
                  <Button key={`edge-del-${i}`} plain onPress={() => void edit($, x => ({ ...x, edges: x.edges.filter((_, j) => j !== i) }))}>
                    <Text size="caption" color="error">remove</Text>
                  </Button>
                </Box>
              ))}
            </Box>
          )}
          <Box flexDirection="row" gap={1}>
            <Button key="node-dup" onPress={() => void (async () => {
              let id = ''
              await edit($, x => {
                const at = freeSlot(x, canvasCols)
                id = `n${x.nextId}`
                return { ...x, nodes: [...x.nodes, { ...n, id, label: `${n.label} copy`, x: at.x, y: at.y }], nextId: x.nextId + 1 }
              })
              await update($, selected, () => id)
            })()}>Duplicate</Button>
            <Button key="node-del" onPress={() => void remove(n.id)}>
              <Text color="error">Delete</Text>
            </Button>
          </Box>
        </Box>
      )
    }

    const Client = 'Client' in ui ? ui.Client : undefined
    const saved = (await $.store.get(STORE_SAVED)) as Record<string, ArchDesign> | undefined

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" gap={1}>
          <Text weight="semibold" color="claude">✦ Architect</Text>
          <Text dimColor size="caption">
            {d.nodes.filter(n => !isResource(n)).length} agents · {d.nodes.filter(isResource).length} resources · {d.edges.length} links
          </Text>
        </Box>
        {said !== '' && <Text size="caption" color={said.startsWith('Not launched') ? 'warning' : 'suggestion'}>{said}</Text>}
        {Input && <Input key="arch-name" label="Name" value={d.name} onInput={v => void edit($, x => ({ ...x, name: v }))} onSubmit={v => void edit($, x => ({ ...x, name: v }))} />}
        {Input && (
          <Input key="arch-goal" label="Goal" rows={2} placeholder="what the whole architecture must achieve" value={d.goal} onInput={v => void edit($, x => ({ ...x, goal: v }))} onSubmit={v => void edit($, x => ({ ...x, goal: v }))} />
        )}
        <Box flexDirection="column">
          <Text dimColor size="caption">Agents</Text>
          {palette(AGENT_ROLES, 'add')}
        </Box>
        <Box flexDirection="column">
          <Text dimColor size="caption">Resources</Text>
          {palette(RESOURCE_ROLES, 'add')}
        </Box>
        {Client ? (
          <Box flexDirection="column" borderStyle="round" borderColor={link ? 'warning' : 'subtle'}>
            <Client key="canvas" module="./canvas.tsx" props={canvasProps} height={canvasRows} width="100%" />
          </Box>
        ) : (
          <Text dimColor>This surface has no canvas; the design is listed here and edits work from the inspector.</Text>
        )}
        {link ? (
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Text color="warning" size="caption">
              Click the card that {byId.get(link.from)?.label} {link.kind === 'then' ? 'hands off to' : link.kind === 'review' ? 'reviews' : 'uses'}.
            </Text>
            <Button key="link-cancel" plain onPress={() => void update($, linking, () => null)}>
              <Text size="caption">cancel</Text>
            </Button>
          </Box>
        ) : (
          <Text dimColor size="caption">Drag cards to place them · click one to edit it · link it from the inspector · grey → hands off, yellow ⟲ reviews, blue ⌁ uses</Text>
        )}
        {!Client && d.nodes.map(n => (
          <Button key={`pick-${n.id}`} plain onPress={() => void update($, selected, () => n.id)}>
            <Text color={ROLES[n.role].color}>{ROLES[n.role].tag} </Text>
            <Text>{n.label}</Text>
          </Button>
        ))}
        {sel && inspector(sel)}
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" flexWrap="wrap" gap={1}>
            <Button key="launch" onPress={() => void launch('submit')}>
              <Text color="claude" weight="semibold">▶ Launch</Text>
              <Text dimColor> (sends the plan as your message)</Text>
            </Button>
            <Button key="to-prompt" onPress={() => void launch('fill')}>Put in prompt box</Button>
            <Button key="save" onPress={() => void (async () => {
              const all = { ...(saved ?? {}), [d.name]: d }
              await $.store.set(STORE_SAVED, all)
              await say(`Saved as "${d.name}".`)
            })()}>Save</Button>
            <Button key="new" onPress={() => void (async () => {
              await edit($, () => emptyDesign())
              await update($, selected, () => null)
              await say('New, empty architecture.')
            })()}>New</Button>
          </Box>
          {Select && (
            <Box flexDirection="row" flexWrap="wrap" gap={1}>
              <Select
                key="template"
                label="Start from"
                value="none"
                options={[{ value: 'none', label: 'a template…' }, ...Object.keys(TEMPLATES).map(k => ({ value: k }))]}
                onSelect={v => void (async () => {
                  const make = TEMPLATES[v]
                  if (!make) return
                  const t = fitWidth(make(), canvasCols)
                  await edit($, () => ({ ...t, goal: d.goal }))
                  await update($, selected, () => null)
                  await say(`Loaded the "${v}" template. Set the goal and each objective, then Launch.`)
                })()}
              />
              {saved && Object.keys(saved).length > 0 && (
                <Select
                  key="load"
                  label="Open"
                  value="none"
                  options={[{ value: 'none', label: 'a saved design…' }, ...Object.keys(saved).map(k => ({ value: k }))]}
                  onSelect={v => void (async () => {
                    const s = saved[v]
                    if (!isDesign(s)) return
                    await edit($, () => s)
                    await update($, selected, () => null)
                    await say(`Opened "${v}".`)
                  })()}
                />
              )}
            </Box>
          )}
          {compiled.problems.length > 0 && (
            <Box flexDirection="column">
              <Text size="caption" color="warning">Before launch:</Text>
              {compiled.problems.slice(0, 6).map(p => (
                <Text size="caption" dimColor>• {p}</Text>
              ))}
            </Box>
          )}
          {compiled.problems.length === 0 && compiled.stages.length > 0 && (
            <Text size="caption" dimColor wrap="wrap">
              Runs in {compiled.stages.length} stage{compiled.stages.length === 1 ? '' : 's'}: {compiled.stages.map(s => s.join(' ∥ ')).join('  →  ')}
            </Text>
          )}
        </Box>
      </Box>
    )
  })
}
