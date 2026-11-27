import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentRule, CoachView, Level, Mode } from '../types'
import { DEFAULT_POLICY, describeCall, describeRule, parseRule, route, sanitizePolicy } from './policy'
import { isWorthAsking, LEVELS, neighbour, parseLevel, suggest } from './suggest'

// Before a prompt runs: when it clearly needs a different effort level than the session's
// (low for "thanks" or a quick question, xhigh for a big multi-step job), it asks, in the
// app's own dialog, and applies the answer to that prompt's turn only. It also gives each
// subagent type the model and effort the person's policy names. /effort-coach opens a pane
// with all of it; /effort-coach ask | auto | off, /effort-coach agents ... change it.

const PANE = 'effort-coach'
const view = atom(
  { plugin: 'effort-coach', key: 'view' } as const,
  { mode: 'ask', isMuted: false, sessionEffort: null, turnLevel: null, policy: DEFAULT_POLICY, reroutes: [] } as CoachView,
  { shape: 'view-1' },
)

export const CACHE_NOTE =
  'Cache: per the Claude API docs, changing effort mid-conversation invalidates the cached messages (system prompt and tools stay cached), so a one-prompt switch can cost two cache rebuilds, the switch and the switch back. Whether Claude Code sends effort in a way that avoids this is not known. Subagent rules do not touch the main conversation’s cache.'

const HELP = [
  '/effort-coach: open the pane',
  '/effort-coach ask | auto | off: ask before a prompt that clearly needs another effort, switch on its own, or never',
  '/effort-coach agents: list the subagent rules',
  '/effort-coach agents <type> [haiku|sonnet|opus|fable] [low|medium|high|xhigh|max] [force]: set a rule for that exact subagent_type. It applies when the Agent call names no model/effort, and then also overrides the agent definition’s own model/effort and any default subagent model; force overrides what the call named too. A fork is never changed.',
  '/effort-coach agents <type> off: remove a rule',
  '/effort-coach agents reset: back to the defaults (Explore and claude-code-guide on haiku/low)',
].join('\n')

let pending: Level | undefined // the level chosen for the prompt about to run
let turnEffort: { turnId: string; level: Level } | undefined

const KNOWN_TYPES = ['general-purpose', 'Explore', 'Plan', 'claude-code-guide', 'statusline-setup', 'claude', 'garde-fou', 'garde-fou-quick']

const HUMAN = new Set(['composer', 'bridge', 'sdk']) // a person's prompt, not a task's or a schedule's

/** One line for /effort-coach's own replies. */
const summary = (v: CoachView) => {
  const effort = v.turnLevel !== null ? `${v.turnLevel} (this prompt; session ${v.sessionEffort ?? '?'})` : (v.sessionEffort ?? '?')
  const rules = Object.keys(v.policy).length
  return `effort ${effort} · coach ${v.isMuted ? 'muted' : v.mode} · ${rules} subagent rule${rules === 1 ? '' : 's'}, ${v.reroutes.length} rerouted`
}

// The app already shows the session's model and effort, so the status line is used only
// while the coach is acting: a per-prompt level in force. Everything else is in the pane.
const statusText = (v: CoachView) => (v.turnLevel === null ? undefined : `effort → ${v.turnLevel} (this prompt)`)

/** Writes the view and sets the status line from what was written. */
async function change($: EngineInterface, fn: (v: CoachView) => CoachView) {
  await update($, view, fn)
  $.ui.status(statusText(await read($, view)))
}

async function setPolicy($: EngineInterface, policy: Record<string, AgentRule>) {
  await $.store.set('agents', policy)
  await change($, v => ({ ...v, policy }))
}

/** A pane press: changes the policy as it stands now, not as it was drawn. */
async function editPolicy($: EngineInterface, fn: (policy: Record<string, AgentRule>) => Record<string, AgentRule>) {
  await setPolicy($, fn((await read($, view)).policy))
}

const without = (policy: Record<string, AgentRule>, type: string) =>
  Object.fromEntries(Object.entries(policy).filter(([t]) => t !== type))

const toggledForce = ({ force, ...rule }: AgentRule): AgentRule => (force === true ? rule : { ...rule, force: true })

async function setMode($: EngineInterface, mode: Mode) {
  await $.store.set('mode', mode)
  await change($, v => ({ ...v, mode, isMuted: false }))
}

