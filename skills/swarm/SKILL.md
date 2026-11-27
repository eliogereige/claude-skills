---
name: swarm
description: >-
  Launch the multi-agent "swarm" WORKFLOW — an org-style
  scope -> research -> plan -> design-debate -> build -> integrate -> audit -> ship
  pipeline with deterministic orchestration and model-tiered agents: Opus for
  reasoning/orchestration, Sonnet for building/research/integration/fixes, Haiku for docs
  and commits, and Fable (falling back to Opus) for the final adversarial audit. Feedback
  loops (design review re-plans, per-subtask retries, audit-driven fixes) and
  dependency-aware parallel waves. NOT a token-saver: it buys wall-clock time and review
  gates at higher cost. Use ONLY when the user types /swarm or explicitly asks for a
  swarm / multi-agent run on a decomposable task (roughly 3+ independent subtasks on
  disjoint files). Its PM fit-gate declines single-concern tasks.
allowed-tools: Workflow, Bash, Read
disable-model-invocation: true
---

# Swarm (dynamic workflow launcher)

`/swarm` is now a **dynamic Workflow**, not a set of instructions you interpret. The control flow
(fan-out, dependency waves, feedback loops, model routing) is deterministic JavaScript; every unit
of *thinking* is a background subagent. This launcher just starts it.

**Isolation:** builders each work in their own **git worktree** on a fresh branch, merge in their
dependency branches, and commit; an integrator merges every branch back onto a dedicated
`swarm/integration-*` branch (in its own worktree) and runs checks there. The user's working tree
is never touched — the swarm hands back the integration branch to merge when ready.

## What to do when invoked

1. Treat everything the user wrote after `/swarm` as the **task**. If it's empty, ask them what the
   swarm should do, then stop.
2. Call the **Workflow** tool with the task passed through as `args`. The script ships with this
   skill at `scripts/swarm.js`; pass its absolute path, built from this skill's base directory:

   ```
   Workflow({
     scriptPath: "<this skill's base directory>/scripts/swarm.js",
     args: "<everything the user typed after /swarm>"
   })
   ```

   (Typing `/swarm` is the user's explicit opt-in to multi-agent orchestration, which is what the
   Workflow tool requires — so it's fine to call it here.)
3. The workflow runs in the **background** (all its subagents run concurrently there) and returns a
   synthesis object when done. **Relay what matters**: the `decision`, per-subtask outcomes + model
   tiers + branches, the merge-back status, the audit verdict and any `unresolvedBlockers`, the
   `ship` docs/commit summary, and especially `integrationBranch` + `nextStep` — the swarm never
   touches the user's working tree, so it hands back an integration branch for them to merge. The
   user can watch live progress with `/workflows`.
4. If it returns `decision: "declined"` (fit-gate) or `decision: "no-task"`, tell the user the
   reason and offer to do the work inline + `/code-review` instead.
5. If it returns `decision: "security_abort"`, surface the finding prominently — nothing was
   committed.

## Model routing (enforced inside the workflow)

| Role | Model |
|---|---|
| PM / architect / domain scientist / design critics / domain-flagged builders | **Opus** (+ deterministic domain floor) |
| Builders / engineers / researchers / integration / fixers | **Sonnet** |
| Documentation / changelog / commit | **Haiku** |
| Final adversarial audit panel | **Fable** (falls back to **Opus** if unavailable) |

## To edit the swarm

Edit `scripts/swarm.js` in this skill's folder (roles, phases, routing, loops), then re-run. To
iterate on a run, re-invoke Workflow with the same `scriptPath` (add `resumeFromRunId` to reuse
cached agents).
