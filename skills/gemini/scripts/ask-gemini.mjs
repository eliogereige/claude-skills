#!/usr/bin/env node
// Send one prompt to Gemini through Antigravity CLI (agy) and print the answer.
// Runs agy in a fresh, empty temp folder in plan mode, so it cannot read or edit the caller's project.
// Usage: node ask-gemini.mjs [--effort low|medium|high] [--file PATH ...]
//                            [--timeout SECONDS] [--json] [--allow-confidential] [--dry-run] "prompt"
//        (prompt may also come from stdin when no positional prompt is given)

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const GEMINI_FAMILY = 'gemini-3.8-flash';           // as listed by `agy models` on 2026-11-14
const EFFORTS = ['low', 'medium', 'high'];
const DEFAULT_EFFORT = 'high';
const INLINE_LIMIT = 20000;                          // chars; above this, material goes into a workspace file
// Paths and prompts that must never leave the machine: GEMINI_BLOCKED_PATTERNS, comma-separated regexes
// (e.g. company or client names). Matched case-insensitively. Empty by default.
const BLOCKED_PATH_PATTERNS = (process.env.GEMINI_BLOCKED_PATTERNS || '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => new RegExp(s, 'i'));

function die(msg, code = 2) {
  process.stderr.write(`ask-gemini: ${msg}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const o = { files: [], timeout: 300, json: false, allowConfidential: false, dryRun: false, prompt: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) die(`missing value for ${a}`); return argv[++i]; };
    if (a === '--effort') o.effort = next();
    else if (a === '--file') o.files.push(next());
    else if (a === '--timeout') o.timeout = Number(next());
    else if (a === '--json') o.json = true;
    else if (a === '--allow-confidential') o.allowConfidential = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '-h' || a === '--help') { process.stdout.write(fs.readFileSync(new URL(import.meta.url)).toString().split('\n').slice(1, 6).join('\n') + '\n'); process.exit(0); }
    else if (a.startsWith('--')) die(`unknown option ${a}`);
    else if (o.prompt === null) o.prompt = a;
    else die('give the prompt as one quoted argument');
  }
  return o;
}

function findAgy() {
  const local = path.join(process.env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe');
  if (process.env.LOCALAPPDATA && fs.existsSync(local)) return local;
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['agy'], { encoding: 'utf8' });
  const hit = r.status === 0 && r.stdout.split(/\r?\n/).find(Boolean);
  if (hit) return hit.trim();
  die('Antigravity CLI (agy) not found. Install: irm https://antigravity.google/cli/install.ps1 | iex, then run `agy` once to sign in.', 3);
}

// Gemini Flash only, by design: effort picks the model id (it is the id suffix in agy).
function resolveModel(o) {
  const effort = o.effort || DEFAULT_EFFORT;
  if (!EFFORTS.includes(effort)) die(`--effort must be one of ${EFFORTS.join(', ')} (Gemini Flash has no higher level)`);
  return `${GEMINI_FAMILY}-${effort}`;
}

const o = parseArgs(process.argv.slice(2));
if (o.prompt === null && !process.stdin.isTTY) o.prompt = fs.readFileSync(0, 'utf8');
if (!o.prompt || !o.prompt.trim()) die('no prompt given');
if (!Number.isFinite(o.timeout) || o.timeout <= 0) die('--timeout must be a positive number of seconds');
const model = resolveModel(o);

// Gather attached files, refusing confidential paths.
const attachments = o.files.map((f) => {
  const abs = path.resolve(f);
  if (!o.allowConfidential && BLOCKED_PATH_PATTERNS.some((re) => re.test(abs)))
    die(`refusing to send ${abs}: path matches GEMINI_BLOCKED_PATTERNS (pass --allow-confidential only if the user said so)`, 4);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) die(`file not found: ${abs}`);
  return { name: path.basename(abs), text: fs.readFileSync(abs, 'utf8') };
});
if (!o.allowConfidential && BLOCKED_PATH_PATTERNS.some((re) => re.test(o.prompt)))
  die('refusing: the prompt matches GEMINI_BLOCKED_PATTERNS (pass --allow-confidential only if the user said so)', 4);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-gemini-'));
let prompt = o.prompt.trim();
const material = attachments.map((a) => `----- FILE: ${a.name} -----\n${a.text}\n----- END FILE: ${a.name} -----`).join('\n\n');
if (material) {
  if (prompt.length + material.length <= INLINE_LIMIT) {
    prompt = `${prompt}\n\n${material}`;
  } else {
    fs.writeFileSync(path.join(work, 'context.md'), material, 'utf8');
    // Plan mode denies shell commands, so steer agy to its file-viewing tool.
    prompt = `${prompt}\n\nThe material to use is in the file context.md in the current folder. Open it with your file-viewing tool (not a shell or terminal command, which is disabled here) and read all of it before answering.`;
  }
}
if (prompt.length > 30000) die(`prompt is ${prompt.length} chars; put long material in --file instead`);

// Always ask agy for JSON so an empty answer or a denied action is caught, not printed as silent success.
const args = ['-p', prompt, '--model', model, '--mode', 'plan', '--print-timeout', `${o.timeout}s`, '--output-format', 'json'];

if (o.dryRun) {
  process.stdout.write(JSON.stringify({ agy: findAgy(), cwd: work, model, args: args.map((a) => (a === prompt ? `<prompt ${prompt.length} chars>` : a)), contextFile: fs.existsSync(path.join(work, 'context.md')) }, null, 2) + '\n');
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(0);
}

const agy = findAgy();
const t0 = Date.now();
const r = spawnSync(agy, args, { cwd: work, encoding: 'utf8', timeout: (o.timeout + 30) * 1000, maxBuffer: 64 * 1024 * 1024 });
fs.rmSync(work, { recursive: true, force: true });

if (r.error) die(`agy failed to run: ${r.error.message}`, 5);
const secs = ((Date.now() - t0) / 1000).toFixed(1);
if (r.status !== 0) {
  process.stderr.write(`[ask-gemini] model=${model} exit=${r.status} time=${secs}s\n${r.stderr || ''}${r.stdout || ''}`);
  process.exit(r.status || 1);
}
let res;
try { res = JSON.parse((r.stdout || '').trim().split(/\r?\n/).pop()); }
catch { die(`could not parse agy JSON output:\n${r.stdout}`, 6); }
const denied = (res.denied_actions || []).map((d) => d.display_name || d.action).join(', ');
process.stdout.write(o.json ? JSON.stringify(res, null, 2) + '\n' : `${res.response || ''}\n`);
process.stderr.write(`[ask-gemini] model=${model} status=${res.status} time=${secs}s tokens=${res.usage?.total_tokens ?? '?'}${denied ? ` denied=${denied}` : ''}\n`);
if (res.status !== 'SUCCESS' || !String(res.response || '').trim())
  die(`Gemini returned no answer (status ${res.status}${denied ? `, blocked actions: ${denied}` : ''})`, 6);
