#!/usr/bin/env node
// Fixture tests for garde-fou-stop.js. Run: node garde-fou-stop.test.js
// Entry shapes copied from real Claude Code 2.1.310 transcripts (desktop app):
// async Agent tool_result with "agentId: ...", the report as a peer hand-back user entry
// (isMeta + origin.kind "peer", or a plain string "Another Claude session sent a message"),
// and the completion notice as an attachment of type queued_command.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, 'garde-fou-stop.js');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gf-test-'));
const SESSION = `test${process.pid}${Date.now()}`;
let id = 0;
let lastTool = null;

const prompt = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const tool = (name, input) => {
  lastTool = `toolu_${++id}`;
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: lastTool, name, input }] } };
};
const edit = (p = 'C:/Users/me/Desktop/proj/a.py') => tool('Edit', { file_path: p });
const toolResult = (content) => ({
  type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: lastTool, content }] },
});
// Background agent: launch result, then hand-back report, then completion notice.
const asyncAgent = (subagent_type, report, { stringHandback = false, finished = true } = {}) => {
  const agentId = `a${id}f00d`;
  const out = [
    tool('Agent', { subagent_type, prompt: 'review' }),
    toolResult([{ type: 'text', text: `Async agent launched successfully.\nagentId: ${agentId} (internal ID)` }]),
  ];
  if (!finished) return out;
  const body = `Another Claude session sent a message:\n<agent-message from="${agentId}">\n[Subagent hand-back] The report follows:\n  ${report.replace(/\n/g, '\n  ')}\n</agent-message>`;
  out.push(stringHandback
    ? { type: 'user', message: { role: 'user', content: body } }
    : { type: 'user', isMeta: true, origin: { kind: 'peer', from: agentId, handback: true, handbackReportText: report }, message: { role: 'user', content: body } });
  out.push({ type: 'attachment', attachment: { type: 'queued_command', prompt: `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${out[0].message.content[0].id}</tool-use-id>\n<status>completed</status>\n<result>This agent's report was delivered to you as a message.</result>\n</task-notification>` } });
  return out;
};

const runRaw = (input) => {
  const r = spawnSync('node', [HOOK], { input: JSON.stringify(input), encoding: 'utf8' });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
};
const write = (entries) => {
  const tp = path.join(dir, `t${++id}.jsonl`);
  fs.writeFileSync(tp, entries.flat().map((e) => JSON.stringify(e)).join('\n') + '\n');
  return tp;
};
const run = (entries, extra = {}) => runRaw({ transcript_path: write(entries), session_id: `${SESSION}${id}`, ...extra });

const blocks = (re) => (r) => r.out && r.out.decision === 'block' && re.test(r.out.reason);
const none = (r) => r.out === null;
const W3 = () => [edit(), edit(), tool('Bash', { command: 'python fit.py' })];