/** A prompt the person sent: suggest a level if it clearly needs one, and ask (or not). */
async function coach($: EngineInterface, text: string) {
  pending = undefined
  const v = await read($, view)
  const current = v.sessionEffort
  if (v.mode === 'off' || v.isMuted || current === null) return
  const advice = suggest(text)
  if (advice === null || !isWorthAsking(advice, current)) return
  if (v.mode === 'auto') {
    pending = advice.level
    $.ui.toast(`effort ${advice.level} for this prompt (${advice.why})`)
    return
  }
  const alt = neighbour(advice.level, current)
  const use = `Use ${advice.level}`
  const useAlt = alt === null ? undefined : `Use ${alt}`
  const keep = `Keep ${current}`
  const mute = 'Stop asking this session'
  const answer = await $.ui
    .ask(
      `This looks like ${advice.why} (now ${current}; Other takes any level name; a one-prompt switch may cost a prompt-cache rebuild each way). Which effort for this prompt only?`,
      { header: 'Effort', options: [use, ...(useAlt === undefined ? [] : [useAlt]), keep, mute] },
    )
    .catch(() => keep) // dismissed, or no one to ask: as it was
  if (answer === use) pending = advice.level
  else if (useAlt !== undefined && answer === useAlt) pending = alt ?? undefined
  else if (answer === mute) await change($, s => ({ ...s, isMuted: true }))
  else if (answer !== keep) {
    // Typed under "Other": one level name, any of the five.
    const typed = parseLevel(answer)
    if (typed === null) $.ui.toast(`"${answer.slice(0, 60)}" names no single level (${LEVELS.join(', ')}): kept ${current}`)
    else if (typed !== current) {
      pending = typed
      $.ui.toast(`effort ${typed} for this prompt`)
    }
  }
}

