export const meta = {
  name: 'swarm',
  description:
    'Org-style multi-agent swarm: a PM scopes the mission, researchers gather context, an Opus architect plans, a cross-team design panel debates and revises, model-tiered builders implement disjoint subtasks IN ISOLATED GIT WORKTREES along a dependency graph with review feedback loops, an integrator merges every branch back onto a dedicated integration branch and runs checks, a Fable-led (Opus-fallback) audit panel adversarially verifies, then Haiku documents and (only if asked) commits. Runs in the background.',
  whenToUse:
    'User types /swarm or explicitly asks for a swarm / multi-agent run on a decomposable engineering task in a git repo.',
  phases: [
    { title: 'Intake', detail: 'PM scopes the mission, fit-gate, records git branch/tree state, decides research', model: 'opus' },
    { title: 'Research', detail: 'parallel researchers gather codebase + domain + web context' },
    { title: 'Plan', detail: 'Opus architect decomposes into a disjoint-file dependency graph', model: 'opus' },
    { title: 'Design Review', detail: 'cross-team panel debates the plan; architect revises on high severity', model: 'opus' },
    { title: 'Build', detail: 'model-tiered builders implement in isolated worktrees, in dependency waves, with review feedback loops' },
    { title: 'Integrate', detail: 'integrator merges every subtask branch back onto a dedicated integration branch and runs build/lint/test' },
    { title: 'Audit', detail: 'Fable/Opus adversarial audit panel on the integrated tree; blockers routed back to fixers, then re-audited' },
    { title: 'Ship', detail: 'Haiku writes docs / changelog and (only if asked) commits on the integration branch' },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// Swarm — dynamic, non-linear workflow. Control flow is deterministic JS; every
// unit of *thinking* is a background subagent, routed by intelligence:
//   opus   → PM, architect/planner, scientist, design critics, domain builders
//   sonnet → builders / engineers / researchers / integration / fixers
//   haiku  → documentation, changelog, commit message (cheap mechanical work)
//   fable  → final audit/review  (falls back to opus if fable is unavailable)
//
// Isolation model (worktree + merge-back):
//   • Each builder works in its OWN git worktree on a fresh branch and commits.
//     Dependencies flow by having a builder merge its upstream subtasks' branches
//     into its worktree before starting — so cross-wave data is available without
//     ever mutating the user's working tree during the build.
//   • A single integrator creates a dedicated `swarm/integration-*` worktree off
//     the target branch and merges every subtask branch back in topological order,
//     then runs checks there. Audit / fixers / ship all operate in that worktree.
//   • The user's working tree is never touched; the swarm reports the integration
//     branch + path for the user to merge when ready.
// ─────────────────────────────────────────────────────────────────────────────

const task =
  typeof args === 'string'
    ? args
    : args && (args.task || args.prompt || args.mission)
      ? args.task || args.prompt || args.mission
      : null

if (!task || !String(task).trim()) {
  log('No task text supplied to /swarm. Nothing to do.')
  return { decision: 'no-task', message: 'Provide a task after /swarm, e.g. `/swarm add retry+backoff to every network client under src/net`.' }
}

// ── Deterministic backstops (never trust the model to be the only guard) ──────
function enforceTier(s) {
  const hay = ((s.domain || '') + ' ' + (s.title || '') + ' ' + (s.description || '')).toLowerCase()
  const domainFloor =
    /math|physics|chemistr|numeric|algorithm|crypto|security|secur[ei]|concurren|architect|debug|race condition|floating|calibrat|signal|statistic|thread|lock|kernel/.test(hay)
  if (domainFloor) return 'opus'
  const docLike =
    /(^|[^a-z])(doc|docs|comment|docstring|readme|changelog|timeline|rename|reformat|format|typo|copy edit|license|commit message)([^a-z]|$)/.test(hay)
  const raw = (s.tier || '').toLowerCase()
  if (docLike && (raw === 'haiku' || !raw)) return 'haiku'
  return ['haiku', 'sonnet', 'opus'].includes(raw) ? raw : 'sonnet'
}
const bump = t => (t === 'haiku' ? 'sonnet' : t === 'sonnet' ? 'opus' : 'opus')
const effortFor = tier => (tier === 'opus' ? 'high' : tier === 'haiku' ? 'low' : 'medium')

// Fable-led audit with graceful Opus fallback (honours "fable if available, else opus").
async function auditAgent(prompt, opts) {
  const r = await agent(prompt, { ...opts, model: 'fable' })
  if (r !== null && r !== undefined) return r
  log(`${opts.label || 'audit'}: fable unavailable/failed → retrying on opus`)
  return await agent(prompt, { ...opts, model: 'opus', label: (opts.label || 'audit') + ' (opus-fallback)' })
}

// ── Schemas: structured hand-offs between roles ──────────────────────────────
const BRIEF_SCHEMA = {
  type: 'object',
  required: ['summary', 'goals', 'successCriteria', 'recommendSwarm', 'researchNeeded', 'isGitRepo'],
  properties: {
    summary: { type: 'string' },
    isGitRepo: { type: 'boolean' },
    targetBranch: { type: 'string' },
    treeDirty: { type: 'boolean' },
    goals: { type: 'array', items: { type: 'string' } },
    constraints: { type: 'array', items: { type: 'string' } },
    successCriteria: { type: 'array', items: { type: 'string' } },
    primaryDomain: { type: 'string' },
    commitRequested: { type: 'boolean' },
    researchNeeded: { type: 'boolean' },
    researchTopics: {
      type: 'array',
      items: {
        type: 'object',
        required: ['topic', 'kind'],
        properties: { topic: { type: 'string' }, kind: { type: 'string', enum: ['codebase', 'domain', 'web'] }, why: { type: 'string' } },
      },
    },
    recommendSwarm: { type: 'boolean' },
    recommendReason: { type: 'string' },
  },
}
const RESEARCH_SCHEMA = {
  type: 'object',
  required: ['topic', 'findings'],
  properties: {
    topic: { type: 'string' },
    findings: { type: 'string' },
    keyFacts: { type: 'array', items: { type: 'string' } },
    sources: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
  },
}
const PLAN_SCHEMA = {
  type: 'object',
  required: ['subtasks'],
  properties: {
    approach: { type: 'string' },
    subtasks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'title', 'successCriteria', 'files', 'tier'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          successCriteria: { type: 'string' },
          role: { type: 'string' },
          domain: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          tier: { type: 'string', enum: ['haiku', 'sonnet', 'opus'] },
          dependsOn: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    risks: { type: 'array', items: { type: 'string' } },
    integrationNotes: { type: 'string' },
  },
}
const CRITIQUE_SCHEMA = {
  type: 'object',
  required: ['severity', 'assessment'],
  properties: {
    severity: { type: 'string', enum: ['low', 'medium', 'high'] },
    assessment: { type: 'string' },
    issues: { type: 'array', items: { type: 'object', properties: { about: { type: 'string' }, problem: { type: 'string' }, suggestion: { type: 'string' } } } },
    missingSubtasks: { type: 'array', items: { type: 'string' } },
    fileOverlaps: { type: 'array', items: { type: 'string' } },
    tierCorrections: { type: 'array', items: { type: 'object', required: ['id', 'tier'], properties: { id: { type: 'string' }, tier: { type: 'string', enum: ['haiku', 'sonnet', 'opus'] }, why: { type: 'string' } } } },
  },
}
const WORK_SCHEMA = {
  type: 'object',
  required: ['status', 'summary'],
  properties: {
    id: { type: 'string' },
    status: { type: 'string', enum: ['done', 'done_with_concerns', 'blocked', 'needs_context'] },
    summary: { type: 'string' },
    branch: { type: 'string' },
    committed: { type: 'boolean' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    concerns: { type: 'array', items: { type: 'string' } },
    commitMessage: { type: 'string' },
  },
}
const REVIEW_SCHEMA = {
  type: 'object',
  required: ['verdict'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'changes_requested', 'reject', 'security_abort'] },
    reason: { type: 'string' },
    findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string' }, issue: { type: 'string' }, location: { type: 'string' }, fix: { type: 'string' } } } },
  },
}
const INTEGRATION_SCHEMA = {
  type: 'object',
  required: ['status', 'summary'],
  properties: {
    status: { type: 'string', enum: ['clean', 'conflicts', 'checks_failed', 'no_checks_available'] },
    integrationBranch: { type: 'string' },
    worktreePath: { type: 'string' },
    mergedBranches: { type: 'array', items: { type: 'string' } },
    failedMerges: { type: 'array', items: { type: 'string' } },
    checksRun: { type: 'array', items: { type: 'string' } },
    issues: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
  },
}
const AUDIT_SCHEMA = {
  type: 'object',
  required: ['lens', 'verdict'],
  properties: {
    lens: { type: 'string' },
    verdict: { type: 'string', enum: ['pass', 'issues', 'blocker'] },
    findings: { type: 'array', items: { type: 'object', properties: { severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] }, issue: { type: 'string' }, location: { type: 'string' }, recommendation: { type: 'string' } } } },
    summary: { type: 'string' },
  },
}
const SHIP_SCHEMA = {
  type: 'object',
  required: ['summary'],
  properties: {
    docsUpdated: { type: 'array', items: { type: 'string' } },
    commitMessage: { type: 'string' },
    committed: { type: 'boolean' },
    summary: { type: 'string' },
  },
}

