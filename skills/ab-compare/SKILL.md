---
name: ab-compare
description: Runs one prompt twice through headless Claude Code at the same time, once vanilla (safe mode, no CLAUDE.md, skills, plugins, hooks, MCP, agents or memory, like a new PC) and once with the user's full setup, then builds a side-by-side report with both outputs, exact cost and token use, and a breakdown of which hooks, skills, tools, MCP servers, CLAUDE.md and subagents used what share of the tokens. Use when the user types /ab-compare, or asks to "compare with and without my setup", "test this on vanilla Claude Code", "would this be as good on someone else's PC", "how much do my skills/hooks cost", or wants to check a new skill's real value. Do not use to review code or to benchmark two models against each other.
metadata:
  version: 1.1.0
---

# A/B: vanilla Claude Code vs your setup

## Important
- The two runs are real headless sessions billed to the user's account. A big task at opus/high can cost several dollars per arm. Always say the model, effort and per-arm budget before starting, and state the defaults if the user gave none.
- Both arms get the **same** prompt, model, effort and permission mode, each in a new empty folder. Never give one arm extra instructions: that breaks the comparison.
- Vanilla = `claude -p --safe-mode`. Safe mode keeps the login and the built-in tools and bundled skills, so the arm matches a fresh install that's signed in to the same account.
- "Your setup" = `claude -p` with everything at user level (`~/.claude`), plus `--plugin-dir` on the desktop app's account skills folder (`%APPDATA%\Claude\local-agent-mode-sessions\skills-plugin\<org>\<account>`). Without that folder, a terminal `claude -p` only gets a subset of the account's skills and can miss ones the desktop app provides, so it wouldn't match a desktop session. `--desktop-skills none` turns it off; `--desktop-skills DIR` picks another org/account folder. Project-level files are absent because the arm runs in an empty folder.
- The user grades the outputs. Don't declare a winner on quality. Report the measured numbers and what differs between the outputs.

## Step 1: confirm the run
Collect from the request (ask only for what is missing and has no sensible default):
- the prompt (required)
- `--model` (default `opus`), `--effort` (default `high`), `--max-budget-usd` per arm (default 10), `--runs` (default 1; suggest 3 if the user wants to conclude something)
- `--autonomous`: appends one "don't ask questions, make assumptions" sentence to both arms. Suggest it when the user's skills ask clarifying questions (for example superpowers brainstorming), because nobody can answer in headless mode and that arm would just stop
- `--blind`: labels the arms A and B at random, so grading isn't biased. Token attribution stays hidden until `--rerender`

## Step 2: run it in the background
```bash
python "<this skill's base directory>/scripts/ab_run.py" "PROMPT" --model opus --effort high --max-budget-usd 10
```
Use `run_in_background`. A build task takes several minutes. Output goes to `~/ab-runs/<timestamp>-<slug>/` (`--out` to change it). The script prints the folder, each arm's exit code, and a one-line cost/token summary per arm.

## Step 3: report
Open `report.html` for the user (`mcp__ccd_host__open_in_editor`/reveal, or give the path). It has:
- a metrics table: cost, tokens (cache read/write, uncached, output, thinking), turns, duration, subagents, permission denials, the yours ÷ vanilla ratio
- both outputs side by side: the main HTML page in a sandboxed frame, the file list, each final message
- for your setup: **who used the tokens**, grouped by source (plugin, hook, skill, MCP server, CLAUDE.md, auto-memory, agent, built-in, the task itself), with item-level detail
In chat, give the headline numbers, the top 3–5 token consumers from your setup, and anything abnormal: a timeout, an error, permission denials, or a large share of unmatched messages. Then ask the user to grade both outputs.

To grade blind first and see attribution afterwards:
```bash
python "<this skill's base directory>/scripts/ab_run.py" --rerender "<run folder>"
```

## How attribution works (say this when asked how reliable it is)
- `scripts/attribute.py` rebuilds every API call from the run's transcript and labels each piece. Each call's **exact** token counts are split across its pieces by size. Call totals are exact; the split inside a call is a size estimate.
- Caching is applied by position in the prompt: cache reads, then cache writes, then uncached input. Cost uses Anthropic's price ratios (read 0.1×, write 1.25×/2×, output 5× input), scaled to the exact cost Claude Code reported.
- Subagent runs (for example garde-fou) are charged whole to `agent: <type>`.
- Built-in vs added is decided by comparing against the vanilla run of the same A/B.
- It also works on any transcript: `python attribute.py <session.jsonl> [--result result.json] [--vanilla]`.

## Troubleshooting
- **An arm stops early with a question** → rerun with `--autonomous`.
- **`error_max_budget_usd` status** → the arm hit the per-arm cap; raise `--max-budget-usd` or lower effort.
- **Permission denials > 0** → auto mode blocked an action. The arm may have done less; check the final message. `--permission-mode bypassPermissions` exists but only in a throwaway folder, and only if the user asks.
- **"transcript not found"** → the run crashed before writing a session; read `<arm>.stderr.txt` in the run folder.
- **Many unmatched messages** in the attribution note → the transcript format changed in a new Claude Code version; the totals stay exact but the split is less precise.
- **An org skill never fires in your setup** → check the report header shows a desktop skills folder; if it says `no`, the folder wasn't found and only the synced subset loaded.
- **Side effects:** runs in your setup fire your hooks (for example a Stop hook may start reviews). That's part of what is being measured.
