import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Catalog, ShelfItem, ShelfKind, Usage } from '../types'
import {
  OWN,
  agentItem,
  ago,
  fromCommands,
  fromTools,
  frontmatterDescription,
  hookedIds,
  SUMMARY_MIN,
  SUMMARY_SYSTEM,
  hashText,
  parseSummaries,
  summaryPrompt,
  isNeverAuto,
  launchText,
  matchesQuery,
  slashId,
  suggest,
} from './shelf'

const PANE = 'skill-shelf'
const TITLE = 'Skill shelf'

const catalog = atom({ plugin: 'skill-shelf', key: 'catalog' } as const, { items: [], notes: [], builtAt: 0 } as Catalog, {
  shape: 'catalog-1',
})
const usage = atom({ plugin: 'skill-shelf', key: 'usage' } as const, {} as Record<string, Usage>, { shape: 'usage-1' })
const agents = atom({ plugin: 'skill-shelf', key: 'agents' } as const, [] as ShelfItem[], { shape: 'agents-1' })
const skills = atom({ plugin: 'skill-shelf', key: 'skills' } as const, [] as string[])
const hooked = atom({ plugin: 'skill-shelf', key: 'hooked' } as const, [] as string[])
const prompt = atom({ plugin: 'skill-shelf', key: 'prompt' } as const, '')
const showAll = atom({ plugin: 'skill-shelf', key: 'showAll' } as const, false)
const query = atom({ plugin: 'skill-shelf', key: 'query' } as const, '')
const summaries = atom({ plugin: 'skill-shelf', key: 'summaries' } as const, {} as Record<string, string>)
const since = atom({ plugin: 'skill-shelf', key: 'since' } as const, 0)

// Origins that are the person typing (the desktop app is an SDK host); any other run counts as automatic.
const PERSON = new Set(['composer', 'bridge', 'sdk'])

const GROUPS: { kind: ShelfKind; label: string }[] = [
  { kind: 'skill', label: 'Skills' },
  { kind: 'command', label: 'Commands' },
  { kind: 'agent', label: 'Agents' },
  { kind: 'tool', label: 'Tools' },
]

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

const isUsage = (v: unknown): v is Usage =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Usage).auto === 'number' &&
  typeof (v as Usage).manual === 'number' &&
  typeof (v as Usage).last === 'number'

/** Folder names under `path`; [] when it does not exist, a note when it cannot be listed. */
async function folders($: EngineInterface, path: string, notes: string[]): Promise<string[]> {
  if (!(await $.fs.exists(path))) return []
  try {
    return (await $.fs.list(path)).filter(entry => entry.kind !== 'file').map(entry => entry.name)
  } catch (err) {
    notes.push(`Could not list ${path}: ${message(err)}`)
    return []
  }
}

/**
 * Reads what is installed. Commands and tools come from the engine
 * (`$.command.list`, `$.tool.list`); the engine does not say which commands
 * are skills, so skill folders on disk say it (`~/.claude/skills/<name>`,
 * each installed plugin's `skills/<name>`), with skills seen running added.
 * Agent definitions in `~/.claude/agents` are read from disk too; the
 * engine's own list of agent types arrives through `agent.offer`.
 */
