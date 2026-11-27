export type ShelfKind = 'skill' | 'command' | 'agent' | 'tool'

/** One thing on the shelf. `id` is how its uses are counted (`slash:<name>`, `agent:<name>`, `tool:<name>`). */
export type ShelfItem = {
  id: string
  kind: ShelfKind
  name: string
  description: string
  /** Where it comes from: `builtin`, `plugin`, `user`, `mcp`, or an agent definition's source. */
  source: string
  /** Ships with Claude Code (hidden unless "Show everything"). */
  isBuiltin: boolean
}

/** Uses counted by this mod since `since`: `auto` by the model or a plugin, `manual` typed by the person. */
export type Usage = { auto: number; manual: number; last: number }

export type Catalog = {
  items: ShelfItem[]
  /** How skills were told apart from commands, and anything that could not be read. */
  notes: string[]
  builtAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'skill-shelf': {
      catalog: Shaped<Catalog>
      usage: Shaped<Record<string, Usage>>
      /** Agent types the engine offered the model (`agent.offer`). */
      agents: Shaped<ShelfItem[]>
      /** Names of slash commands known to be skills (folders, the Skill tool, `skill.prompt`). */
      skills: string[]
      /** Ids whose name appears in a settings hook's command. */
      hooked: string[]
      /** The text suggestions are matched against. */
      prompt: string
      showAll: boolean
      /** What the search box holds: filters the lists by name and description. */
      query: string
      /** Model-written summaries of long descriptions, by hashText(description); kept in the store too. */
      summaries: Record<string, string>
      since: number
    }
  }
}
