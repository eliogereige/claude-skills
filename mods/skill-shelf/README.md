# skill-shelf

A `/skill-shelf` pane listing the skills, commands, agents and MCP tools you have installed that never fire on their own.

## What it shows

- Everything Claude has not started by itself, grouped by kind, with how often you and Claude used each one.
- A search box that filters by name or description.
- Suggestions that follow the prompt you are typing, so a forgotten skill shows up when it fits.
- One-press launch: puts the skill or command in your prompt box.
- Long descriptions summarised in a few lines.

A mod is a Claude Code plugin with a hooks module that draws its own UI. It needs a Claude Code version where mods load by default (2.1.287 or later).

## Install

```bash
/plugin marketplace add eliogereige/claude-skills
/plugin install skill-shelf@claude-skills
```

Part of [claude-skills](https://github.com/eliogereige/claude-skills). MIT license.