async function build($: EngineInterface): Promise<void> {
  const notes: string[] = []
  const known = new Set(await read($, skills))
  const fileAgents: ShelfItem[] = []
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (home === undefined) {
    notes.push('Neither USERPROFILE nor HOME is set: skills are told from commands only once they run, and ~/.claude/agents is not read.')
  } else {
    const sep = home.includes('\\') ? '\\' : '/'
    const join = (...parts: string[]) => parts.join(sep)
    for (const name of await folders($, join(home, '.claude', 'skills'), notes)) known.add(name)
    const index = join(home, '.claude', 'plugins', 'installed_plugins.json')
    if (await $.fs.exists(index)) {
      try {
        const parsed = JSON.parse(await $.fs.read(index)) as { plugins?: Record<string, { installPath?: unknown }[]> }
        for (const [key, entries] of Object.entries(parsed.plugins ?? {})) {
          const path = entries[0]?.installPath
          if (typeof path !== 'string') continue
          const plugin = key.split('@')[0]!
          for (const name of await folders($, path + (path.includes('\\') ? '\\' : '/') + 'skills', notes)) known.add(`${plugin}:${name}`)
        }
      } catch (err) {
        notes.push(`installed_plugins.json could not be read: ${message(err)}. Plugin skills show as commands until they run.`)
      }
    } else {
      notes.push('No installed_plugins.json: plugin skills show as commands until they run.')
    }
    const agentDir = join(home, '.claude', 'agents')
    if (await $.fs.exists(agentDir)) {
      for (const entry of await $.fs.list(agentDir)) {
        if (entry.kind !== 'file' || !entry.name.endsWith('.md')) continue
        const text = await $.fs.read(join(agentDir, entry.name))
        fileAgents.push(agentItem(entry.name.slice(0, -3), frontmatterDescription(text), 'userSettings'))
      }
    }
  }

  const items = [...fromCommands(await $.command.list(), known), ...fileAgents, ...fromTools(await $.tool.list())]
  const hooks = await $.settings.read({ key: 'hooks' })
  const offered = await read($, agents)
  await update($, hooked, () => hookedIds(hooks, [...items, ...offered]))
  const now = await $.clock.now()
  await update($, catalog, () => ({ items, notes, builtAt: now }))
}

async function bump($: EngineInterface, id: string, how: 'auto' | 'manual'): Promise<void> {
  const now = await $.clock.now()
  let after: Usage = { auto: 0, manual: 0, last: now }
  await update($, usage, map => {
    const before = map[id] ?? { auto: 0, manual: 0, last: 0 }
    after = { ...before, [how]: before[how] + 1, last: now }
    return { ...map, [id]: after }
  })
  await $.store.set(`use:${id}`, after)
}

async function learnSkill($: EngineInterface, name: string): Promise<void> {
  if ((await read($, skills)).includes(name)) return
  const list = await update($, skills, names => (names.includes(name) ? names : [...names, name]))
  await $.store.set('skills', list)
  await update($, catalog, cat => ({
    ...cat,
    items: cat.items.map(item => (item.id === slashId(name) ? { ...item, kind: 'skill' as const } : item)),
  }))
}

/** Agent types from the files merged with the ones the engine offered (theirs win). */
function allItems(cat: Catalog, offered: readonly ShelfItem[]): ShelfItem[] {
  const names = new Set(offered.map(a => a.name))
  return [...cat.items.filter(item => item.kind !== 'agent' || !names.has(item.name)), ...offered]
}

/** The pane a token-weather launcher press asks for (its write to token-weather/launch), or undefined for any other write. */
export function launchTarget(write: unknown): string | undefined {
  const w = write as { plugin?: unknown; key?: unknown; value?: { target?: unknown } | null }
  if (w.plugin !== 'token-weather' || w.key !== 'launch') return undefined
  return typeof w.value?.target === 'string' ? w.value.target : undefined
}

/** Whether the draft `text` replaces the text suggestions match: never empty (so Enter or a clear keeps them up), never a slash command (the typeahead covers those). */
export function isDraftToMatch(text: string): boolean {
  return text.trim() !== '' && !text.trimStart().startsWith('/')
}

// Suggestions follow the draft as it is typed; the shelf's own fills (a plugin change) are ignored.
async function follow($: EngineInterface, text: string): Promise<void> {
  if (isDraftToMatch(text)) await update($, prompt, () => text)
}

// One summarising run at a time; a run started while one is going is dropped (the next build starts another).
let summarizing = false

/**
 * Summarises, in the background, the long descriptions that have no summary yet: batches of 20
 * through the small model, each result kept in state and in the store, so each text is
 * summarised once. Until then the full description shows (never a cut one).
 */