/** /effort-coach agents ... */
async function agentsCommand($: EngineInterface, words: string[]): Promise<string> {
  const { policy } = await read($, view)
  const [typed, ...rest] = words
  if (typed === undefined) {
    const rows = Object.entries(policy).map(([t, r]) => `  ${t} → ${describeRule(r)}`)
    return rows.length === 0 ? 'No subagent rules: every subagent runs as Claude asks.' : `Subagent rules:\n${rows.join('\n')}`
  }
  if (typed.toLowerCase() === 'fork') return 'Not changed: a fork always runs on the parent’s model and effort, so a rule for it could never apply.'
  // subagent_type matches exactly: "explore" is taken as the known "Explore", and said so.
  const known = [...Object.keys(policy), ...Object.keys(DEFAULT_POLICY), ...KNOWN_TYPES]
  const type = known.find(k => k.toLowerCase() === typed.toLowerCase()) ?? typed
  const renamed = type === typed ? '' : ` (taken as ${type})`
  if (typed.toLowerCase() === 'reset' && rest.length === 0) {
    await setPolicy($, DEFAULT_POLICY)
    return `Subagent rules reset: ${Object.entries(DEFAULT_POLICY).map(([t, r]) => `${t} → ${describeRule(r)}`).join('; ')}`
  }
  if (rest.length === 1 && rest[0]?.toLowerCase() === 'off') {
    if (policy[type] === undefined) return `No rule for ${type}. Rules: ${Object.keys(policy).join(', ') || 'none'}`
    await setPolicy($, without(policy, type))
    return `Rule for ${type} removed${renamed}: it runs as Claude asks.`
  }
  const rule = parseRule(rest)
  if (typeof rule === 'string') return `Not changed: ${rule}.\n${HELP}`
  await setPolicy($, { ...policy, [type]: rule })
  const unknown = known.includes(type) ? '' : `\nNote: "${type}" is not a subagent type this mod knows of; the rule applies only to Agent calls with exactly that subagent_type.`
  return `${type} → ${describeRule(rule)}${renamed}${unknown}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'effort-coach', description: 'Effort coach pane and settings: /effort-coach [ask|auto|off|agents ...]' })
    const saved = await $.store.get('mode')
    const mode: Mode = saved === 'ask' || saved === 'auto' || saved === 'off' ? saved : 'ask'
    const stored = await $.store.get('agents')
    let policy = DEFAULT_POLICY
    if (stored !== undefined) {
      const clean = sanitizePolicy(stored)
      policy = clean.policy
      if (clean.dropped.length > 0) $.ui.log(`effort-coach: ignored malformed subagent rules for ${clean.dropped.join(', ')}`)
    }
    await change($, v => ({ ...v, mode, policy }))

    return next(e)
  })

  on('command.run', { command: 'effort-coach' }, async ($, e) => {
    const words = e.args.trim().split(/\s+/).filter(w => w !== '')
    const first = words[0]?.toLowerCase()
    if (first === undefined) {
      const opened = await $.ui.open({ id: PANE, title: 'Effort coach' })
      const v = await read($, view)
      return { text: `${summary(v)}${opened.isPlaced ? '' : ` (pane not shown: ${opened.reason})`}\n${HELP}\n${CACHE_NOTE}` }
    }
    if (first === 'ask' || first === 'auto' || first === 'off') {
      await setMode($, first)
      return { text: summary(await read($, view)) }
    }
    if (first === 'agents') return { text: await agentsCommand($, words.slice(1)) }
    return { text: `${first === 'help' ? '' : `Unknown: "${words.join(' ')}".\n`}${HELP}\n${CACHE_NOTE}` }
  })

  on('prompt.submit', async ($, e, next) => {
    // A prompt typed over a running turn is not coached: the level would land on whichever turn starts next.
    if (HUMAN.has(e.origin.kind) && e.turnId === undefined) await coach($, e.text)

    return next(e)
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const { policy } = await read($, view)
    const routed = route(e, policy)
    if (!routed.isChanged) return next(e)
    const ran = await next({
      ...e,
      ...(routed.model !== undefined && { model: routed.model }),
      ...(routed.effort !== undefined && { effort: routed.effort }),
    })
    // Logged once the call went through: what was asked of the Agent tool, which a session-wide
    // subagent model setting may still override (that is not visible from here).
    if (ran.deny === undefined) {
      const now = new Date()
      const reroute = {
        at: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
        type: routed.type,
        description: e.description.slice(0, 60),
        from: describeCall(e.model, e.effort),
        to: describeCall(routed.model, routed.effort),
      }
      await change($, v => ({ ...v, reroutes: [...v.reroutes, reroute].slice(-20) }))
      $.ui.toast(`${reroute.type} subagent → ${reroute.to}`)
    }

    return ran
  })

  on('turn.start', async ($, e, next) => {
    // The main loop's turns only: a subagent's turn must neither take nor clear the prompt's level.
    if (e.agentId !== undefined) return next(e)
    // The level chosen for this prompt holds for this turn only.
    turnEffort = pending === undefined ? undefined : { turnId: e.turnId, level: pending }
    pending = undefined
    const turnLevel = turnEffort?.level ?? null
    if ((await read($, view)).turnLevel !== turnLevel) await change($, v => ({ ...v, turnLevel }))

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && typeof e.effort === 'string') {
      const seen = e.effort
      if ((await read($, view)).sessionEffort !== seen) await change($, v => ({ ...v, sessionEffort: seen }))
    }
    if (e.agentId === undefined && turnEffort !== undefined && e.turnId === turnEffort.turnId) return yield* next({ ...e, effort: turnEffort.level })

    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (turnEffort !== undefined && e.turnId === turnEffort.turnId) {
      turnEffort = undefined
      await change($, v => ({ ...v, turnLevel: null }))
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const v = await read($, view)
    const rules = Object.entries(v.policy)

    return (
      <Box flexDirection="column">
        <Text bold>Main session</Text>
        <Text>
          Effort: {v.sessionEffort ?? 'not seen yet (after your first prompt)'}
          {v.turnLevel !== null ? ` · this prompt: ${v.turnLevel}` : ''}
        </Text>
        <Text>Coach: {v.isMuted ? `${v.mode}, muted this session` : v.mode}</Text>
        <Box flexDirection="row" gap={1}>
          {(['ask', 'auto', 'off'] as const).map(m => (
            <Button key={`mode:${m}`} label={m} variant={v.mode === m && !v.isMuted ? 'primary' : 'secondary'} onPress={() => void setMode($, m)} />
          ))}
        </Box>
        <Text> </Text>
        <Text bold>Subagents</Text>
        <Text dimColor>A rule applies when Claude's Agent call names no model/effort (over the agent's own default); force overrides what the call named too.</Text>
        {rules.length === 0 && <Text dimColor>No rules: every subagent runs as Claude asks.</Text>}
        {rules.map(([type, rule]) => (
          <Box key={`rule:${type}`} flexDirection="row" gap={1}>
            <Text>
              {type} → {describeRule(rule)}
            </Text>
            <Button
              key={`force:${type}`}
              label={rule.force === true ? 'unforce' : 'force'}
              onPress={() => void editPolicy($, p => (p[type] === undefined ? p : { ...p, [type]: toggledForce(p[type]) }))}
            />
            <Button key={`remove:${type}`} label="remove" onPress={() => void editPolicy($, p => without(p, type))} />
          </Box>
        ))}
        <Button key="reset" label="reset to defaults" onPress={() => void setPolicy($, DEFAULT_POLICY)} />
        <Text dimColor>{'Add or change: /effort-coach agents <type> [model] [level] [force]'}</Text>
        <Text> </Text>
        <Text bold>Rerouted this session ({v.reroutes.length}, as asked of the Agent tool)</Text>
        {v.reroutes.length === 0 && <Text dimColor>None yet.</Text>}
        {v.reroutes
          .slice(-8)
          .reverse()
          .map(r => (
            <Text>
              {r.at} {r.type} “{r.description}” {r.from} → {r.to}
            </Text>
          ))}
        <Text> </Text>
        <Text dimColor>{CACHE_NOTE}</Text>
      </Box>
    )
  })
}
