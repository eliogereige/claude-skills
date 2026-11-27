# outbound-guard

A PreToolUse hook that asks you first, in one plain sentence, before anything leaves your computer or comes onto it.

## What it asks about

- **`⚠ OUTBOUND DATA`**: `git push`, uploads and POSTs, data hidden in URLs, artifacts, cloud sessions and agents, and online tools that publish or send.
- **`⬇ DOWNLOAD`**: clones, package installs, file downloads, container and model pulls.
- **`⬇ DOWNLOAD + RUN`**: code downloaded and run at once (`curl … | bash`, `iwr … | iex`), the riskiest case.
- **`⚠ GUARD CHANGE`**: edits that would change or turn off the guard itself.

Each prompt names the exact piece of the command that triggered it, what it does in plain words, and where the data goes. Reading web pages, local work and the desktop app's own local tools never prompt.

Example: `⚠ OUTBOUND DATA: "git push origin main" uploads your local commits, to the repo's remote. Allow = run once. Deny = block.`

If the hook cannot read its input it denies the call, because there is nothing to show you. Needs Node.js. Tests: `node hooks/outbound-guard.test.js`.

## Install

```bash
/plugin marketplace add eliogereige/claude-skills
/plugin install outbound-guard@claude-skills
```

Part of [claude-skills](https://github.com/eliogereige/claude-skills). MIT license.