async function summarizeMissing($: EngineInterface): Promise<void> {
  if (summarizing) return
  summarizing = true
  try {
    const have = await read($, summaries)
    const pending = new Map<string, { id: string; name: string; description: string }>()
    for (const item of allItems(await read($, catalog), await read($, agents))) {
      const key = hashText(item.description)
      if (item.description.length > SUMMARY_MIN && have[key] === undefined) pending.set(key, { id: key, name: item.name, description: item.description })
    }
    const list = [...pending.values()]
    for (let i = 0; i < list.length; i += 20) {
      const batch = list.slice(i, i + 20)
      const reply = await $.model.complete({ model: 'haiku', system: SUMMARY_SYSTEM, prompt: summaryPrompt(batch), maxTokens: 4000, timeoutMs: 90_000 })
      if (!reply.isAnswered) {
        await update($, catalog, cat => ({ ...cat, notes: [...cat.notes.filter(n => !n.startsWith('Summaries')), `Summaries paused (${reply.reason}); full descriptions show. Refresh retries.`] }))
        return
      }
      const got = parseSummaries(reply.text, batch.map(b => b.id))
      const all = await update($, summaries, map => ({ ...map, ...got }))
      await $.store.set('summaries', all)
    }
  } finally {
    summarizing = false
  }
}

