export type Level = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Mode = 'ask' | 'auto' | 'off'
export type AgentModel = 'sonnet' | 'opus' | 'haiku' | 'fable'

/** What a subagent type runs on when Claude leaves model/effort unset; `force` overrides what Claude set too. */
export type AgentRule = { model?: AgentModel; effort?: Level; force?: boolean }

/** One Agent call whose model or effort the policy changed. */
export type Reroute = { at: string; type: string; description: string; from: string; to: string }

export type CoachView = {
  mode: Mode
  isMuted: boolean
  /** The session's own level, as seen on its last main-thread request; null before the first. */
  sessionEffort: string | null
  /** The level chosen for the prompt now running, when it differs from the session's. */
  turnLevel: Level | null
  policy: Record<string, AgentRule>
  reroutes: Reroute[]
}

declare module 'claude-code' {
  interface PluginState {
    'effort-coach': { view: Shaped<CoachView> }
  }
}
