#!/usr/bin/env node
// Stop hook for the two-tier garde-fou.
// 1. If this turn did substantial work (file edits + analysis runs) and no
//    review with a verdict followed it, send Claude back to run the garde-fou-quick
//    tripwire or say in one line why the work was routine. Never when Claude is
//    already continuing because of a Stop hook.
// 2. If the latest tripwire answered ESCALATE and the full garde-fou did not run after
//    it, send Claude back to run the full review. At most once per tripwire run (a
//    marker file in the temp dir), so this fires even after block 1 and never loops.
// A review only counts once its report (sync tool_result, async hand-back message, or
// task notification) holds a verdict: an errored or unfinished tripwire is not a review.
// Main-agent turns only (subagents fire SubagentStop, not Stop).
// Fails open: any error lets the turn end normally, with the error on stderr.

const fs = require('fs');
const os = require('os');
const path = require('path');

const THRESHOLD = 3; // edits + script runs in one turn that count as substantial
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const AGENT_TOOLS = new Set(['Agent', 'Task']);
const QUICK = 'garde-fou-quick';
const FULL = 'garde-fou';
// Matches "garde-fou-quick" and, when installed as a plugin, "<plugin>:garde-fou-quick".
const isAgent = (type, name) => type === name || (typeof type === 'string' && type.endsWith(`:${name}`));
// Config, memory and scratch files are not "work" to review.
const IGNORED_PATH = /[\\/]\.claude[\\/]|[\\/]AppData[\\/]Local[\\/]Temp[\\/]|^\/tmp\//i;
// Commands that run an analysis or a model.
const RUN_CMD = /\b(python3?|py|Rscript|jupyter|julia|matlab|octave|wsl)\b/;
// Scripts run on your own mods, skills, hooks and config (anything under ~/.claude) are not work to review.
const CONFIG_CMD = /[\\/]\.claude[\\/]|~\/\.claude\b/i;
const QUICK_VERDICT = /^\s*VERDICT:\s*(CLEAN|ESCALATE)\b/m; // first verdict line wins
const FULL_VERDICT = /\b(SHIP|DO NOT SHIP)\b/;
// User entries the harness writes, not the user: they must not start a new turn.
const HARNESS_TEXT = /^\s*(<task-notification>|Another Claude session sent a message|\[SYSTEM NOTIFICATION)/;

const textOf = (c) => {
  if (typeof c === 'string') return c;
  return Array.isArray(c) ? c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n') : '';
};

const isRealPrompt = (entry) => {
  if (entry.type !== 'user' || entry.isMeta || entry.isSidechain) return false;
  if (entry.origin && entry.origin.kind === 'peer') return false;
  const c = entry.message && entry.message.content;
  if (typeof c === 'string') return !HARNESS_TEXT.test(c);
  return Array.isArray(c) && c.some((b) => b.type === 'text' && !HARNESS_TEXT.test(b.text || ''))
    && !c.some((b) => b.type === 'tool_result');
};

const markerPath = (sessionId, toolUseId) =>
  path.join(os.tmpdir(), `garde-fou-escalated-${String(sessionId || 'nosession').replace(/\W/g, '')}-${String(toolUseId).replace(/\W/g, '')}`);

const main = (input) => {
  const lines = fs.readFileSync(input.transcript_path, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { /* partial line */ }
  }

  let start = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isRealPrompt(entries[i])) { start = i; break; }
  }
  const turn = entries.slice(start).filter((e) => !e.isSidechain);

  // Collect report text per tool_use id from every place the harness puts it.
  const reports = new Map(); // tool_use_id -> text
  const agentIds = new Map(); // agentId -> tool_use_id
  const handbacks = []; // [agentId, text]
  const add = (id, text) => reports.set(id, (reports.get(id) || '') + '\n' + text);
  const notification = (text) => {
    const m = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(text || '');
    if (m) add(m[1], text);
  };
  for (const e of turn) {
    const c = e.message && e.message.content;
    if (e.type === 'attachment' && e.attachment) notification(e.attachment.prompt);
    if (e.type !== 'user') continue;
    if (e.origin && e.origin.kind === 'peer') {
      handbacks.push([e.origin.from, e.origin.handbackReportText || textOf(c)]);
      continue;
    }
    if (typeof c === 'string') {
      const m = /<agent-message from="([^"]+)"/.exec(c);
      if (m) handbacks.push([m[1], c]); else notification(c);
      continue;
    }
    for (const b of Array.isArray(c) ? c : []) {
      if (b.type !== 'tool_result') { if (b.type === 'text') notification(b.text); continue; }
      const t = textOf(b.content);
      add(b.tool_use_id, t);
      const m = /agentId:\s*([0-9a-zA-Z_-]+)/.exec(t);
      if (m) agentIds.set(m[1], b.tool_use_id);
    }
  }
  for (const [agentId, text] of handbacks) if (agentIds.has(agentId)) add(agentIds.get(agentId), text);

  let work = 0;
  let lastWork = -1;
  let lastReview = -1; // either tier, with a verdict
  let lastFull = -1;
  let lastQuick = null; // { step, id, verdict }
  let unfinishedQuick = false; // a tripwire after the work that ended with no verdict (errored or cut off)
  let pendingQuick = -1; // a tripwire launched in the background that has not reported yet
  let step = 0;
  for (const e of turn) {
    if (e.type !== 'assistant') continue;
    const content = (e.message && e.message.content) || [];
    for (const block of Array.isArray(content) ? content : []) {
      if (block.type !== 'tool_use') continue;
      step++;
      const inp = block.input || {};
      if (EDIT_TOOLS.has(block.name)) {
        const p = inp.file_path || inp.notebook_path || '';
        if (!IGNORED_PATH.test(p)) { work++; lastWork = step; unfinishedQuick = false; }
      } else if (SHELL_TOOLS.has(block.name) && RUN_CMD.test(inp.command || '') && !CONFIG_CMD.test(inp.command || '')) {
        work++; lastWork = step; unfinishedQuick = false;
      } else if (AGENT_TOOLS.has(block.name) && isAgent(inp.subagent_type, FULL)) {
        if (FULL_VERDICT.test(reports.get(block.id) || '')) lastReview = lastFull = step;
      } else if (AGENT_TOOLS.has(block.name) && isAgent(inp.subagent_type, QUICK)) {
        const m = QUICK_VERDICT.exec(reports.get(block.id) || '');
        const r = reports.get(block.id) || '';
        if (m) { lastReview = step; lastQuick = { step, id: block.id, verdict: m[1] }; unfinishedQuick = false; }
        else if (/agentId:/.test(r) && !/<task-notification>/.test(r)) pendingQuick = step; // launched, not reported yet
        else unfinishedQuick = true;
      }
    }
  }

  // Block 2: escalation not followed by the full review (once per tripwire run). Only when the turn did
  // counted work: config and scratch edits (IGNORED_PATH) never call for the full review.
  if (work > 0 && lastQuick && lastQuick.verdict === 'ESCALATE' && lastQuick.step > lastFull) {
    const marker = markerPath(input.session_id, lastQuick.id);
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker, new Date().toISOString()); // if this throws, we fail open
      return {
        decision: 'block',
        reason:
          `garde-fou check: the ${QUICK} tripwire answered ESCALATE and the full ${FULL} review has not run since. ` +
          `Run the ${FULL} agent now with the request, the changed files, and the tripwire's reasons; ` +
          'address its blockers and report its verdict.',
      };
    }
  }

  // Block 1: substantial work with no review after it.
  if (input.stop_hook_active) return null; // already sent back once: never loop
  if (work < THRESHOLD || lastReview > lastWork) return null;
  if (pendingQuick > lastWork) return null; // its report re-invokes Claude, and the hook runs again then
  return {
    decision: 'block',
    reason:
      `garde-fou check: this turn made ${work} edits/analysis runs with no review after them` +
      (unfinishedQuick ? ` (a ${QUICK} run ended with no VERDICT line: it errored or was cut off)` : '') +
      `. Run the ${QUICK} tripwire now and wait for its verdict: give it the request, the files you changed and what changed, ` +
      'the commands you ran with their key outputs, and the claims you are about to make. ' +
      `If it answers ESCALATE, run the full ${FULL} agent on its reasons, address the blockers, and report the verdict. ` +
      'If the work was routine (config, typo, formatting, exploration), say so in one line and stop.',
  };
};

let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  try {
    const out = main(JSON.parse(raw || '{}'));
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (err) {
    process.stderr.write(`garde-fou-stop: ${err.message}\n`);
  }
  process.exit(0);
});
