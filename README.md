<div align="center">

# claude-skills

**Agent skills, subagents, hooks and mods for Claude Code.**
Independent review gates, an upload/download guard, document conversion, Gemini second opinions,
a multi-agent swarm, and live status mods.

[![Agent Skills](https://img.shields.io/badge/Agent_Skills-spec_compliant-8A2BE2?style=flat-square)](https://agentskills.io)
[![Claude Code plugin marketplace](https://img.shields.io/badge/Claude_Code-plugin_marketplace-d97757?style=flat-square)](https://code.claude.com/docs/en/plugins)
[![License: MIT](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)](LICENSE)
[![CI](https://github.com/eliogereige/claude-skills/actions/workflows/validate.yml/badge.svg)](.github/workflows/validate.yml)

`8 skills` · `2 subagents` · `2 hooks` · `1 command` · `5 mods`

</div>

---

## Install

**As a Claude Code plugin marketplace** (everything, or pick what you want):

```bash
/plugin marketplace add eliogereige/claude-skills
/plugin install core-skills@claude-skills
/plugin install garde-fou@claude-skills
```

**Just the skills**, for any agent that reads `SKILL.md` (Claude Code, Codex, Cursor, Gemini CLI, …):

```bash
npx skills add eliogereige/claude-skills
```

**By hand:** copy a folder from `skills/` into `~/.claude/skills/`.

## What's inside

### Skills — [`skills/`](skills/)

| Skill | What it does | Triggers |
|---|---|---|
| [`swarm`](skills/swarm/) | Org-style multi-agent pipeline (scope → research → plan → design debate → build → integrate → audit → ship) with model tiers and review gates. | `/swarm` only |
| [`ab-compare`](skills/ab-compare/) | Runs one prompt twice, on vanilla Claude Code and on your full setup, and reports both outputs side by side with exact cost and which hooks, skills, tools and agents used the tokens. | `/ab-compare`, "compare with and without my setup" |
| [`markitdown`](skills/markitdown/) | Batch-converts a file or folder of PDF, Word, PowerPoint, Excel, Outlook `.msg`, HTML, EPUB and CSV to Markdown with Microsoft markitdown, fully local, into a separate folder with an index. | `/markitdown <path>` only |
| [`md-pdf`](skills/md-pdf/) | Math-heavy Markdown (LaTeX equations, Mermaid, long tables, figures) → LaTeX-typeset PDF, and back: editable Markdown or a full layout map from a PDF. Fully local. | "make a PDF of this .md" |
| [`gemini`](skills/gemini/) | Asks Google Gemini (Flash, through the Antigravity CLI and your own Google plan) for a second opinion, in an empty sandbox folder; refuses anything matching your `GEMINI_BLOCKED_PATTERNS`. | `/gemini`, "ask Gemini" |
| [`gemini-image`](skills/gemini-image/) | Makes images with Nano Banana through your signed-in gemini.google.com in Claude's browser pane, and saves the full-size files. | `/gemini-image`, "make an image with Gemini" |
| [`generate-qr-code`](skills/generate-qr-code/) | Stylized, scannable QR codes (themes, gradients, logos, module shapes, custom eyes), headless, PNG/WEBP. | "make a QR code" |
| [`python-exe-build-pipeline`](skills/python-exe-build-pipeline/) | Python → Windows `.exe` with PyInstaller, icons, code signing and an Inno Setup installer. | "package as exe" |

### Plugins — [`plugins/`](plugins/)

| Plugin | Contents | What it does |
|---|---|---|
| [`garde-fou`](plugins/garde-fou/) | 2 subagents + Stop hook | Two-tier independent review. `garde-fou-quick` is a 1-minute tripwire answering CLEAN/ESCALATE; `garde-fou` is the full read-only reviewer. The Stop hook sends Claude back once when a turn made ≥3 edits/analysis runs with no review verdict after them. |
| [`outbound-guard`](plugins/outbound-guard/) | PreToolUse hook | Asks you first, in one plain sentence, before anything leaves your PC or session (`⚠ OUTBOUND DATA`: pushes, uploads/POSTs, data in URLs, artifacts, cloud sessions and agents, publishing tools) or comes onto it (`⬇ DOWNLOAD`: clones, package installs, file downloads), loudest for code downloaded and run at once (`⬇ DOWNLOAD + RUN`). Reading web pages and local work never prompt. |
| [`git-commit-push`](plugins/git-commit-push/) | slash command | `/git-commit-push`: run checks, write the message from the diff, update `TIMELINE.md` when present, commit, push. |

> **garde-fou** works best with one line in your `CLAUDE.md`: *"Before declaring work finished that changed files or produced results, run the garde-fou-quick tripwire and wait for its verdict; on ESCALATE run the full garde-fou."*
>
> **outbound-guard** asks before `git push` too: click Allow when you publish.
>
> **md-pdf** needs Python with reportlab, matplotlib, pillow and pymupdf, plus MiKTeX or TeX Live for the LaTeX route;
> **markitdown** needs `pip install "markitdown[pdf,docx,pptx,xlsx,xls,outlook]"` (not `[all]`, which pulls in cloud and audio features); **gemini** needs the Antigravity CLI (`agy`) signed in.

### Mods — [`mods/`](mods/)

Mods are Claude Code plugins with a hooks module that draws their own UI. Each folder is a complete plugin.

| Mod | What it shows |
|---|---|
| [`agent-tree`](mods/agent-tree/) | A live tree of the session's agents in the side pane: who started whom, model, status, task, tokens, tools, time. Includes **Architect**, a canvas pane where you lay out an agent team (roles, models, effort, hand-offs, reviewers) and launch it; the tree then shows the run live. |
| [`blast-radius`](mods/blast-radius/) | Catches risky shell commands and explains in plain words what they would destroy, how much, and whether it can be undone. |
| [`effort-coach`](mods/effort-coach/) | Suggests a different effort level for a prompt that needs one; sets each subagent type's model/effort by policy. |
| [`skill-shelf`](mods/skill-shelf/) | A `/skill-shelf` pane of the skills, commands, agents and MCP tools that never fire on their own, with a search box, use counts and one-press launch. |
| [`token-weather`](mods/token-weather/) | A weather forecast of your plan usage above the prompt: 5-hour and weekly windows, sparklines, reset times. |

Try one for a single session: `claude --plugin-dir ./mods/token-weather`.

## Repository layout

```
.claude-plugin/marketplace.json   Claude Code marketplace manifest
skills/<name>/SKILL.md            Agent Skills (agentskills.io format)
plugins/<name>/                   plugins: agents/, hooks/hooks.json, commands/
mods/<name>/                      mods: .claude-plugin/plugin.json + hooks/hooks.json module
scripts/prepublish_scan.py        secret / PII / confidential-term scanner, run in CI
```

## Tests

```bash
node plugins/garde-fou/hooks/garde-fou-stop.test.js
node plugins/outbound-guard/hooks/outbound-guard.test.js
python -I scripts/test_prepublish_scan.py
```

Mod tests use Claude Code's `claude-code/testing` harness.

## Credits

See [NOTICE.md](NOTICE.md). `blast-radius` and `token-weather` are independent implementations of ideas
from Anthropic's example mods.

## License

[MIT](LICENSE)
