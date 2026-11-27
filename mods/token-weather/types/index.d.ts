export type WindowReading = { percent: number; resetsAt: string | null }

export type UsageReading = { fiveHour: WindowReading | null; week: WindowReading | null; at: number }

declare module 'claude-code' {
  interface PluginState {
    'token-weather': {
      fiveHourHistory: number[]
      weekHistory: number[]
      last: UsageReading | null
      isHidden: boolean
      tick: number
      /** The last launcher press: which mod's pane to open; `n` makes each press a new write. agent-tree and skill-shelf hook its `state.set`. */
      launch: { target: 'agent-tree' | 'architect' | 'skill-shelf'; n: number } | null
    }
  }
}
