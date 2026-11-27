#!/usr/bin/env node
// Wait for full-size Gemini image downloads to land in ~/Downloads, move them to the output folder with a
// readable name, and report path, bytes and pixel size as JSON.
// Usage: node collect.mjs --since ISO_TIME [--count N] [--out DIR] [--name slug] [--timeout SECONDS]
// --since must be a time taken BEFORE clicking "Download full size image" (PowerShell: (Get-Date).ToString('o')).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DOWNLOADS = path.join(os.homedir(), 'Downloads');          // where the browser pane saves (checked 2026-11-14)
const DEFAULT_OUT = path.join(os.homedir(), 'Pictures', 'Gemini');
const PATTERN = /^Gemini_Generated_Image_.*\.(jpe?g|png|webp)$/i;

function die(msg, code = 2) { process.stderr.write(`collect: ${msg}\n`); process.exit(code); }

const o = { count: 1, out: DEFAULT_OUT, name: 'gemini', timeout: 60 };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const v = () => { if (i + 1 >= argv.length) die(`missing value for ${a}`); return argv[++i]; };
  if (a === '--since') o.since = new Date(v());
  else if (a === '--count') o.count = Number(v());
  else if (a === '--out') o.out = path.resolve(v());
  else if (a === '--name') o.name = v();
  else if (a === '--timeout') o.timeout = Number(v());
  else die(`unknown option ${a}`);
}
if (!o.since || isNaN(o.since)) die('--since ISO_TIME is required (take it before clicking download)');
if (!Number.isInteger(o.count) || o.count < 1) die('--count must be a positive integer');
const slug = o.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'gemini';

// Pixel size from the file header (JPEG SOF, PNG IHDR, WebP VP8/VP8L/VP8X).
function dims(buf) {
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let p = 2;
    while (p < buf.length - 9) {
      if (buf[p] !== 0xff) { p++; continue; }
      const m = buf[p + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return [buf.readUInt16BE(p + 7), buf.readUInt16BE(p + 5)];
      p += 2 + buf.readUInt16BE(p + 2);
    }
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const k = buf.toString('ascii', 12, 16);
    if (k === 'VP8X') return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
    if (k === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
    if (k === 'VP8L') { const b = buf.readUInt32LE(21); return [1 + (b & 0x3fff), 1 + ((b >> 14) & 0x3fff)]; }
  }
  return [null, null];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fresh = () => fs.readdirSync(DOWNLOADS)
  .filter((f) => PATTERN.test(f))
  .map((f) => ({ f, full: path.join(DOWNLOADS, f), st: fs.statSync(path.join(DOWNLOADS, f)) }))
  .filter((x) => x.st.mtime > o.since && x.st.size > 0)
  .sort((a, b) => a.st.mtime - b.st.mtime);

const deadline = Date.now() + o.timeout * 1000;
let found = [];
while (Date.now() < deadline) {
  found = fresh();
  if (found.length >= o.count) {
    await sleep(1500);                                   // let the last write finish, then confirm sizes are stable
    const again = fresh();
    if (again.length >= o.count && again.every((x, i) => found[i] && x.st.size === found[i].st.size)) { found = again; break; }
  }
  await sleep(1000);
}
if (found.length < o.count) die(`found ${found.length} of ${o.count} new Gemini image(s) in ${DOWNLOADS} after ${o.timeout}s`, 3);

fs.mkdirSync(o.out, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
const results = found.slice(0, o.count).map((x, i) => {
  const ext = path.extname(x.f).toLowerCase();
  let base = `${stamp}-${slug}${o.count > 1 ? `-${i + 1}` : ''}`;
  let dest = path.join(o.out, base + ext);
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(o.out, `${base}-v${n}${ext}`);
  fs.renameSync(x.full, dest);                           // same drive: a move, not a copy
  const [w, h] = dims(fs.readFileSync(dest));
  return { path: dest, bytes: fs.statSync(dest).size, width: w, height: h, from: x.f };
});
process.stdout.write(JSON.stringify(results, null, 2) + '\n');
