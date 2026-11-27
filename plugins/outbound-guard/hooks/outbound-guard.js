#!/usr/bin/env node
// PreToolUse hook: stops every outbound data transfer from this machine and ASKS the user first.
// It never blocks silently: it alerts the user, says plainly what the call would do, and lets them allow or refuse.
// The prompt names what the call does in plain words, the exact call, and where the data goes.
// It also asks before DOWNLOADS (git clone/pull, package installs, web downloads,
// container and model pulls), and loudest for code fetched and run at once (curl | bash, iwr | iex):
// privacy for what leaves the session or PC, protection for what comes onto it.
// Flagged: git push, uploads/POSTs (curl, wget, Invoke-WebRequest/RestMethod, .NET, Python/JS
// HTTP clients in inline code or in scripts being run), scp/sftp/ssh/rsync-to-remote/netcat,
// package/container publishing, cloud storage copies, mail, write-type gh commands, URLs whose
// query string or path carries a data blob, data piped or substituted into a network command,
// remote (cloud) agents, RemoteTrigger, and MCP tools that publish/upload/create/write/send.
// Never asked about: web search, reading plain web pages, localhost traffic, and local work.
// Also asks before edits that would disable or remove this guard.
// Fails closed: if the hook cannot read its input, the tool call is denied (there is nothing to show
// the user to decide on); a hook error on a readable call asks, naming the call.
// Known gaps: typing into web pages via Chrome `computer`, obfuscated code, programs that are
// not scanned (compiled binaries, scripts launched indirectly). Auto-mode's classifier and a
// "no outbound data" memory or CLAUDE.md rule are the other layers.

const fs = require('fs');
const path = require('path');

const MAX_QUERY = 120; // URL query-string length (chars) beyond which a URL looks like it carries data
const MAX_BLOB = 64;   // longest run of base64/hex/percent-encoded chars allowed in a URL
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);
const SCRIPT_MAX_BYTES = 2 * 1024 * 1024;

const emit = (decision, reason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
  }));
  process.exit(0);
};
// Only for input the hook cannot read: there is no call to describe, so nothing to ask about.
const deny = (reason) => emit('deny', `outbound-guard: ${reason}. The call was blocked because it could not be checked.`);