const cases = [
  ['under threshold -> no block', () => run([prompt('do x'), edit(), edit()]), none],
  ['work + no review -> block asking for the tripwire', () => run([prompt('do x'), W3()]), blocks(/Run the garde-fou-quick tripwire/)],
  ['async tripwire CLEAN (peer hand-back) -> no block',
    () => run([prompt('do x'), W3(), asyncAgent('garde-fou-quick', 'VERDICT: CLEAN\nChecked a.py\nNot checked: nothing')]), none],
  ['stop_hook_active, no review -> no block', () => run([prompt('do x'), W3()], { stop_hook_active: true }), none],
  ['async tripwire ESCALATE (string hand-back), no full -> block for full review',
    () => run([prompt('do x'), W3(), asyncAgent('garde-fou-quick', 'VERDICT: ESCALATE\n- [1] claim without evidence', { stringHandback: true })]),
    blocks(/answered ESCALATE/)],
  ['ESCALATE after a first block (stop_hook_active) -> block once, then never again', () => {
    const tp = write([prompt('do x'), W3(), asyncAgent('garde-fou-quick', 'VERDICT: ESCALATE\n- [2] odd number')]);
    const sid = `${SESSION}esc`;
    const first = runRaw({ transcript_path: tp, session_id: sid, stop_hook_active: true });
    const second = runRaw({ transcript_path: tp, session_id: sid, stop_hook_active: true });
    return { code: first.code || second.code, first, second };
  }, (r) => blocks(/answered ESCALATE/)(r.first) && none(r.second)],
  ['ESCALATE then full review with verdict -> no block',
    () => run([prompt('do x'), W3(), asyncAgent('garde-fou-quick', 'VERDICT: ESCALATE\n- x'), asyncAgent('garde-fou', 'findings...\nVerdict: SHIP AFTER FIXES')]), none],
  ['ESCALATE on exempt-only work (~/.claude edits) -> no block',
    () => run([prompt('tweak my hook'), edit('C:/Users/me/.claude/hooks/x.js'), edit('C:/Users/me/.claude/mods/m/r.tsx'),
      asyncAgent('garde-fou:garde-fou-quick', 'VERDICT: ESCALATE\n- [1] odd')]), none],
  ['full review after work -> no block', () => run([prompt('do x'), W3(), asyncAgent('garde-fou', 'Verdict: SHIP')]), none],
  ['review then more work -> block',
    () => run([prompt('do x'), edit(), asyncAgent('garde-fou-quick', 'VERDICT: CLEAN'), edit(), edit()]), blocks(/garde-fou-quick/)],
  ['previous prompt work not counted', () => run([prompt('old'), W3(), prompt('new'), edit()]), none],
  ['.claude config edits not counted',
    () => run([prompt('do x'), edit('C:/Users/me/.claude/settings.json'), edit('C:/Users/me/.claude/a.md'), edit()]), none],
  ['scripts run on ~/.claude (mods, skills) not counted',
    () => run([prompt('do x'), tool('Bash', { command: 'cd ~/.claude/skills/x && python a.py' }),
      tool('Bash', { command: 'python C:/Users/me/.claude/hooks/t.py' }), tool('Bash', { command: 'python "C:\\Users\\me\\.claude\\b.py"' })]), none],
  ['analysis scripts elsewhere still counted',
    () => run([prompt('do x'), tool('Bash', { command: 'python fit.py' }), tool('Bash', { command: 'python C:/data/run.py' }), edit()]), blocks(/3 edits/)],
  ['missing transcript -> fails open', () => {
    const r = spawnSync('node', [HOOK], { input: JSON.stringify({ transcript_path: path.join(dir, 'nope.jsonl') }), encoding: 'utf8' });
    return { code: r.status, out: r.stdout || null, err: r.stderr };
  }, (r) => r.code === 0 && r.out === null && /garde-fou-stop:/.test(r.err)],
  ['errored tripwire (agent not found) is not a review -> block',
    () => run([prompt('do x'), W3(), tool('Agent', { subagent_type: 'garde-fou-quick' }), toolResult("Agent type 'garde-fou-quick' not found.")]),
    blocks(/no VERDICT line/)],
  ['tripwire still running in background -> no block (re-checked when it reports)',
    () => run([prompt('do x'), W3(), asyncAgent('garde-fou-quick', '', { finished: false })]), none],
  ['task notification / hand-back strings do not start a new turn -> block',
    () => run([prompt('do x'), edit(), edit(), prompt('<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>'),
      prompt('Another Claude session sent a message:\n<agent-message from="zzz">hi</agent-message>'), edit()]),
    blocks(/3 edits/)],
  ['sync tripwire with verdict in tool_result -> no block',
    () => run([prompt('do x'), W3(), tool('Agent', { subagent_type: 'garde-fou-quick' }), toolResult([{ type: 'text', text: 'VERDICT: CLEAN\nNot checked: nothing' }])]), none],
  ['first VERDICT line wins (CLEAN that quotes ESCALATE) -> no block',
    () => run([prompt('do x'), W3(), asyncAgent('garde-fou-quick', 'VERDICT: CLEAN\nNote: the hook matches\nVERDICT: ESCALATE as a string')]), none],
  // Installed as a plugin, the agents are namespaced "<plugin>:<agent>".
  ['plugin-namespaced tripwire CLEAN -> no block',
    () => run([prompt('do x'), W3(), asyncAgent('garde-fou:garde-fou-quick', 'VERDICT: CLEAN\nNot checked: nothing')]), none],
  ['plugin-namespaced ESCALATE then namespaced full review -> no block',
    () => run([prompt('do x'), W3(), asyncAgent('garde-fou:garde-fou-quick', 'VERDICT: ESCALATE\n- x'), asyncAgent('garde-fou:garde-fou', 'Verdict: SHIP')]), none],
  ['unrelated agent ending in "garde-fou-quick" is not a review -> block',
    () => run([prompt('do x'), W3(), asyncAgent('my-garde-fou-quick', 'VERDICT: CLEAN')]), blocks(/Run the garde-fou-quick tripwire/)],
];

let failed = 0;
for (const [name, act, ok] of cases) {
  const r = act();
  const pass = r.code === 0 && ok(r);
  if (!pass) failed++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${pass ? '' : `  -> ${JSON.stringify(r).slice(0, 400)}`}`);
}
fs.rmSync(dir, { recursive: true, force: true });
for (const f of fs.readdirSync(os.tmpdir())) {
  if (f.startsWith(`garde-fou-escalated-${SESSION}`)) fs.rmSync(path.join(os.tmpdir(), f), { force: true });
}
console.log(`${cases.length - failed}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
