---
name: gemini
description: Ask Google Gemini (Gemini 3.8 Flash, via your own Google AI plan and the Antigravity CLI) a question and bring back its answer. Use when the user types /gemini or asks to "ask Gemini", "get Gemini's take", "second opinion from Gemini", "check this with Gemini", or to compare Claude's answer with Gemini's. Lets you pick effort (low, medium, high) and attach files. Do NOT use for confidential data or documents (it is an external Google service), and do not use it on your own initiative for routine work you can do yourself.
compatibility: Windows, Node 18+, Antigravity CLI (agy) installed and signed in; network access.
metadata:
  version: 1.0.0
---

# Gemini

Sends one prompt to Gemini through Antigravity CLI (`agy`) and prints the answer. The wrapper script runs `agy` in a
fresh empty temp folder in plan mode, so Gemini cannot read or edit the current project; it sees only what you send.

## Critical
- **Confidentiality:** everything sent goes to Google. Never send confidential data or documents. Set
  `GEMINI_BLOCKED_PATTERNS` (comma-separated regexes, e.g. your company or client names) and the script refuses file
  paths and prompts that match; that check is a backstop, not a guarantee, so judge the content yourself.
  `--allow-confidential` exists only for when the user explicitly says so.
- Send only what Gemini needs: attach the specific files with `--file`, never whole folders.
- Gemini's answer is an outside opinion to weigh, not a verdict. Tell the user where you agree or disagree, and why.

## Instructions

### Step 1: Pick effort
Effort is built into the Gemini model id; the script maps it for you.

| `--effort` | Model id | Use for |
|---|---|---|
| `low` | gemini-3.8-flash-low | quick facts, rewording, short checks |
| `medium` | gemini-3.8-flash-medium | everyday questions |
| `high` (default) | gemini-3.8-flash-high | reviews, reasoning, second opinions |

There is no level above `high`. The skill is Gemini Flash only, by design: it has no model option, even though
the plan also lists other models in agy.

### Step 2: Run the script
```bash
node "<this skill's base directory>/scripts/ask-gemini.mjs" --effort high "Your full question, with all context Gemini needs"
```
With files (inlined when small, otherwise placed in a context file Gemini is told to read):
```bash
node "<this skill's base directory>/scripts/ask-gemini.mjs" --file path/to/a.js --file notes.md "Review a.js against notes.md"
```
Options: `--timeout SECONDS` (default 300), `--json` (agy's JSON output), `--dry-run` (show the call without sending).
Long or quote-heavy prompts: pipe them on stdin instead of a positional argument. Run calls longer than ~2 minutes in
the background. A status line `[ask-gemini] model=... exit=... time=...` goes to stderr.

Write the prompt self-contained: Gemini has none of this conversation.

### Step 3: Report
Quote or summarise Gemini's answer, label it as Gemini's (with the model id), and add your own assessment.

## Examples
- User: "Ask Gemini whether this regex handles Unicode" → run with `--effort medium`, include the regex in the
  prompt → report Gemini's answer plus whether you agree.
- User: "Get a second opinion from Gemini on my README" → `--effort high --file README.md "Critique this README..."`.
- User: "Have Gemini review our confidential protocol" → refuse to send it; explain it is confidential and offer
  to review it yourself.

## Troubleshooting
| Error | Cause | Fix |
|---|---|---|
| `agy` not found (exit 3) | CLI not installed | User runs `irm https://antigravity.google/cli/install.ps1 \| iex` in PowerShell |
| Sign-in or auth error from agy | Session expired | User runs `agy` in a terminal and signs in with Google |
| `--effort must be one of` | e.g. `--effort max` | Use low, medium or high |
| Exit 4 "refusing to send" | Confidential path or mention | Do not override unless the user said so |
| Timeout | Long answer | Raise `--timeout`, or lower effort |
| Model not found | Google renamed the Flash ids | Run `agy models` and update `GEMINI_FAMILY` in the script |
