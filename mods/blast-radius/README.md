# blast-radius

Catches risky shell commands before they run and explains, in plain words, what they would destroy.

## What it does

For commands such as `rm -rf`, `git reset --hard`, `git clean`, force pushes, and deletes inside a OneDrive folder, it says what would be lost, how much, and whether it can be undone, then asks you. Low-risk commands (temporary files, files Claude made this session, nothing to lose) run without asking and are only logged. `/blast-radius` opens a pane with the last 10 checks.

Paths inside WSL, which Windows can't inspect, are flagged as unknown rather than guessed.

A mod is a Claude Code plugin with a hooks module that draws its own UI. It needs a Claude Code version where mods load by default (2.1.287 or later).

## Install

```bash
/plugin marketplace add eliogereige/claude-skills
/plugin install blast-radius@claude-skills
```

Part of [claude-skills](https://github.com/eliogereige/claude-skills). MIT license.