export const register: Register = on => {
  // Agent types already written this load: `agent.offer` fires per listing, so only a new one writes.
  const offeredNames = new Set<string>()

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'skill-shelf',
      description: 'Show the skills, commands, agents and MCP tools you have that never fire on their own',
      // Opening the pane does not depend on the turn, so it need not wait for one to end.
      immediate: true,
    })
    const loaded: Record<string, Usage> = {}
    for (const key of await $.store.keys()) {
      if (!key.startsWith('use:')) continue
      const value = await $.store.get(key)
      if (isUsage(value)) loaded[key.slice(4)] = value
    }
    await update($, usage, map => ({ ...loaded, ...map }))
    const stored = await $.store.get('skills')
    if (Array.isArray(stored)) await update($, skills, names => [...new Set([...stored.filter(s => typeof s === 'string'), ...names])])
    let start = await $.store.get('since')
    if (typeof start !== 'number') {
      start = await $.clock.now()
      await $.store.set('since', start)
    }
    await update($, since, () => start as number)
    const kept = await $.store.get('summaries')
    if (typeof kept === 'object' && kept !== null) {
      const ok = Object.fromEntries(Object.entries(kept).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      await update($, summaries, map => ({ ...ok, ...map }))
    }
    await build($)
    void summarizeMissing($).catch(() => undefined)

    return next(e)
  })

  // token-weather's launcher buttons: a press writes token-weather/launch, and the mod that owns the
  // pane opens it here. Read at run time, so this mod needs no dependency on token-weather.
  on('state.set', async ($, e, next) => {
    const done = await next(e)
    if (launchTarget(e) === 'skill-shelf') {
      await build($)
      const opened = await $.ui.open({ id: PANE, title: TITLE })
      if (!opened.isPlaced) await $.ui.toast(`Skill shelf could not be shown: ${opened.reason}`)
    }
    return done
  }).catch(async ($, e, next) => {
    if (launchTarget(e) === 'skill-shelf') await $.ui.toast('Skill shelf could not be opened from the launcher; try /skill-shelf.')
    return next(e)
  })

  on('command.run', { command: 'skill-shelf' }, async $ => {
    await build($)
    const { isPlaced } = await $.ui.open({ id: PANE, title: TITLE })

    return { text: isPlaced ? 'Skill shelf opened.' : 'Skill shelf could not be placed: no surface draws panes here.' }
  })

  on('command.run', async ($, e, next) => {
    if (e.command === OWN) return next(e)
    const ran = await next(e)
    await bump($, slashId(e.command), PERSON.has(e.origin.kind) ? 'manual' : 'auto')

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    await bump($, `tool:${e.tool}`, 'auto')
    if (e.tool === 'Skill') {
      const name = e.skill.replace(/^\//, '')
      await learnSkill($, name)
      await bump($, slashId(name), 'auto')
    } else if (e.tool === 'Agent') {
      await bump($, `agent:${e.subagent_type ?? 'general-purpose'}`, 'auto')
    }

    return ran
  }).catch(($, e, next) => next(e))

  // A skill's own file is a SKILL.md; a built-in skill has none. A command's `.md` is neither.
  on('skill.prompt', async ($, e, next) => {
    if (e.source === 'built-in' || /SKILL\.md$/i.test(e.path ?? '')) await learnSkill($, e.skill)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.offer', async ($, e, next) => {
    if (!offeredNames.has(e.agent)) {
      offeredNames.add(e.agent)
      const item = agentItem(e.agent, e.description, e.source)
      await update($, agents, list => [...list.filter(a => a.name !== e.agent), item])
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    if (PERSON.has(e.origin.kind)) await follow($, e.text)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    await follow($, box.text)

    return box
  }).catch(($, e, next) => next(e))

  on('prompt.change', async ($, e, next) => {
    if (e.origin.kind !== 'plugin') await follow($, e.text)

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    // Mobile draws no text field: there the shelf shows without the search box.
    // Decided by the surface, not by the table's keys: the table may carry more than the surface draws.
    const Input = e.surface !== 'mobile' && 'Input' in table ? table.Input : undefined
    const q = await read($, query)
    const searching = q.trim() !== ''
    const cat = await read($, catalog)
    const counts = await read($, usage)
    const hookedSet = new Set(await read($, hooked))
    const all = await read($, showAll)
    const text = await read($, prompt)
    const start = await read($, since)
    const now = await $.clock.now()
    const width = Math.max(20, e.props.bodyColumns)

    const items = allItems(cat, await read($, agents))
    const never = items.filter(item => isNeverAuto(item, counts, hookedSet))
    const onShelf = items.filter(item => all || (!item.isBuiltin && isNeverAuto(item, counts, hookedSet)))
    const shown = onShelf.filter(item => matchesQuery(item, q))
    // Matches the current view hides (built in, or started by Claude): counted so the search can say where they are.
    const hiddenMatches = searching && !all ? items.filter(item => matchesQuery(item, q)).length - shown.length : 0
    const picks = suggest(text, items.filter(item => !item.isBuiltin), counts, hookedSet)

    const launch = async (item: ShelfItem) => {
      const draft = (await $.prompt.read()).text
      const filled = await $.prompt.fill({ text: launchText(item, draft), mode: 'replace' })
      if (!filled.isFilled) await $.ui.toast(`Could not put ${item.name} in the prompt${filled.refusal ? ` (${filled.refusal})` : ''}.`)
    }
    // Shown only when there is something to say: "you 2× · last 2d ago", "Claude 5×, you 1× · last 1h ago · built in".
    const meta = (item: ShelfItem) => {
      const use = counts[item.id]
      const parts: string[] = []
      if (use && use.auto + use.manual > 0) {
        const who = [use.auto > 0 ? `Claude ${use.auto}×` : '', use.manual > 0 ? `you ${use.manual}×` : ''].filter(Boolean)
        parts.push(who.join(', '), `last ${ago(use.last, now)}`)
      }
      if (hookedSet.has(item.id)) parts.push('named in a hook')
      if (all && item.isBuiltin) parts.push('built in')
      return parts.join(' · ')
    }
    // The terminal draws a plain Button as its label alone, so the name is the control there.
    // Desktop and VS Code draw every Button as a filled chip, so the name stays text and a small Use button
    // leads the line: one wrapping row, like the Match/Show/Refresh row, with the buttons lined up on the left.
    const gui = e.surface !== 'terminal'
    const sums = await read($, summaries)
    const nameOf = (item: ShelfItem) => (item.kind === 'skill' || item.kind === 'command' ? `/${item.name}` : item.name)
    const row = (item: ShelfItem, prefix: string) => {
      const id = `${prefix}${item.id}`
      const info = meta(item)
      // Only the full list mixes in items Claude starts itself, so only there is the tag news.
      const tagged = all && isNeverAuto(item, counts, hookedSet)
      return (
        <Box key={`row:${id}`} flexDirection="column">
          <Box key={`line:${id}`} flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1}>
            {gui ? (
              <Button key={id} dimColor onPress={() => launch(item)}>
                Use
              </Button>
            ) : (
              <Button key={id} plain onPress={() => launch(item)}>
                <Text bold>{nameOf(item)}</Text>
              </Button>
            )}
            {gui && (
              <Text weight="semibold">
                {nameOf(item)}
              </Text>
            )}
            {tagged && (
              <Text color="suggestion" size="caption">
                manual only
              </Text>
            )}
            {info !== '' && (
              <Text dimColor size="caption">
                {info}
              </Text>
            )}
          </Box>
          {item.description !== '' && (
            <Box paddingLeft={2}>
              <Text dimColor size="footnote" wrap="wrap">
                {sums[hashText(item.description)] ?? item.description}
              </Text>
            </Box>
          )}
        </Box>
      )
    }
    const manual = never.filter(item => !item.isBuiltin).length
    const span = start === 0 ? 'since this load' : ago(start, now) === 'just now' ? 'since just now' : `in the last ${ago(start, now).replace(' ago', '')}`

    return (
      <Box flexDirection="column" gap={1} width={width}>
        <Box flexDirection="column">
          <Text>
            <Text size="heading" weight="semibold">
              {manual} manual-only
            </Text>
            <Text dimColor> skills, commands, agents and tools</Text>
          </Text>
          <Text dimColor>
            {all ? 'Showing everything installed; the manual-only ones are tagged.' : `Claude has not started these on its own ${span}.`}{' '}
            {gui ? 'Use puts one in your prompt.' : 'Press one to put it in the prompt.'}
          </Text>
          <Text dimColor size="caption">
            In the counts, "Claude" = started on its own, "you" = typed by you.
          </Text>
        </Box>
        <Box flexDirection="row" gap={2} flexWrap="wrap">
          <Button key="all" onPress={() => update($, showAll, v => !v)}>
            {all ? 'Show manual only' : 'Show everything'}
          </Button>
          <Button key="refresh" onPress={() => build($).then(() => summarizeMissing($))}>
            Refresh
          </Button>
        </Box>

        <Box flexDirection="column" gap={1} borderStyle="round" borderColor="suggestion" paddingX={1}>
          <Text bold color="suggestion">
            Suggested for this prompt
          </Text>
          {text.trim() === '' ? (
            <Text dimColor>Start typing a prompt: matching skills show here as you type.</Text>
          ) : picks.length === 0 ? (
            <Text dimColor wrap="truncate-end">
              No manual-only item matches "{text.trim().slice(0, 60)}".
            </Text>
          ) : (
            picks.map(pick => row(pick.item, 'pick:'))
          )}
        </Box>

        {Input && (
          <Box flexDirection="row" gap={2} flexWrap="wrap" alignItems="center">
            <Input
              key="search"
              label="Search"
              placeholder="name or description"
              value={q}
              submitLabel="filter"
              onInput={value => update($, query, () => value)}
              onSubmit={value => update($, query, () => value)}
            />
            {searching && (
              <Button key="clear" onPress={() => update($, query, () => '')}>
                Clear
              </Button>
            )}
          </Box>
        )}
        {searching && shown.length === 0 && (
          <Text dimColor wrap="wrap">
            {`No ${all ? '' : 'manual-only '}item matches "${q.trim().slice(0, 60)}".`}
            {hiddenMatches > 0 ? ` ${hiddenMatches} more match${hiddenMatches === 1 ? '' : 'es'} in Show everything.` : ''}
          </Text>
        )}
        {searching && shown.length > 0 && hiddenMatches > 0 && (
          <Text dimColor size="caption">
            {`${hiddenMatches} more match${hiddenMatches === 1 ? '' : 'es'} in Show everything.`}
          </Text>
        )}

        {GROUPS.map(group => {
          const list = shown.filter(item => item.kind === group.kind).sort((a, b) => a.name.localeCompare(b.name))
          if (searching && list.length === 0) return null
          return (
            <Box flexDirection="column" gap={1}>
              <Text weight="semibold">
                {group.label} <Text dimColor>{list.length}</Text>
              </Text>
              {list.length === 0 ? <Text dimColor>None {all ? 'installed' : 'manual only'}.</Text> : list.map(item => row(item, ''))}
            </Box>
          )
        })}

        {cat.notes.length > 0 && (
          <Box flexDirection="column">
            {cat.notes.map(note => (
              <Text dimColor color="warning">
                {note}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
