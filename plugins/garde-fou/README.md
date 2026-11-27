# garde-fou

Two-tier independent review for Claude Code, so finished work gets an outside check before Claude calls it done.

## What's inside

- **`garde-fou-quick`**: a one-minute tripwire subagent. It scans only what the turn changed and claimed, and answers `CLEAN` or `ESCALATE`.
- **`garde-fou`**: a full, read-only reviewer for big deliverables (an analysis, a model setup, a report section, a deck). It reports findings with evidence and a verdict.
- **Stop hook**: when a turn made 3 or more edits or analysis runs with no review verdict after them, it sends Claude back once to run the tripwire. Edits to your own `~/.claude` files and scratch files don't count.

## Use

Add one line to your `CLAUDE.md`: *"Before declaring work finished that changed files or produced results, run the garde-fou-quick tripwire and wait for its verdict; on ESCALATE run the full garde-fou."*

Both agents are read-only (Read, Grep, Glob) and never edit files. The hook needs Node.js.

## Install

```bash
/plugin marketplace add eliogereige/claude-skills
/plugin install garde-fou@claude-skills
```

Part of [claude-skills](https://github.com/eliogereige/claude-skills). MIT license.
