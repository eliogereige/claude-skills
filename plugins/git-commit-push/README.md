# git-commit-push

A `/git-commit-push` slash command that runs a careful commit-and-push workflow in any repository.

## What it does

1. Detects the project type and runs its checks (lint, type check, syntax checks on changed files), stopping on failure.
2. Writes a Conventional Commits message from the staged diff.
3. Updates `TIMELINE.md` when the repository has one.
4. Stages files by name, never everything: it never runs `git add .` while untracked files are around, and skips local-only paths such as `.env*` and `settings.local.json`.
5. Commits and pushes, then reports what was committed and what was left out.

Run it with `/git-commit-push` when your changes are ready.

## Install

```bash
/plugin marketplace add eliogereige/claude-skills
/plugin install git-commit-push@claude-skills
```

Part of [claude-skills](https://github.com/eliogereige/claude-skills). MIT license.