// ---------- telling the user what the call would do ----------
// The app shows the reason in a small box (it scrolls past ~3 lines) with the full call already
// listed under it, so the reason is ONE short sentence: the flagged piece, what it does, where to.
const cut = (s, max) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
// What each kind of flagged call does, in plain words (matched against the reason check() gave).
const WHAT = [
  [/git push/, 'uploads your local commits'],
  [/gh api write|write-type GitHub/, 'creates or changes something on GitHub'],
  [/curl|wget|HTTP POST|urllib|PowerShell web request|\.NET upload|browser upload|page script/, 'sends data to a web server'],
  [/rsync|remote copy/, 'copies files to (or connects to) another machine'],
  [/publishing a package/, 'publishes a package or image'],
  [/cloud storage/, 'copies files to cloud storage'],
  [/piped or substituted/, 'feeds local data into a network request'],
  [/query string|encoded blob/, 'opens a web address that carries data'],
  [/sending mail|mail\/FTP\/SSH/, 'sends email or files over FTP/SSH'],
  [/remote trigger/, 'starts work in the cloud with your code'],
  [/remote agents/, 'copies your workspace to the cloud'],
  [/artifact/, 'uploads content'],
  [/session on (a remote|the cloud)|moves this session/, 'sends your project and conversation off this computer'],
  [/MCP tool/, 'sends, creates or publishes content through an online tool'],
  [/disableAllHooks/, 'turns off all hooks, this guard included'],
  [/outbound guard/, 'changes or removes the outbound guard itself'],
];
const whatItDoes = (why) => {
  const hit = WHAT.find(([re]) => re.test(why));
  return hit ? hit[1] : 'may send data off this computer';
};
// The one piece of the call that triggered: for a shell command, the first sub-command (split on
// newlines, ;, &&, ||, |) that is flagged on its own, so a long command cannot hide it.
const flaggedPart = (inp, test = (p) => checkShell(p, inp.cwd)) => {
  const name = inp.tool_name || '';
  const input = inp.tool_input || {};
  if (name === 'Bash' || name === 'PowerShell' || (name.startsWith('mcp__') && typeof input.command === 'string')) {
    const cmd = String(input.command || '');
    const piece = cmd.split(/\r?\n|&&|\|\||;|\|/).map((s) => s.trim()).filter(Boolean)
      .find((p) => { try { return test(p); } catch { return false; } });
    return cut(piece || cmd, 90); // whole command when only the combination is flagged (data piped in)
  }
  if (name === 'WebFetch') return cut(input.url || '', 90);
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return cut(input.file_path || input.notebook_path || '', 90);
  if (/^Artifact/.test(name)) {
    const target = input.file_path ? path.basename(String(input.file_path)) : input.url || '';
    return cut(`${name} ${input.action || 'publish'}${target ? ` ${target}` : ''}`, 90);
  }
  if (name.startsWith('mcp__')) return cut(name.split('__').slice(1).join(' › '), 90);
  if (name === 'Agent' || name === 'Task') return 'remote agent';
  return cut(name, 90);
};
// Kept for the error path: names the call without its full input.
const exactCall = (inp) => `${(inp && inp.tool_name) || 'tool'} "${flaggedPart(inp)}"`;
// Where the data would go, when the call says it.
const destination = (inp, why) => {
  const name = inp.tool_name || '';
  const input = inp.tool_input || {};
  if (/^Artifact/.test(name)) return 'claude.ai';
  if (/^mcp__ccd_session__/.test(name)) return input.target === 'ssh' ? (input.host || 'an SSH machine') : 'Anthropic\'s cloud';
  if (name.startsWith('mcp__')) return null; // the flagged part already names the service
  if (name === 'RemoteTrigger' || name === 'Agent' || name === 'Task') return 'Anthropic\'s cloud';
  const text = JSON.stringify(inp.tool_input || {});
  const hosts = new Set();
  for (const u of text.match(URL_RE) || []) {
    try { const h = new URL(u.replace(/\\+$/, '')).hostname; if (!LOCAL_HOSTS.has(h)) hosts.add(h); } catch { /* not a URL */ }
  }
  // host:path is only meaningful for remote-copy commands; elsewhere "word:" is a refspec, a header, a label.
  if (/remote copy|rsync/.test(why)) {
    for (const m of text.matchAll(/(?:^|[\s"])(?:[\w.-]+@)?([A-Za-z0-9][\w.-]*):(?!\/\/|\\)/g)) {
      if (!/^[A-Za-z]$/.test(m[1])) hosts.add(m[1]); // skip drive letters like C:
    }
  }
  for (const m of text.matchAll(/\b(?:ssh|nc|ncat|netcat|telnet)\s+(?:-\S+\s+)*(?:[\w.-]+@)?([A-Za-z0-9][\w.-]+)/g)) hosts.add(m[1]);
  if (hosts.size) return cut([...hosts].slice(0, 3).join(', '), 60);
  if (/git push/.test(why)) return 'the repo\'s remote (origin unless named)';
  if (/GitHub/.test(why)) return 'GitHub';
  return null;
};
// One sentence, e.g.: ⚠ OUTBOUND DATA: "git push origin main" uploads your local commits, to the
// repo's remote (origin unless named). Allow = run once. Deny = block.
const ask = (inp, why) => {
  const selfChange = /outbound guard|disableAllHooks/.test(why);
  const where = selfChange ? null : destination(inp, why);
  if (selfChange) {
    // Plain words, no code: the code is listed under the pop-up anyway.
    emit('ask', '⚠ GUARD CHANGE: Claude wants to edit, replace or turn off the guard itself (outbound-guard.js, the check '
      + 'that asks before uploads and downloads). Allow only if you asked for a guard change; otherwise Deny.');
  }
  emit('ask', `⚠ OUTBOUND DATA: "${flaggedPart(inp)}" ${whatItDoes(why)}${where ? `, to ${where}` : ''}. Allow = run once. Deny = block.`);
};

// One sentence, e.g.: ⬇ DOWNLOAD: "git clone https://github.com/o/r" brings files onto this computer,
// from github.com. Allow = run once. Deny = block.
const DL_WHAT = {
  'download and run': 'DOWNLOADS CODE AND RUNS IT right away, without saving it for a look first',
  'git download': 'brings code onto this computer',
  'package install': 'downloads and installs software',
  'container image download': 'downloads a container image',
  'GitHub download': 'brings files from GitHub onto this computer',
  'model download': 'downloads model files',
  'web download': 'brings data from the internet onto this computer',
};
const askDownload = (inp, why) => {
  const text = String((inp.tool_input || {}).command || '');
  const hosts = new Set();
  for (const u of text.match(URL_RE) || []) {
    try { const h = new URL(u).hostname; if (!LOCAL_HOSTS.has(h)) hosts.add(h); } catch { /* not a URL */ }
  }
  const from = hosts.size ? cut([...hosts].slice(0, 3).join(', '), 60)
    : why === 'git download' ? 'the repo\'s remote'
      : why === 'package install' ? 'the package registry (PyPI, npm, conda...)'
        : why === 'GitHub download' ? 'GitHub' : null;
  // Download-and-run spans the pipe, so it is shown whole: the "| bash" is the dangerous half.
  const run = why === 'download and run';
  const piece = run ? cut(text, 90) : flaggedPart(inp, checkDownloadShell);
  const what = run ? 'downloads code and RUNS IT at once, unseen' : DL_WHAT[why] || 'downloads data';
  emit('ask', `${run ? '⬇ DOWNLOAD + RUN' : '⬇ DOWNLOAD'}: "${piece}" ${what}${from ? `, from ${from}` : ''}. Allow = run once. Deny = block.`);
};

// ---------- URLs ----------
const URL_RE = /\bhttps?:\/\/[^\s'"<>`)\]]+/gi;
const urlProblem = (u) => {
  let p;
  try { p = new URL(u); } catch { return null; }
  if (LOCAL_HOSTS.has(p.hostname)) return null;
  const q = p.search.replace(/^\?/, '');
  if (q.length > MAX_QUERY) return `URL ${p.hostname} has a ${q.length}-char query string (looks like data being sent)`;
  const blob = new RegExp(`[A-Za-z0-9+_%=]{${MAX_BLOB + 1},}`).exec(p.pathname + '?' + q);
  if (blob) return `URL ${p.hostname} carries a ${blob[0].length}-char encoded blob (looks like data being sent)`;
  return null;
};
const checkUrls = (text) => {
  for (const u of String(text).match(URL_RE) || []) {
    const r = urlProblem(u);
    if (r) return r;
  }
  return null;
};

// ---------- code that sends data (inline -c / -e code and scripts being run) ----------
const CODE_RULES = [
  [/\b(requests|httpx|session|client)\.(post|put|patch)\s*\(/i, 'HTTP POST/PUT/PATCH in code'],
  [/\burlopen\s*\([^)]*data\s*=/i, 'urllib POST in code'],
  [/\b(smtplib|ftplib|paramiko|pysftp)\b/, 'mail/FTP/SSH library in code'],
  [/\bmethod\s*[:=]\s*['"](POST|PUT|PATCH)['"]/i, 'HTTP POST/PUT/PATCH in code'],
  [/\b(axios|got|superagent)\.(post|put|patch)\s*\(/i, 'HTTP POST/PUT/PATCH in code'],
  [/\bnavigator\.sendBeacon\b|\bXMLHttpRequest\b/, 'browser upload API in code'],
  [/\b(nodemailer|ssh2-sftp-client|basic-ftp)\b/, 'mail/FTP/SSH library in code'],
  [/\.(Upload(String|File|Data|Values)(Async)?|(Post|Put|Patch|Send)Async)\s*\(/i, '.NET upload call'],
  [/\bSend-MailMessage\b|\bNet\.Mail\b|\bSmtpClient\b/i, 'sending mail'],
  [/\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b[^|;\n]*\s-(Method\s+['"]?(Post|Put|Patch|Delete)|Body|InFile|Form)\b/i, 'PowerShell web request with a body/upload'],
];
const checkCode = (text) => {
  for (const [re, why] of CODE_RULES) if (re.test(text)) return why;
  return null;
};

// ---------- shell commands ----------
const SEG = "[^|;&\\n]*"; // stays inside one simple command
const SHELL_RULES = [
  [new RegExp(`\\bgit\\b${SEG}\\s(push|send-email|request-pull)\\b`, 'i'), 'git push / send-email'],
  [new RegExp(`\\bcurl\\b${SEG}\\s(-[a-zA-Z]*[dFT]\\b|--data[\\w-]*|--form[\\w-]*|--upload-file|--json|-X\\s*(POST|PUT|PATCH|DELETE|post|put|patch|delete)\\b|--request[\\s=]+(POST|PUT|PATCH|DELETE|post|put|patch|delete)\\b)`), 'curl upload/POST'],
  [new RegExp(`\\bwget\\b${SEG}\\s--(post-data|post-file|body-data|body-file|method[\\s=]+(POST|PUT|PATCH|DELETE))`, 'i'), 'wget upload/POST'],
  [/(^|[\s;|&(`])(scp|sftp|ftp|tftp|ssh|nc|ncat|netcat|socat|telnet|sendmail|mutt|mailx)(\.exe)?(\s|$)/i, 'remote copy/shell/socket/mail command'],
  [new RegExp(`\\brsync\\b${SEG}\\s([\\w.-]+@)?[A-Za-z0-9][\\w.-]+:(?!//)`), 'rsync to a remote host'],
  [/\b(npm|pnpm|yarn|poetry|cargo)\s+publish\b|\btwine\s+upload\b|\b(docker|podman)\s+push\b|\b(anaconda|conda)\s+upload\b|\b(huggingface-cli|hf)\s+upload\b|\bgem\s+push\b/i, 'publishing a package/image'],
  [/\baws\s+s3\s+(cp|mv|sync)\b|\baws\s+s3api\s+put|\bgsutil\s+(cp|mv|rsync)\b|\bgcloud\s+storage\s+(cp|mv|rsync)\b|\baz\s+storage\b[^|;\n]*\bupload|\brclone\s+(copy|sync|move|copyto|moveto)\b|\bazcopy\b/i, 'cloud storage copy'],
];
const NET_TOOL = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i;

const GH_READ_SUB = new Set(['view', 'list', 'ls', 'status', 'diff', 'checks', 'checkout', 'download', 'watch', 'clone']);
const GH_READ_TOP = new Set(['search', 'browse', 'status', 'help', 'version', '--version', '--help']);
const checkGh = (cmd) => {
  const re = /(^|[\s;|&(])gh\s+([\w-]+)(?:\s+([\w-]+))?([^|;&\n]*)/g;
  let m;
  while ((m = re.exec(cmd))) {
    const [, , top, sub = '', rest] = m;
    if (GH_READ_TOP.has(top)) continue;
    if (top === 'api') {
      const all = ` ${sub} ${rest}`;
      if (/\s(-X|--method)[\s=]*(?!GET\b)\w+/i.test(all) || /\s(-f|-F|--field|--raw-field|--input)\b/.test(all)) return 'gh api write request';
      continue;
    }
    if (GH_READ_SUB.has(sub)) continue;
    return `gh ${top} ${sub}`.trim() + ' (write-type GitHub command)';
  }
  return null;
};

const SCRIPT_RE = /\b(?:python3?|py|node|deno|bun|Rscript|ruby|perl|pwsh|powershell)(?:\.exe)?\s+(?:-[\w-]+\s+)*['"]?([^\s'";|&]+\.(?:py|js|mjs|cjs|ts|R|rb|pl|ps1))\b/gi;
const toWinPath = (p) => (process.platform === 'win32' ? p.replace(/^\/mnt\/([a-z])\//i, '$1:/') : p);
const checkScripts = (cmd, cwd) => {
  const re = new RegExp(SCRIPT_RE.source, 'gi'); // fresh lastIndex per call
  let m;
  while ((m = re.exec(cmd))) {
    const file = path.resolve(cwd || process.cwd(), toWinPath(m[1]));
    let text;
    try {
      if (fs.statSync(file).size > SCRIPT_MAX_BYTES) continue;
      text = fs.readFileSync(file, 'utf8');
    } catch { continue; } // not a file we can read: nothing to scan
    const why = checkCode(text);
    if (why) return `script ${path.basename(file)} contains ${why}`;
  }
  return null;
};

const GUARD_FILE = /outbound-guard(\.test)?\.js/i;
const checkShell = (cmd, cwd) => {
  if (/disableAllHooks/i.test(cmd)) return 'command touches disableAllHooks';
  // A command that writes, moves or deletes the guard file: shell verbs, a redirect INTO the guard file,
  // or code (node/python) that writes or removes files while naming it. A plain "2>&1" is not a write.
  if (/outbound-guard/i.test(cmd) && (
    /\b(rm|mv|del|erase|ren|cp|tee|Remove-Item|Move-Item|Rename-Item|Copy-Item|Set-Content|Add-Content|Out-File|Clear-Content|New-Item)\b|\bsed\s+-i/i.test(cmd)
    || />>?\s*['"]?[^\s'"&|;]*outbound-guard/i.test(cmd)
    || /\b(writeFileSync|copyFileSync|appendFileSync|renameSync|unlinkSync|rmSync|writeFile|copyFile|shutil\.(copy|move)|os\.(remove|rename|replace))\b/.test(cmd))) {
    return 'command would modify the outbound guard';
  }
  for (const [re, why] of SHELL_RULES) if (re.test(cmd)) return why;
  const gh = checkGh(cmd);
  if (gh) return gh;
  if (NET_TOOL.test(cmd) && (/\$\(|`/.test(cmd) || /\|\s*(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b/i.test(cmd))) {
    return 'data piped or substituted into a network command';
  }
  const code = checkCode(cmd);
  if (code) return code;
  const url = checkUrls(cmd);
  if (url) return url;
  return checkScripts(cmd, cwd);
};

// ---------- edits that would disable the guard ----------
const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
const isSettings = (p) => /\/\.claude\/settings(\.local)?\.json$/.test(norm(p));
const checkEdit = (name, input) => {
  const file = norm(input.file_path || input.notebook_path);
  if (GUARD_FILE.test(file)) return 'edit to the outbound guard itself';
  const added = [input.new_string, input.content, ...(input.edits || []).map((e) => e.new_string)].filter(Boolean).join('\n');
  const removed = [input.old_string, ...(input.edits || []).map((e) => e.old_string)].filter(Boolean).join('\n');
  if (/"disableAllHooks"\s*:\s*true/.test(added)) return 'setting disableAllHooks would disable the outbound guard';
  if (isSettings(file)) {
    if (/outbound-guard/.test(removed) && !/outbound-guard/.test(added)) return 'edit would remove the outbound guard from settings';
    if (name === 'Write' && typeof input.content === 'string' && !/outbound-guard/.test(input.content)) {
      let current = '';
      try { current = fs.readFileSync(input.file_path, 'utf8'); } catch { /* new file */ }
      if (/outbound-guard/.test(current)) return 'rewrite would remove the outbound guard from settings';
    }
  }
  return null;
};

// ---------- MCP tools ----------
const MCP_WRITE = /(publish|upload|create|write|update|edit|delete|send|post|reply|comment|share|pin|copy|batch|form_input|str_replace|declare|merge)/i;
// Claude Desktop's own local tools (task list, wrap-up, sessions, sidebar, panes, windows, settings,
// folders, connectors) and the local widget renderer and design editor never send data off the machine.
// ccd_pr (GitHub pull requests) and the browser tools reach outside, so they stay checked.
const LOCAL_MCP = /^mcp__(ccd_(turn|session|session_mgmt|sidebar|view|window|settings|directory|host|connectors)|visualize|pencil)__/;
const checkMcp = (name, input) => {
  // Of the local session tools, two leave this computer: a session started on the cloud or on an
  // SSH machine, and moving a session to the cloud. Checked before the local exemption below.
  if (name === 'mcp__ccd_session__move_to_cloud') return 'moves this session to the cloud';
  if (name === 'mcp__ccd_session__start_session' && (input || {}).target === 'cloud') return 'starts a session on the cloud';
  if (name === 'mcp__ccd_session__start_session' && (input || {}).target === 'ssh') return 'starts a session on a remote (SSH) machine';
  if (LOCAL_MCP.test(name)) return null;
  // A tool that runs a shell command (the desktop app's terminal tool, and any like it): the command
  // gets exactly the shell checks, so a push or upload can't slip through by another door.
  if (typeof (input || {}).command === 'string') return checkShell(input.command);
  const tool = name.split('__').slice(2).join('__') || name;
  if (MCP_WRITE.test(tool)) return `MCP tool ${name} sends or publishes data`;
  const text = JSON.stringify(input || {});
  if (/javascript/i.test(tool) && /\bfetch\s*\(|XMLHttpRequest|sendBeacon|\.submit\s*\(|WebSocket/.test(text)) return 'page script would send data';
  return checkUrls(text);
};

const check = (inp) => {
  const name = inp.tool_name || '';
  const input = inp.tool_input || {};
  if (name === 'Bash' || name === 'PowerShell') return checkShell(String(input.command || ''), inp.cwd);
  if (name === 'WebFetch') return urlProblem(String(input.url || ''));
  if (name === 'RemoteTrigger') return 'remote triggers run work in the cloud';
  if (name === 'Agent' || name === 'Task') return input.isolation === 'remote' ? 'remote agents copy the workspace to the cloud' : null;
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return checkEdit(name, input);
  if (name.startsWith('mcp__')) return checkMcp(name, input);
  // Artifacts live on claude.ai: anything but reading, listing, opening or the read-only quickstart uploads.
  if (name === 'Artifact') {
    const action = input.action || 'publish';
    return ['read', 'list', 'open', 'quickstart', 'pin', 'unpin'].includes(action) ? null : `artifact ${action} on claude.ai`;
  }
  if (name === 'ArtifactData') return ['get', 'list', 'query'].includes(input.action) ? null : `artifact data ${input.action || 'write'} on claude.ai`;
  if (name === 'ArtifactComments') return /^(list|read|get|watch|unwatch)$/.test(String(input.action || '')) ? null : `artifact comment ${input.action || 'write'} on claude.ai`;
  return null;
};

// ---------- downloads: files or software coming onto this computer ----------
const DL_RULES = [
  // Strongest first: fetched code run straight away, never saved for a look (the classic virus route).
  [/\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(sudo\s+)?((ba|z|da)?sh|python3?|node|pwsh|powershell|iex|Invoke-Expression)\b|\b(iex|Invoke-Expression)\s*\(\s*(New-Object\s+Net\.WebClient|\(?\s*(iwr|irm|Invoke-WebRequest|Invoke-RestMethod))/i, 'download and run'],
  [new RegExp(`\\bgit\\b${SEG}\\s(clone|pull|fetch|submodule\\s+update|lfs\\s+(pull|fetch))\\b`, 'i'), 'git download'],
  [/\b(pip3?|uv\s+pip|python3?\s+-m\s+pip|py\s+-m\s+pip)\s+install\b|\buv\s+(add|sync)\b|\bpoetry\s+(install|add)\b|\b(conda|mamba|micromamba)\s+(install|create|update)\b|\b(npm|pnpm|yarn|bun)\s+(install|i|add|ci|update|upgrade)\b|\b(npx|pnpx|bunx)\s|\bcargo\s+(install|add|fetch)\b|\bgem\s+install\b|\bgo\s+(get|install)\b|\bapt(-get)?\s+install\b|\b(winget|choco|scoop|brew)\s+install\b|\bInstall-(Module|Package)\b/i, 'package install'],
  [/\b(docker|podman)\s+pull\b/i, 'container image download'],
  [/(^|[\s;|&(])gh\s+(repo\s+clone|release\s+download|run\s+download|gist\s+clone|pr\s+checkout)\b/i, 'GitHub download'],
  [/\b(huggingface-cli|hf)\s+download\b/i, 'model download'],
  [/\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-BitsTransfer)\b/i, 'web download'],
];
const checkDownloadShell = (cmd) => {
  for (const [re, why] of DL_RULES) {
    if (!re.test(cmd)) continue;
    // A web tool counts only when it reaches a non-local address.
    if (why === 'web download') {
      const remote = (cmd.match(URL_RE) || []).some((u) => { try { return !LOCAL_HOSTS.has(new URL(u).hostname); } catch { return false; } });
      if (!remote) continue;
    }
    return why;
  }
  return null;
};
// Asked only when check() found no upload.
const checkDownload = (inp) => {
  const name = inp.tool_name || '';
  const input = inp.tool_input || {};
  if (name === 'Bash' || name === 'PowerShell') return checkDownloadShell(String(input.command || ''));
  if (name.startsWith('mcp__') && typeof input.command === 'string') return checkDownloadShell(input.command);
  return null;
};

if (require.main === module) {
  let inp;
  try {
    inp = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch (e) {
    deny(`hook could not read its input (${e.message}); failing closed`);
  }
  try {
    const why = check(inp);
    if (why) ask(inp, why); // an upload wins over a download in the same call
    const dl = checkDownload(inp);
    if (dl) askDownload(inp, dl);
  } catch (e) {
    emit('ask', `⚠ UNCHECKED: the outbound guard failed (${cut(e.message, 60)}) on `
      + `${(() => { try { return exactCall(inp); } catch { return (inp && inp.tool_name) || 'this call'; } })()}. `
      + 'Allow = run once. Deny = block.');
  }
  process.exit(0);
}

module.exports = { check, checkDownload, urlProblem };
