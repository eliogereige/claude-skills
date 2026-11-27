export type AgentStatus = 'running' | 'done' | 'stopped' | 'failed'

export type AgentNode = {
  id: string
  parentId: string | null
  /** The agent's name, else the Agent call's short description, else its type. */
  name: string
  /** Agent type, with `fork`, `workflow` and `bg` (background) noted. */
  kind: string
  /** Pretty model name ("Opus 5.5"); '' until known. */
  model: string
  /**
   * Effort level ("high") or budget ("32k budget"); '' while unknown,
   * 'none' once a request was seen without one (a model that takes none).
   */
  effort: string
  /** Where `effort` came from: the model request itself, or the Agent call's argument. */
  effortFrom: '' | 'request' | 'asked'
  /** One line: the Agent call's description, or the prompt's first sentence. */
  summary: string
  /** The prompt, capped at PROMPT_CAP characters. */
  prompt: string
  /** The prompt's full length, so a capped one says so. */
  promptChars: number
  status: AgentStatus
  startedAt: number
  endedAt: number | null
  /** Time of finished runs, in ms: idle gaps between a turn's end and a resume count for nothing. */
  activeMs: number
  /** When the current run began; 0 while not running. */
  runAt: number
  /** Which run history its ETA draws on: the subagent type, or 'main' for the session. */
  etaKey: string
  /** Context size at the latest model request: input + cache read + cache write tokens. */
  ctx: number
  /** Output tokens of finished turns. */
  out: number
  /** Output tokens of the current turn's finished requests, folded into `out` at turn end. */
  turnOut: number
  tools: number
}

/** What one agent did beyond counts: skills it loaded, files it touched, what it returned. */
export type AgentWork = {
  skills: string[]
  /** In first-touch order; a later op on the same path replaces the earlier one. Deletes come from shell commands, best effort. */
  files: { path: string; op: 'created' | 'edited' | 'deleted' }[]
  /** The subagent's final answer, capped at OUTPUT_CAP characters ('' for the main session). */
  output: string
  outputChars: number
}

export type FastState = 'on' | 'off' | 'cooldown' | 'unknown'

/** Agent id ('main' for the session) → resource name ("MCP github", "gh", "web") → calls. */
export type ResourceCounts = { [agentId: string]: { [resource: string]: number } }

/** A card's job in a designed architecture: an agent, or a resource agents use. */
export type ArchRole =
  | 'orchestrator' | 'researcher' | 'crawler' | 'builder' | 'doer' | 'tester'
  | 'reviewer' | 'judge' | 'variant' | 'helper'
  | 'mcp' | 'rag' | 'cli' | 'cicd'

export type ArchNode = {
  id: string
  label: string
  role: ArchRole
  /** Agent tool model alias; 'inherit' leaves it to the agent's default. */
  model: 'inherit' | 'opus' | 'sonnet' | 'haiku' | 'fable'
  /** '' leaves effort unset. */
  effort: '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** What this agent must achieve, or what this resource is (server name, index, command). */
  objective: string
  x: number
  y: number
}

/** then: runs after; review: checks the other's output, may send it back; uses: agent uses a resource. */
export type ArchEdge = { from: string; to: string; kind: 'then' | 'review' | 'uses' }

export type ArchDesign = {
  name: string
  goal: string
  nodes: ArchNode[]
  edges: ArchEdge[]
  nextId: number
}

declare module 'claude-code' {
  interface PluginState {
    'agent-tree': {
      agents: Shaped<AgentNode[]>
      root: Shaped<AgentNode>
      now: number
      costUsd: number | null
      collapsed: string[]
      expanded: string[]
      /** The pane minimized to its header line. */
      compact: boolean
      /** What each agent reached outside itself (MCP server, CLI, web, files), by agent id. */
      resources: ResourceCounts
      /** Lengths in ms of runs that finished well, by `etaKey`, newest last; kept across sessions in `$.store`. */
      runHistory: Record<string, number[]>
      /** Fast mode as the desktop app last reported it for this session; `unknown` where it cannot be asked. */
      fast: { state: FastState; why: string; checkedAt: number }
      /** The Architect pane's design being edited, its selection and a pending link. */
      design: ArchDesign
      archSelected: string | null
      archLink: { from: string; kind: ArchEdge['kind'] } | null
      /** The Architect's last word to the person: what a press did, or why it did nothing. */
      archNote: string
      /** Bookkeeping updates that threw: how many, and the last one's place and message. */
      errors: { count: number; last: string }
      /** Agent id ('main' for the session) → what it did. */
      work: Record<string, AgentWork>
    }
  }
}
