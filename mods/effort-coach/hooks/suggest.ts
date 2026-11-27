// How much thinking a prompt looks like it needs, from its words alone: no model call,
// no tokens. Only a clear signal makes a suggestion; most prompts get none.

import type { Level } from '../types'

export type { Level }
export const LEVELS: Level[] = ['low', 'medium', 'high', 'xhigh', 'max']
export const rank = (level: string) => LEVELS.indexOf(level as Level)

const LIGHT = /^(thanks|thank you|thx|ok|okay|cool|nice|great|perfect|yes|no|yep|nope|lol|hi|hello|hey)\b/i
const QUICK = /\b(what is|what's|whats|where is|where's|which|how do i|show me|list|rename|typo|spell|format|quick|remind me|what does)\b/i
const HEAVY = /\b(refactor\w*|architect\w*|design\w*|debug\w*|investigat\w*|root cause|why does|why is|implement\w*|migrat\w*|optimi[sz]\w*|security|audit\w*|review\w*|plan\w*|prove|derive|analy[sz]\w*|benchmark\w*|rewrite|from scratch|end[- ]to[- ]end|across the (code|repo|files)|every file|whole (project|repo|codebase|document|chapter)|literature review|statistic\w*)\b/gi

export type Suggestion = { level: Level; why: string }

/** The level a prompt clearly calls for, or null when nothing stands out. */
export const suggest = (text: string): Suggestion | null => {
  const t = text.trim()
  if (t === '' || t.startsWith('/')) return null // a command, not a prompt
  const words = t.split(/\s+/).length
  const heavy = new Set((t.match(HEAVY) ?? []).map(w => w.toLowerCase())).size
  const hasCode = /```/.test(t)
  if (words <= 6 && LIGHT.test(t)) return { level: 'low', why: 'a quick reply' }
  if (heavy >= 2 || (heavy >= 1 && words > 60) || words > 250 || (hasCode && heavy >= 1)) {
    return { level: 'xhigh', why: 'a big, multi-step job' }
  }
  if (heavy === 1) return { level: 'high', why: 'it needs careful thinking' }
  if (words <= 25 && QUICK.test(t)) return { level: 'low', why: 'a quick question' }
  return null
}

/** Worth asking about: the suggestion is at least two levels from the current one. */
export const isWorthAsking = (suggestion: Suggestion, current: string) => {
  const now = rank(current)
  return now >= 0 && Math.abs(rank(suggestion.level) - now) >= 2
}

/** The level one step from the suggestion toward the current one: the milder alternative. */
export const neighbour = (suggested: Level, current: string): Level | null => {
  const s = rank(suggested)
  const c = rank(current)
  if (s < 0 || c < 0 || s === c) return null
  const next = LEVELS[s + (c > s ? 1 : -1)]
  return next === undefined || next === current ? null : next
}

/** The one level named in text typed under the dialog's "Other"; null when none, or several different ones. */
export const parseLevel = (text: string): Level | null => {
  const named = new Set(text.toLowerCase().match(/\b(xhigh|max|high|medium|low)\b/g) ?? [])
  return named.size === 1 ? ([...named][0] as Level) : null
}
