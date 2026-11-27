# effort-coach

Suggests a better effort level for a prompt that clearly needs one, and sets the model and effort of each subagent type by your own policy.

## What it does

- When a prompt looks heavy (debugging, architecture, a whole-codebase change) or trivial (thanks, a yes or no), it suggests a different effort level for that prompt only.
- It applies a per-subagent-type policy, for example running search agents on a small model at low effort.
- `/effort-coach` opens a pane to see and edit the policy, and a status line shows the current setting.

A mod is a Claude Code plugin with a hooks module that draws its own UI. It needs a Claude Code version where mods load by default (2.1.287 or later).

## Install

```bash
/plugin marketplace add eliogereige/claude-skills
/plugin install effort-coach@claude-skills
```

Part of [claude-skills](https://github.com/eliogereige/claude-skills). MIT license.
