# agent-tree

A live tree of the agents in your Claude Code session, shown in a side pane.

## What it shows

Who started whom, each agent's model and effort, status, task, tokens, tools and running time. Open it with `/agent-tree`.

## Architect

`/architect` opens a canvas where you lay out an agent team (roles, models, effort, hand-offs, reviewers and resources such as MCP servers or CI), then launch it. The design goes to Claude as one prompt, and the tree shows the run live.

A mod is a Claude Code plugin with a hooks module that draws its own UI. It needs a Claude Code version where mods load by default (2.1.287 or later).

## Install

```bash
/plugin marketplace add eliogereige/claude-skills
/plugin install agent-tree@claude-skills
```

Part of [claude-skills](https://github.com/eliogereige/claude-skills). MIT license.