// ── Helpers to merge panel outputs ───────────────────────────────────────────
const SEV = { low: 0, medium: 1, high: 2 }
function mergeCritiques(panel) {
  let severity = 'low'
  const issues = [], tierCorrections = [], missingSubtasks = [], fileOverlaps = []
  for (const c of panel) {
    if (!c) continue
    if ((SEV[c.severity] ?? 0) > SEV[severity]) severity = c.severity
    if (c.issues) issues.push(...c.issues)
    if (c.tierCorrections) tierCorrections.push(...c.tierCorrections)
    if (c.missingSubtasks) missingSubtasks.push(...c.missingSubtasks)
    if (c.fileOverlaps) fileOverlaps.push(...c.fileOverlaps)
  }
  return { severity, issues, tierCorrections, missingSubtasks, fileOverlaps }
}
function applyTierCorrections(plan, critique) {
  if (!critique?.tierCorrections) return
  const byId = new Map(plan.subtasks.map(s => [s.id, s]))
  for (const c of critique.tierCorrections) {
    const s = byId.get(c.id)
    if (s && ['haiku', 'sonnet', 'opus'].includes((c.tier || '').toLowerCase())) {
      s.tier = enforceTier({ ...s, tier: c.tier.toLowerCase() })
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 0 — INTAKE (PM, Opus): scope, fit-gate, record git state, decide research
// ═════════════════════════════════════════════════════════════════════════════
phase('Intake')
const brief = await agent(
  `You are the PROGRAM MANAGER for a multi-agent engineering swarm. Scope this mission before any work starts.

MISSION (verbatim from the user):
"""
${task}
"""

Do:
1. Establish git state (do NOT edit anything):
   - \`git rev-parse --is-inside-work-tree\` → set isGitRepo.
   - \`git rev-parse --abbrev-ref HEAD\` → set targetBranch.
   - \`git status --porcelain\` → set treeDirty=true if non-empty.
   Take a quick look at the repo (CLAUDE.md if present, top-level layout) to ground yourself.
2. Write a tight brief: summary, concrete goals, hard constraints, and testable success criteria.
3. Identify the primary domain (e.g. mechanical/web, or a hard domain like math/physics/numerics/security/concurrency).
4. Decide whether up-front RESEARCH is needed and list up to 5 research topics, each tagged kind = codebase | domain | web. Only request research that genuinely de-risks the build.
5. Decide commitRequested: true ONLY if the user's words clearly ask to commit/push. Default false.
6. FIT GATE — set recommendSwarm. This swarm uses isolated git worktrees, so it REQUIRES a git repo (if isGitRepo is false, set recommendSwarm=false). Otherwise a swarm is worth it only when the work splits into ≥3 genuinely independent subtasks on disjoint files, is large enough that parallel speed + review/audit gates beat the overhead, and isn't a single-concern change better done inline. If it fails, set recommendSwarm=false and explain in recommendReason (the caller will do it inline instead).

Return the structured brief.`,
  { label: 'PM: scope + fit-gate', phase: 'Intake', model: 'opus', effort: 'high', agentType: 'general-purpose', schema: BRIEF_SCHEMA },
)

if (!brief) return { decision: 'error', message: 'PM intake agent failed to return a brief.' }
if (brief.isGitRepo === false) {
  return { decision: 'declined', reason: 'Not a git repository — worktree-isolated swarm requires git. Do it inline instead.', brief }
}
if (brief.recommendSwarm === false) {
  log(`Fit gate: swarm declined — ${brief.recommendReason || 'not a swarm-shaped task'}`)
  return { decision: 'declined', reason: brief.recommendReason || 'Task is not swarm-shaped.', brief, advice: 'Do it inline with the right model tier, then run /code-review.' }
}
const targetBranch = brief.targetBranch || 'HEAD'
log(`Mission scoped. Branch=${targetBranch} (${brief.treeDirty ? 'dirty' : 'clean'}). Domain=${brief.primaryDomain || 'general'}. Research=${brief.researchNeeded ? 'yes' : 'no'}. Commit=${brief.commitRequested ? 'yes' : 'no'}.`)

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 1 — RESEARCH (parallel; sonnet, opus for domain): gather context
// ═════════════════════════════════════════════════════════════════════════════
let researchDigest = 'No up-front research was requested.'
if (brief.researchNeeded && brief.researchTopics?.length) {
  phase('Research')
  const topics = brief.researchTopics.slice(0, 5)
  log(`Dispatching ${topics.length} researcher(s).`)
  const research = (
    await parallel(
      topics.map(t => () => {
        const kind = (t.kind || 'codebase').toLowerCase()
        const model = kind === 'domain' ? 'opus' : 'sonnet'
        const agentType = kind === 'codebase' ? 'Explore' : 'general-purpose' // web/domain may need WebSearch/Bash
        return agent(
          `You are a RESEARCHER on an engineering swarm. Investigate ONE topic and report crisp, actionable findings the builders can rely on. Do not edit files.

MISSION CONTEXT: ${brief.summary}
TOPIC (${kind}): ${t.topic}
WHY IT MATTERS: ${t.why || 'de-risk the build'}

${kind === 'codebase' ? 'Search the repo: find the relevant modules, interfaces, conventions, and call sites. Quote signatures, not whole files.' : ''}
${kind === 'web' ? 'Use web search/fetch. Prefer primary/official sources; cite URLs.' : ''}
${kind === 'domain' ? 'Reason carefully about the domain (math/physics/algorithm/security as applicable). State assumptions, formulas, edge cases, and pitfalls.' : ''}

Return findings + keyFacts + sources + any openQuestions.`,
          { label: `research: ${(t.topic || '').slice(0, 28)}`, phase: 'Research', model, effort: model === 'opus' ? 'high' : 'medium', agentType, schema: RESEARCH_SCHEMA },
        )
      }),
    )
  ).filter(Boolean)
  if (research.length) {
    researchDigest = research
      .map(r => `### ${r.topic}\n${r.findings}${r.keyFacts?.length ? '\nKey facts:\n- ' + r.keyFacts.join('\n- ') : ''}${r.openQuestions?.length ? '\nOpen questions:\n- ' + r.openQuestions.join('\n- ') : ''}`)
      .join('\n\n')
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 2+3 — PLAN (Opus architect) ↔ DESIGN REVIEW (cross-team debate)
// Feedback loop: replan once if the panel flags high-severity issues.
// ═════════════════════════════════════════════════════════════════════════════
let plan = null
let critique = null
for (let round = 1; round <= 2; round++) {
  phase('Plan')
  plan = await agent(
    `You are the ARCHITECT / TECH LEAD. Decompose the mission into a build plan.

MISSION: ${brief.summary}
GOALS:\n- ${(brief.goals || []).join('\n- ')}
SUCCESS CRITERIA:\n- ${(brief.successCriteria || []).join('\n- ')}
CONSTRAINTS:\n- ${(brief.constraints || []).join('\n- ') || '(none stated)'}

RESEARCH DIGEST:
${researchDigest}
${critique ? `\nA prior design review returned issues you MUST address in this revision:\n${JSON.stringify(critique, null, 2)}` : ''}

Rules:
- Produce subtasks that touch DISJOINT file sets (overlap ⇒ merge conflicts at integration). If disjointness is impossible, make fewer, coarser subtasks.
- Give each subtask: id, title, description, testable successCriteria, files[], a role (builder/engineer/scientist/doer/doc), a domain tag, dependsOn[] (ids), and a model tier.
- Tier by REAL intelligence needed: haiku = mechanical (rename/config/docstring/changelog); sonnet = normal engineering (new function, refactor, tests, endpoint); opus = math/physics/numerics/algorithm/security/concurrency/architecture/complex-debug. When torn, pick lower — the review loop will escalate if needed.
- Model the dependency graph honestly: independent subtasks get empty dependsOn so they parallelize; a subtask depends on another only if it needs its code.
- Prefer ≥3 subtasks; never exceed 10.

Return the structured plan.`,
    { label: `architect: plan #${round}`, phase: 'Plan', model: 'opus', effort: 'high', agentType: 'Plan', schema: PLAN_SCHEMA },
  )

  if (!plan?.subtasks?.length) {
    return { decision: 'declined', reason: 'Architect could not decompose the task into subtasks — likely single-concern. Do it inline.', brief }
  }
  plan.subtasks.forEach(s => (s.tier = enforceTier(s))) // deterministic domain/doc floor

  phase('Design Review')
  const panel = (
    await parallel([
      () =>
        agent(
          `You are a PRINCIPAL ENGINEER on a design-review panel. Critique this plan hard.
MISSION: ${brief.summary}
PLAN:\n${JSON.stringify(plan, null, 2)}
Focus: Are subtask file sets truly DISJOINT (list any overlaps — they will conflict at merge-back)? Is the dependency graph correct and free of cycles? Is anything missing to meet the success criteria? Is any subtask MIS-TIERED (too cheap for hidden complexity, or wastefully expensive)? Propose tierCorrections by id. Set severity=high only if the plan would fail or conflict as written.`,
          { label: 'critique: principal-engineer', phase: 'Design Review', model: 'opus', effort: 'high', agentType: 'general-purpose', schema: CRITIQUE_SCHEMA },
        ),
      () =>
        agent(
          `You are a DOMAIN SCIENTIST / SKEPTIC on a design-review panel. Stress-test this plan for correctness risk.
MISSION: ${brief.summary} (primary domain: ${brief.primaryDomain || 'general'})
PLAN:\n${JSON.stringify(plan, null, 2)}
Focus: hidden domain complexity (math/physics/numerics/security/concurrency) that makes a "simple" subtask actually hard, correctness traps, and any subtask under-tiered for the reasoning it truly needs. Propose tierCorrections by id. Set severity=high only if a real correctness failure is likely as written.`,
          { label: 'critique: domain-scientist', phase: 'Design Review', model: 'opus', effort: 'high', agentType: 'general-purpose', schema: CRITIQUE_SCHEMA },
        ),
    ])
  ).filter(Boolean)

  critique = mergeCritiques(panel)
  applyTierCorrections(plan, critique)
  log(`Design review round ${round}: severity=${critique.severity}, ${critique.issues.length} issue(s), ${critique.tierCorrections.length} tier correction(s).`)
  if (critique.severity !== 'high' || round === 2) break
  log('High-severity design issues — architect will revise once.')
}

const tierTally = plan.subtasks.reduce((m, s) => ((m[s.tier] = (m[s.tier] || 0) + 1), m), {})
log(`Plan locked: ${plan.subtasks.length} subtasks — ${Object.entries(tierTally).map(([k, v]) => `${v}×${k}`).join(', ')}.`)

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 4 — BUILD: isolated worktrees, dependency-aware waves, review feedback.
// Each builder gets its OWN worktree/branch, merges its dependency branches in,
// edits only its files, and commits exactly one commit. The user's working tree
// is untouched during the build.
// ═════════════════════════════════════════════════════════════════════════════
phase('Build')
let securityAbort = null

async function buildOne(s, done) {
  const baseTier = enforceTier(s)
  const deps = (s.dependsOn || []).map(d => done.get(d)).filter(Boolean)
  const depBranches = deps.map(r => r.branch).filter(Boolean)
  const depContext = deps.map(r => `- ${r.id}: ${r.summary}`).join('\n')
  let work = null, review = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    const tier = attempt === 2 ? bump(baseTier) : baseTier
    work = await agent(
      `You are a ${s.role || 'BUILDER'} on an engineering swarm, working in your OWN isolated git worktree on a fresh branch. Implement exactly ONE subtask.

SUBTASK ${s.id}: ${s.title}
${s.description || ''}
SUCCESS CRITERIA: ${s.successCriteria}
YOU MAY ONLY EDIT THESE FILES: ${(s.files || []).join(', ') || '(infer minimally from the description)'}
${depContext ? `UPSTREAM SUBTASKS YOU BUILD ON:\n${depContext}` : ''}
${review ? `A REVIEW REJECTED YOUR PREVIOUS ATTEMPT — fix these:\n${JSON.stringify(review.findings || review.reason, null, 2)}` : ''}
MISSION CONTEXT: ${brief.summary}

Steps (you have full git access in your worktree):
${depBranches.length ? `1. FIRST bring in upstream work — for each dependency branch run: \`git merge --no-edit <branch>\`. Dependency branches: ${depBranches.join(', ')}. If a merge conflicts, resolve it in favour of keeping upstream + adding your change.` : '1. (No dependency branches to merge.)'}
2. Make your edits with Edit/Write. Do NOT touch files outside your allowed list.
3. Run any quick local sanity check you can.
4. Commit exactly ONE non-merge commit of your own work: \`git add -A && git commit -m "<subtask title>"\`. Do NOT push.
5. Report: your branch name from \`git branch --show-current\`, committed=true, filesChanged, commitMessage, and status.

If a real obstacle blocks you, return status=blocked with the reason (still report your branch if you committed anything). If you're missing a fact, status=needs_context. Otherwise status=done (or done_with_concerns).`,
      { label: `build ${s.id} [${tier}]#${attempt}`, phase: 'Build', model: tier, effort: effortFor(tier), agentType: 'general-purpose', isolation: 'worktree', schema: WORK_SCHEMA },
    )
    if (!work) { work = { status: 'blocked', summary: 'implementer agent died' }; continue }
    work.id = s.id
    if (work.status === 'blocked' || !work.branch) break

    review = await agent(
      `You are a REVIEWER. Judge whether this subtask meets its spec and is safe to keep. The work is committed on branch "${work.branch}"; inspect it read-only from the main repo.
SUBTASK ${s.id}: ${s.title}
SUCCESS CRITERIA: ${s.successCriteria}
IMPLEMENTER REPORT:\n${JSON.stringify(work, null, 2)}
Inspect the change with \`git show ${work.branch}\` and/or \`git diff ${targetBranch}...${work.branch} -- ${(work.filesChanged || s.files || []).join(' ')}\` and read the changed files. Verdict: pass (meets spec, clean) | changes_requested (fixable gaps — list findings with fixes) | reject (fundamentally wrong) | security_abort (secret leaked or critical vuln introduced).`,
      { label: `review ${s.id}#${attempt}`, phase: 'Build', model: baseTier === 'opus' ? 'opus' : 'sonnet', effort: baseTier === 'opus' ? 'high' : 'medium', agentType: 'general-purpose', schema: REVIEW_SCHEMA },
    )
    if (!review) break
    if (review.verdict === 'security_abort') { work.securityAbort = true; break }
    if (review.verdict === 'pass' || review.verdict === 'reject') break
    // changes_requested → loop and re-implement in a fresh worktree at bumped tier
  }
  return { id: s.id, title: s.title, tier: baseTier, files: s.files, work, review }
}

// Dependency-wave scheduler: each wave runs all ready subtasks in parallel.
const done = new Map()
const results = []
let remaining = plan.subtasks.slice()
let guard = 0
while (remaining.length && guard++ <= plan.subtasks.length + 2) {
  let ready = remaining.filter(s => (s.dependsOn || []).every(d => done.has(d)))
  if (ready.length === 0) {
    log('Dependency stall (missing/cyclic dep) — releasing remaining subtasks together.')
    ready = remaining.slice()
  }
  log(`Build wave: ${ready.map(s => `${s.id}[${enforceTier(s)}]`).join(', ')}`)
  const waveResults = await parallel(ready.map(s => () => buildOne(s, done)))
  ready.forEach((s, i) => {
    const r = waveResults[i] || { id: s.id, title: s.title, work: { status: 'blocked', summary: 'agent died' }, review: null }
    done.set(s.id, r.work || { status: 'blocked', summary: 'no result' })
    results.push(r)
    if (r.work?.securityAbort || r.review?.verdict === 'security_abort') securityAbort = securityAbort || r
  })
  const readyIds = new Set(ready.map(s => s.id))
  remaining = remaining.filter(s => !readyIds.has(s.id))
}

// `results` is already in topological (wave) order — preserve it for merge-back.
const built = results.filter(r => r.work && r.work.branch && (r.work.status === 'done' || r.work.status === 'done_with_concerns'))
const failed = results.filter(r => !built.includes(r))
log(`Build complete: ${built.length} committed, ${failed.length} failed/blocked.`)

if (securityAbort) {
  return {
    decision: 'security_abort',
    message: `A reviewer raised a security_abort on subtask ${securityAbort.id} (${securityAbort.title}). Halting before integration/commit. Nothing was merged into your tree.`,
    results,
  }
}
if (!built.length) {
  return { decision: 'failed', message: 'No subtask produced a committed branch to integrate.', results }
}

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 5 — INTEGRATE (engineer, Sonnet): merge every branch back on a dedicated
// integration worktree (never the user's tree) in topological order, run checks.
// ═════════════════════════════════════════════════════════════════════════════
phase('Integrate')
const mergeOrder = built.map(r => ({ id: r.id, title: r.title, branch: r.work.branch }))
const integration = await agent(
  `You are the INTEGRATION ENGINEER. Merge all subtask branches back into one place WITHOUT touching the user's working tree.

TARGET BRANCH: ${targetBranch}
The user's working tree may be dirty — do NOT check out branches in it and do NOT commit to it.

Do:
1. Create a dedicated integration worktree off the target branch:
   pick a fresh branch name like \`swarm/integration-<short-token>\` (ensure it doesn't already exist), then
   \`git worktree add -b <integrationBranch> .git/swarm-integration <targetBranch>\`  (use a path that doesn't collide; e.g. under the repo's .git dir or a temp path).
2. Inside that worktree, merge each subtask branch IN THIS ORDER (topological):
${mergeOrder.map(m => `   - ${m.branch}   (${m.id}: ${m.title})`).join('\n')}
   Use \`git merge --no-ff <branch>\`. Disjoint files should merge cleanly. If one conflicts, \`git merge --abort\`, record it in failedMerges, and continue with the rest.
3. Look for interface mismatches between subtasks in the merged tree.
4. Run whatever build/lint/test the repo actually provides (inspect package.json / pyproject / Makefile / CLAUDE.md — do not invent commands), from inside the integration worktree.
5. Report: integrationBranch, worktreePath (absolute), mergedBranches, failedMerges, status (clean | conflicts | checks_failed | no_checks_available), checksRun, and concrete issues.

INTEGRATION NOTES FROM ARCHITECT: ${plan.integrationNotes || '(none)'}`,
  { label: 'integrate + merge-back + checks', phase: 'Integrate', model: 'sonnet', effort: 'medium', agentType: 'general-purpose', schema: INTEGRATION_SCHEMA },
)
const integWorktree = integration?.worktreePath || '(integration worktree)'
const integBranch = integration?.integrationBranch || '(integration branch)'
log(`Integration: ${integration?.status || 'unknown'} on ${integBranch} — merged ${integration?.mergedBranches?.length || 0}, failed ${integration?.failedMerges?.length || 0}. ${integration?.summary || ''}`)

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 6 — AUDIT (Fable-led panel; Opus fallback) on the integrated worktree,
// with a fix feedback loop. Fixers edit inside the integration worktree.
// ═════════════════════════════════════════════════════════════════════════════
phase('Audit')
const auditLenses = [
  { key: 'correctness', brief: 'Does the change actually do what the mission requires? Hunt for logic bugs, broken edge cases, and unmet success criteria.' },
  { key: 'security', brief: 'Look for injected vulnerabilities, leaked secrets, unsafe input handling, and unsafe defaults.' },
  { key: 'completeness', brief: `Cross-check every mission success criterion against the delivered work; flag anything missing or only partially done. Success criteria:\n- ${(brief.successCriteria || []).join('\n- ')}` },
]

let auditReports = []
for (let auditRound = 1; auditRound <= 2; auditRound++) {
  auditReports = (
    await parallel(
      auditLenses.map(l => () =>
        auditAgent(
          `You are a FINAL AUDITOR (${l.key} lens) — the last gate before ship. Be adversarial; assume there IS a defect and try to find it. Review the INTEGRATED result on branch "${integBranch}" (worktree: ${integWorktree}); read the actual changed files there.
MISSION: ${brief.summary}
LENS FOCUS: ${l.brief}
DELIVERED SUBTASKS:\n${results.map(r => `- ${r.id}: ${r.work?.status} — ${r.work?.summary} (files: ${(r.work?.filesChanged || r.files || []).join(', ')})`).join('\n')}
INTEGRATION RESULT: ${JSON.stringify(integration)}
Verdict: pass (no real problem) | issues (non-blocking findings) | blocker (must fix before ship). List findings with severity + location + a concrete recommendation.`,
          { label: `audit:${l.key}#${auditRound}`, phase: 'Audit', effort: 'high', agentType: 'general-purpose', schema: AUDIT_SCHEMA },
        ),
      ),
    )
  ).filter(Boolean)

  const blockers = auditReports.filter(a => a.verdict === 'blocker')
  if (!blockers.length) { log(`Audit round ${auditRound}: clean (no blockers).`); break }
  if (auditRound === 2) { log(`Audit round ${auditRound}: ${blockers.length} blocker(s) REMAIN after a fix round — surfacing to user.`); break }

  const fixes = blockers.flatMap(a => (a.findings || []).filter(f => f.severity === 'high' || f.severity === 'critical'))
  log(`Audit round ${auditRound}: ${blockers.length} blocker(s) → dispatching ${fixes.length} fixer(s).`)
  await parallel(
    fixes.map((f, i) => () =>
      agent(
        `You are a FIXER. Resolve ONE audit blocker, minimally and correctly, INSIDE the integration worktree.
INTEGRATION WORKTREE: ${integWorktree}  (branch ${integBranch})
MISSION: ${brief.summary}
BLOCKER: ${f.issue}
LOCATION: ${f.location || '(locate it)'}
RECOMMENDATION: ${f.recommendation || '(use your judgement)'}
Edit the relevant files in the integration worktree to fix it, then commit the fix there: \`git -C ${integWorktree} add -A && git -C ${integWorktree} commit -m "fix: <what>"\`. Do NOT push. Report what you changed.`,
        { label: `fix#${i + 1}`, phase: 'Audit', model: 'sonnet', effort: 'high', agentType: 'general-purpose', schema: WORK_SCHEMA },
      ),
    ),
  )
}
const remainingBlockers = auditReports.filter(a => a.verdict === 'blocker')

// ═════════════════════════════════════════════════════════════════════════════
// PHASE 7 — SHIP (Haiku): docs / changelog on the integration branch, and commit
// there ONLY if the user asked and no blockers remain. Never touches user's tree.
// ═════════════════════════════════════════════════════════════════════════════
phase('Ship')
const mayCommit = brief.commitRequested === true && remainingBlockers.length === 0
const ship = await agent(
  `You are the DOCS & RELEASE hand (keep it mechanical and tidy). Work INSIDE the integration worktree only.
INTEGRATION WORKTREE: ${integWorktree}  (branch ${integBranch})
MISSION: ${brief.summary}
WHAT SHIPPED:\n${results.map(r => `- ${r.id}: ${r.work?.summary}`).join('\n')}
${remainingBlockers.length ? `NOTE: ${remainingBlockers.length} audit blocker(s) are unresolved — do NOT commit; just record docs.` : ''}

Do, following any conventions in CLAUDE.md:
1. Update user-facing docs / README / changelog / TIMELINE that this change requires, editing files inside the integration worktree. If none needed, say so.
2. Compose a clear conventional commit message covering the whole change.
3. ${mayCommit ? `The user asked to commit: stage and commit the docs on the integration branch (\`git -C ${integWorktree} add -A && git -C ${integWorktree} commit -m "<msg>"\`); do NOT push, do NOT merge into ${targetBranch}. Set committed=true.` : 'Do NOT commit. Set committed=false.'}
Return docsUpdated, commitMessage, committed, and a one-line summary.`,
  { label: mayCommit ? 'docs + commit (integration branch)' : 'docs (no commit)', phase: 'Ship', model: 'haiku', effort: 'low', agentType: 'general-purpose', schema: SHIP_SCHEMA },
)

// ── Final synthesis returned to the main loop ────────────────────────────────
return {
  decision: 'completed',
  mission: brief.summary,
  status: failed.length === 0 && remainingBlockers.length === 0 ? 'success' : built.length === 0 ? 'failed' : 'partial',
  routing: tierTally,
  targetBranch,
  integrationBranch: integration?.integrationBranch || null,
  integrationWorktree: integration?.worktreePath || null,
  mergeBack: integration ? { status: integration.status, merged: integration.mergedBranches, failed: integration.failedMerges, checks: integration.checksRun } : null,
  subtasks: results.map(r => ({ id: r.id, title: r.title, tier: r.tier, status: r.work?.status, branch: r.work?.branch, review: r.review?.verdict, summary: r.work?.summary })),
  failed: failed.map(r => ({ id: r.id, title: r.title, reason: r.work?.summary })),
  audit: auditReports.map(a => ({ lens: a.lens, verdict: a.verdict, findings: a.findings || [] })),
  unresolvedBlockers: remainingBlockers.map(a => ({ lens: a.lens, summary: a.summary, findings: a.findings })),
  ship: ship ? { docsUpdated: ship.docsUpdated, commitMessage: ship.commitMessage, committed: ship.committed, summary: ship.summary } : null,
  nextStep: `Review integration branch "${integration?.integrationBranch || '(see above)'}" and merge it into ${targetBranch} when satisfied. Then remove the worktree: git worktree remove ${integration?.worktreePath || '<path>'} (retry rm -rf + git worktree prune if OneDrive/AV holds a handle).`,
}
