// Which model and effort a subagent type runs on. A rule fills in what the Agent call left
// unset, which also overrides the agent definition's own model/effort and any default
// subagent model (a call's model takes precedence over both); with `force` it replaces what
// the call named too. No rule: untouched.

import type { AgentModel, AgentRule, Level } from '../types'
import { LEVELS } from './suggest'

export const MODELS: AgentModel[] = ['haiku', 'sonnet', 'opus', 'fable']

/** Read-only search and docs lookups: cheap work that haiku on low does well. */
export const DEFAULT_POLICY: Record<string, AgentRule> = {
  Explore: { model: 'haiku', effort: 'low' },
  'claude-code-guide': { model: 'haiku', effort: 'low' },
}

export type AgentArgs = { subagent_type?: string; model?: AgentModel; effort?: Level }
export type Routed = { type: string; model?: AgentModel; effort?: Level; isChanged: boolean }

/**
 * The Agent call's subagent type. An omitted one is taken as general-purpose, as the Agent
 * tool's description says; not checked against the engine (only `agent.spawn` sees the
 * resolved type), and it matters only if the policy has a general-purpose rule.
 */
export const agentType = (args: AgentArgs) => args.subagent_type ?? 'general-purpose'

/** The model and effort the policy gives this Agent call. */
export const route = (args: AgentArgs, policy: Record<string, AgentRule>): Routed => {
  const type = agentType(args)
  const rule = policy[type]
  // A fork always runs on the parent's model and effort: the tool ignores both there.
  if (rule === undefined || type === 'fork') return { type, model: args.model, effort: args.effort, isChanged: false }
  const model = rule.model !== undefined && (args.model === undefined || rule.force === true) ? rule.model : args.model
  const effort = rule.effort !== undefined && (args.effort === undefined || rule.force === true) ? rule.effort : args.effort
  return { type, model, effort, isChanged: model !== args.model || effort !== args.effort }
}

export const describeRule = (rule: AgentRule) =>
  `${rule.model ?? 'its model'} · ${rule.effort ?? 'its effort'}${rule.force === true ? ' · force' : ''}`

export const describeCall = (model: string | undefined, effort: string | undefined) =>
  `${model ?? 'default'}/${effort ?? 'default'}`

/** `haiku low force` → a rule; an unknown word is an error, never skipped. */
export const parseRule = (words: string[]): AgentRule | string => {
  const rule: AgentRule = {}
  for (const word of words.map(w => w.toLowerCase())) {
    if ((MODELS as string[]).includes(word)) rule.model = word as AgentModel
    else if ((LEVELS as string[]).includes(word)) rule.effort = word as Level
    else if (word === 'force') rule.force = true
    else return `"${word}" is not a model (${MODELS.join(', ')}), a level (${LEVELS.join(', ')}) or "force"`
  }
  if (rule.model === undefined && rule.effort === undefined) return 'name a model, a level, or both'
  return rule
}

/** A stored policy, keeping only well-formed rules; the dropped type names are returned so they can be reported. */
export const sanitizePolicy = (value: unknown): { policy: Record<string, AgentRule>; dropped: string[] } => {
  const policy: Record<string, AgentRule> = {}
  const dropped: string[] = []
  if (typeof value !== 'object' || value === null) return { policy, dropped: ['(the whole stored policy)'] }
  for (const [type, raw] of Object.entries(value)) {
    const r = raw as Record<string, unknown> | null
    const model = r?.model
    const effort = r?.effort
    const isModelOk = model === undefined || (MODELS as unknown[]).includes(model)
    const isEffortOk = effort === undefined || (LEVELS as unknown[]).includes(effort)
    if (r === null || typeof r !== 'object' || !isModelOk || !isEffortOk || (model === undefined && effort === undefined)) {
      dropped.push(type)
      continue
    }
    policy[type] = {
      ...(model !== undefined && { model: model as AgentModel }),
      ...(effort !== undefined && { effort: effort as Level }),
      ...(r.force === true && { force: true }),
    }
  }
  return { policy, dropped }
}
