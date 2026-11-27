---
description: Validate, commit, update TIMELINE, and push
allowed-tools: Bash(*), Read, Write, Edit, Glob, Grep
---

Execute a complete git workflow with quality checks and intelligent project detection. Works in any repository.

## Context

- Current git status: !`git status`
- Current git diff: !`git diff HEAD`
- Current branch: !`git branch --show-current`
- Recent commits: !`git log --oneline -10`

## Phase 1: Validation (sequential — stop on failure)

### 1. Project type detection
Detect the project type and run appropriate checks:
- **Node.js**: `npm run lint` or `npm run eslint` if defined in `package.json`
- **Python**: `flake8`, `pylint`, or `python -m py_compile` on changed files if available
- **TypeScript**: `npx tsc --noEmit` if `tsconfig.json` exists
- **Generic**: basic syntax validation on changed files

### 2. Project-specific pre-commit tasks
- **If `composer.json` exists**: run `composer validate` when composer is available
- **If `Makefile` has `lint` or `check`**: run `make lint` or `make check`
- **If `.pre-commit-config.yaml` exists**: respect configured hooks

### 3. Syntax validation (all projects)
Validate modified/added files before committing:
- **JavaScript/TypeScript**: parse or `tsc --noEmit`
- **HTML**: basic structure validation
- **CSS**: syntax validation
- **JSON**: `JSON.parse`
- **Python**: `python -m py_compile`

Stop and report errors if any step fails.

**Shell note (Windows PowerShell):** use `;` to chain commands, not `&&`.

## Phase 2: Analysis (once, shared)

From staged changes, extract:
- **Files changed** and change type: `feat` / `fix` / `docs` / `style` / `refactor` / `perf` / `test` / `chore`
- **Scope** and **user-visible impact**
- **Key details** for commit message and optional timeline

## Phase 3: Documentation (parallel when applicable)

### A. Git commit message (always)
Conventional Commits format:
```
<type>: <concise summary under 72 chars>

- Bullet points of key changes
- Affected areas/files
```

### B. TIMELINE.md (only when file exists)
If the repo root has `TIMELINE.md`, insert a new entry at the top (after the `---` separator):
```markdown
## YYYY-MM-DD HH:MM UTC

**<One-line bold summary>**

Brief paragraph: what changed, why if non-obvious, affected areas. Plain-text file names only.
```
Skip for trivial changes (typo-only, whitespace-only, lockfile-only bumps).

## Phase 4: Git operations

**CRITICAL: never `git add .`, `git add -A` or `git commit -a` while untracked files are around.** Working trees often hold local-only work (drafts, backups, assets, local config) that must not ship. First read the repo's CLAUDE.md (root or `.claude/`) for its list of local-only paths.

1. Stage tracked changes: `git add -u` (this covers files your build steps changed). Then unstage `.claude/settings.local.json` (`git reset -q -- .claude/settings.local.json`): it is per-machine and never committed, even where it is tracked.
2. Stage new (untracked) files **by name**, only when they clearly belong to this change (e.g. a new page or module the diff references). Never stage paths the repo's CLAUDE.md marks local-only, nor `.env*`, `.mcp.json`, `.claude/launch.json`, backups or archives.
3. If the repo has its own commit script that stages safely, you may use it instead.
4. Verify before committing:
```bash
git status --short
git diff --staged --stat
```
List the untracked files you left out. If a staged path looks local-only, unstage it (`git reset -q -- <path>`) and ask.

Commit with the generated message. Let pre-commit / prepare-commit-msg hooks run normally.

Push:
```bash
git push
```
If the branch has no upstream: `git push -u origin <branch-name>`

## Important rules

1. **Stop on errors** — do not commit if lint/syntax checks fail
2. **Respect git hooks** — never use `--no-verify` unless the user explicitly asks
3. **Never update git config** — no `git config` changes
4. **No force push to main/master** unless explicitly requested
5. **Stage by name, never everything** (see Phase 4); warn about untracked sensitive files (`.env`, credentials)
6. **Commit only when running this command** — user invoked `/git-commit-push` as explicit intent to commit

## Project-type adaptations

### Node.js / JavaScript
- Run ESLint/Prettier if configured
- Ensure `package.json` and lockfile stay in sync

### Static sites (HTML/CSS/JS)
- Validate HTML/CSS on touched files

### Generic
- Basic syntax validation only
- Respect `.pre-commit-config.yaml`

Run phases sequentially. Show output for each step. Proceed only when the current step succeeds.
