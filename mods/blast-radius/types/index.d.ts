export type BlastLevel = 'low' | 'medium' | 'high'

/** One thing the command would do, in plain words. */
export type BlastFinding = {
  /** What, as an action: "Permanently delete a folder". */
  headline: string
  /** How much: "12 files (3 MB) would be gone." */
  title: string
  /** The details: the paths, the commits. */
  lines: string[]
  level: BlastLevel
  /** Whether it can be taken back. */
  undo: string
}

export type BlastCheck = {
  id: string
  tool: string
  command: string
  /** Claude's own one-line description of the command, when it gave one. */
  description?: string
  /** The risky part of the command, alone. */
  snippet: string
  findings: BlastFinding[]
  /** `quiet`: low risk, so it ran without asking and is only logged. */
  verdict: 'pending' | 'allowed' | 'blocked' | 'quiet'
}

declare module 'claude-code' {
  interface PluginState {
    'blast-radius': {
      current: BlastCheck | null
      recent: BlastCheck[]
      approved: string[]
      /** Files Claude created with the Write tool this session, normalized (lowercase, forward slashes). */
      created: string[]
    }
  }
}
