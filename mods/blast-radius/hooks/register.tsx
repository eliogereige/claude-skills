import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BlastCheck, BlastFinding, BlastLevel } from '../types'

const PANE = 'blast-radius'
const RUN = 'Run it'
const CANCEL = 'Cancel'

const current = atom({ plugin: 'blast-radius', key: 'current' } as const, null)
const recent = atom({ plugin: 'blast-radius', key: 'recent' } as const, [])
const approved = atom({ plugin: 'blast-radius', key: 'approved' } as const, [])
const created = atom({ plugin: 'blast-radius', key: 'created' } as const, [])

type Risk =
  // `isBroad`: recursive or forced. A plain delete only counts in OneDrive.
  | { kind: 'delete'; targets: string[]; isBroad: boolean; isTrash: boolean }
  | { kind: 'git-rm'; targets: string[] }
  | { kind: 'code-delete' }
  | { kind: 'git-reset'; cwd?: string; ref: string | null }
  | { kind: 'git-push'; cwd?: string; args: string[] }
  | { kind: 'git-clean'; cwd?: string; args: string[] }
  | { kind: 'git-discard'; cwd?: string }
  | { kind: 'git-branch-delete'; cwd?: string; branches: string[] }
  | { kind: 'git-stash'; cwd?: string; sub: string }
  | { kind: 'find-delete' }
  | { kind: 'disk' }

// ---------------------------------------------------------------- parsing

const tokenize = (text: string) => {
  const words: string[] = []
  for (const m of text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) {
    words.push(m[1] ?? m[2] ?? m[3] ?? '')
  }

  return words
}

const PREFIXES = /^(sudo|command|exec|time|nohup|xargs|env|&)$/

const segments = (command: string): string[][] =>
  command
    .split(/&&|\|\||[;|\n]/)
    .map(part => {
      const words = tokenize(part.trim())
      while (words.length > 0 && (/^\w+=/.test(words[0]!) || PREFIXES.test(words[0]!))) {
        words.shift()
      }

      return words
    })
    .filter(words => words.length > 0)

const verbOf = (word: string) =>
  word.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase()

const isFlag = (word: string) => word.startsWith('-')

const DELETE_VERBS = new Set(['rm', 'remove-item', 'ri', 'del', 'erase', 'rd', 'rmdir', 'unlink', 'shred'])
const TRASH_VERBS = new Set(['trash', 'trash-put'])
// Deletes written as code rather than as a command (.NET, Python, Node).
const DELETE_CALLS =
  /\]::Delete\(|\.Delete\(\s*\$?\w*\s*\)|\bos\.(remove|unlink|rmdir)\(|\bshutil\.rmtree\(|\.unlink\(|\bfs\.(rm|rmSync|unlinkSync|rmdirSync)\(/
const ONEDRIVE = /onedrive/i
const CMD_FLAG = /^\/[a-z]$/i
const VALUE_PARAMS = /^-(filter|include|exclude|literalpath|path)$/i

const parseGit = (words: string[]) => {
  let i = 1
  let cwd: string | undefined
  while (i < words.length && isFlag(words[i]!)) {
    if (words[i] === '-C') {
      cwd = words[i + 1]
      i += 2
    } else if (words[i] === '-c') {
      i += 2
    } else {
      i += 1
    }
  }

  return { sub: words[i] ?? '', rest: words.slice(i + 1), cwd }
}

const detectSegment = (words: string[]): Risk[] => {
  const verb = verbOf(words[0]!)
  const args = words.slice(1)

  if (DELETE_VERBS.has(verb) || TRASH_VERBS.has(verb)) {
    const flags = args.filter(w => isFlag(w) || CMD_FLAG.test(w))
    if (flags.some(f => /^-whatif$/i.test(f))) return []
    const isBroad = flags.some(
      f =>
        /^--?(recurse|recursive|force)$/i.test(f) ||
        /^-[a-z]*[rf][a-z]*$/i.test(f) ||
        /^\/s$/i.test(f),
    )
    const targets: string[] = []
    for (let i = 0; i < args.length; i += 1) {
      const word = args[i]!
      if (/^-(filter|include|exclude)$/i.test(word)) {
        i += 1
      } else if (!isFlag(word) && !CMD_FLAG.test(word)) {
        targets.push(word)
      } else if (VALUE_PARAMS.test(word) && args[i + 1] !== undefined) {
        targets.push(args[i + 1]!)
        i += 1
      }
    }

    return [{ kind: 'delete', targets, isBroad, isTrash: TRASH_VERBS.has(verb) }]
  }

  if (verb === 'git') {
    const { sub, rest, cwd } = parseGit(words)
    const positional = rest.filter(w => !isFlag(w))

    if (sub === 'reset' && rest.includes('--hard')) {
      return [{ kind: 'git-reset', cwd, ref: positional[0] ?? null }]
    }
    if (sub === 'push') {
      const isForce = rest.some(
        w =>
          /^--force(-with-lease(=.*)?|-if-includes)?$/.test(w) ||
          /^-[a-z]*f[a-z]*$/.test(w) ||
          w === '--mirror' ||
          w === '--delete' ||
          w === '-d',
      )
      const isForcedSpec = positional.slice(1).some(w => w.startsWith('+') || w.startsWith(':'))
      if (isForce || isForcedSpec) return [{ kind: 'git-push', cwd, args: rest }]
    }
    if (sub === 'clean') {
      const isDryRun = rest.some(w => /^-[a-z]*n/i.test(w) || w === '--dry-run')
      const isForce = rest.some(w => /^-[a-z]*f/i.test(w) || w === '--force')
      if (isForce && !isDryRun) return [{ kind: 'git-clean', cwd, args: rest }]
    }
    if (sub === 'checkout' && (rest.includes('--') || positional[0] === '.' || rest.includes('-f'))) {
      return [{ kind: 'git-discard', cwd }]
    }
    if (sub === 'restore' && (!rest.includes('--staged') || rest.includes('--worktree'))) {
      return [{ kind: 'git-discard', cwd }]
    }
    if (
      sub === 'branch' &&
      (rest.includes('-D') || (rest.includes('--delete') && rest.includes('--force')))
    ) {
      return [{ kind: 'git-branch-delete', cwd, branches: positional }]
    }
    if (sub === 'stash' && (positional[0] === 'drop' || positional[0] === 'clear')) {
      return [{ kind: 'git-stash', cwd, sub: positional[0] }]
    }
    if (sub === 'rm' && !rest.includes('--cached') && !rest.includes('-n') && !rest.includes('--dry-run')) {
      return [{ kind: 'git-rm', targets: positional }]
    }

    return []
  }

  if (verb === 'find') {
    const execAt = args.indexOf('-exec')
    const execsRm = execAt >= 0 && verbOf(args[execAt + 1] ?? '') === 'rm'
    if (args.includes('-delete') || execsRm) return [{ kind: 'find-delete' }]
  }

  if (
    /^mkfs/.test(verb) ||
    ['format', 'diskpart', 'format-volume', 'clear-disk'].includes(verb) ||
    (verb === 'dd' && args.some(w => w.startsWith('of=')))
  ) {
    return [{ kind: 'disk' }]
  }

  return []
}

/** Each risky piece of the command, with the words it was found in. */
const detect = (command: string, depth = 0): (Risk & { text: string })[] => [
  ...segments(command).flatMap(words => [
    ...detectSegment(words).map(risk => ({ ...risk, text: words.map(w => (/\s/.test(w) ? `"${w}"` : w)).join(' ') })),
    // A quoted script handed to a shell (`bash -c "rm -rf x"`) is checked too.
    ...(depth < 2
      ? words.filter(w => /\s/.test(w)).flatMap(inner => detect(inner, depth + 1))
      : []),
  ]),
  ...(depth === 0 && DELETE_CALLS.test(command)
    ? [{ kind: 'code-delete' as const, text: command.match(DELETE_CALLS)![0] }]
    : []),
]

// ---------------------------------------------------------------- previews, in plain words

const cap = (all: string[], max = 12) =>
  all.length > max ? [...all.slice(0, max), `… and ${all.length - max} more`] : all

const splitLines = (text: string | null) =>
  text === null ? [] : text.split(/\r?\n/).filter(line => line.trim() !== '')

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`

const formatBytes = (n: number) =>
  n >= 1e9
    ? `${(n / 1e9).toFixed(1)} GB`
    : n >= 1e6
      ? `${(n / 1e6).toFixed(1)} MB`
      : n >= 1e3
        ? `${Math.round(n / 1e3)} KB`
        : `${n} B`

const SAFE_REF = /^[\w./@{}~^-]+$/

const git = async ($: EngineInterface, cwd: string | undefined, args: string[]) => {
  try {
    const ran = await $.process.run(['git', ...args], { cwd, timeoutMs: 8000 })

    return ran.exitCode === 0 ? ran.stdout.trimEnd() : null
  } catch {
    return null
  }
}

const homeOf = async ($: EngineInterface) => (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '~'

const localPath = async ($: EngineInterface, raw: string) =>
  raw
    .replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:')
    .replace(/^(~|\$HOME|\$env:USERPROFILE|%USERPROFILE%)(?=$|[\\/])/i, await homeOf($))

/** The variables the command itself sets (`S="..."`, `$S = '...'`), so `rm -rf "$S"` can name the real folder. */
const assignments = (command: string) => {
  const vars = new Map<string, string>()
  for (const m of command.matchAll(/(?:^|[\s;&|(])\$?([A-Za-z_]\w*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;&|)]+))/g)) {
    vars.set(m[1]!, m[2] ?? m[3] ?? m[4] ?? '')
  }

  return vars
}

/** The usual folder variables, read by name (a mod lists what it reads). */
const knownFolders = async ($: EngineInterface) => {
  const known = new Map<string, string>()
  const pairs: [string, string | undefined][] = [
    ['TEMP', await $.env.get('TEMP')],
    ['TMP', await $.env.get('TMP')],
    ['HOME', await $.env.get('HOME')],
    ['USERPROFILE', await $.env.get('USERPROFILE')],
    ['APPDATA', await $.env.get('APPDATA')],
    ['LOCALAPPDATA', await $.env.get('LOCALAPPDATA')],
  ]
  for (const [name, value] of pairs) if (value !== undefined) known.set(name, value)

  return known
}

/** `$VAR`, `${VAR}`, `$env:VAR` and `%VAR%` filled in from the command's own assignments, then the usual folders. */
const expand = async ($: EngineInterface, text: string, vars: Map<string, string>) => {
  const known = await knownFolders($)

  return text.replace(/\$env:([A-Za-z_]\w*)|\$\{?([A-Za-z_]\w*)\}?|%([A-Za-z_]\w*)%/g, (whole, a?: string, b?: string, c?: string) => {
    const name = (a ?? b ?? c)!
    return vars.get(name) ?? known.get(name.toUpperCase()) ?? whole
  })
}

/** A path as a person reads it: the home folder as ~, long ones cut to their last folders. */
const friendly = (path: string, home: string) => {
  const p = path.replace(/\\/g, '/')
  const h = home.replace(/\\/g, '/')
  let shown = h !== '~' && p.toLowerCase().startsWith(h.toLowerCase()) ? `~${p.slice(h.length)}` : p
  const parts = shown.split('/').filter(Boolean)
  if (parts.length > 4) shown = `…/${parts.slice(-3).join('/')}`

  return shown
}

/** What a check knows besides the command: its variables, the working folder, the temp folders, Claude's own files. */
type Context = {
  command: string
  vars: Map<string, string>
  cwd: string
  temps: string[]
  created: Set<string>
  /** The command changes folder (`cd`, `pushd`, `git -C`, ...): relative paths and git previews can't be trusted. */
  isCwdUncertain: boolean
  /** The command runs in WSL: its paths are Linux paths a Windows stat can't see. */
  isWsl: boolean
}

const MOVES_DIR = /(^|[\s;&|(])(cd|pushd|popd|chdir|set-location|sl|push-location|pop-location)(\s|$)/i
const GIT_DASH_C = /\bgit(\.exe)?\s+(-c\s+\S+\s+)*-C\s/
const WSL = /\bwsl(\.exe)?\b/i

/** A path as a comparable key: forward slashes, lowercase, `.` and `..` folded, no trailing slash. */
const norm = (path: string) => {
  const parts: string[] = []
  for (const seg of path.replace(/\\/g, '/').split('/')) {
    if (seg === '.' || (seg === '' && parts.length > 0)) continue
    if (seg === '..') {
      if (parts.length > 1) parts.pop()
      continue
    }
    parts.push(seg)
  }

  return parts.join('/').toLowerCase()
}

const isAbsolute = (path: string) => /^([a-z]:|[\\/])/i.test(path)

/** True when the command, or the folder it runs in, is in OneDrive. */
const isOneDriveHere = (ctx: Context) => ONEDRIVE.test(ctx.command) || ONEDRIVE.test(ctx.cwd)

const GLOB = /[*?[]/

/**
 * Inside a temp folder, one level down at least, and not a pattern over the temp folder itself:
 * `Temp/pytest-1/x` is scratch, `Temp/*` is not (other apps keep files there too).
 */
const isScratchPath = (n: string, ctx: Context) => {
  const usual = n.match(/^.*?\/appdata\/local\/temp(?=\/)/)?.[0]
  const roots = [...ctx.temps, '/tmp', ...(usual === undefined ? [] : [usual])]

  return roots.some(root => {
    if (!n.startsWith(`${root}/`)) return false
    const [first = '', second = ''] = n.slice(root.length + 1).split('/')
    // Temp/claude holds every session's scratch: only a folder inside it counts.
    if (first === 'claude') return second !== '' && !GLOB.test(second)
    return first !== '' && !GLOB.test(first)
  })
}

/** Where a path is, when that matters to how risky deleting it is. `real` is where its links lead. */
const placeOf = (path: string, ctx: Context, real?: string) => {
  const n = norm(path)
  const r = real === undefined ? n : norm(real)
  const isOneDrive = ONEDRIVE.test(n) || ONEDRIVE.test(r)
  if (ctx.created.has(n) || ctx.created.has(r)) return { label: 'made by Claude this session', isScratch: true, isOneDrive }
  // Both the written path and where it really leads must be scratch: a link out of Temp is not.
  if (!isOneDrive && isScratchPath(n, ctx) && isScratchPath(r, ctx)) {
    return { label: /\/claude\//.test(n) ? "Claude's own temporary folder" : 'your temporary folder', isScratch: true, isOneDrive }
  }
  if (isOneDrive) return { label: 'in your OneDrive (synced to the cloud)', isScratch: false, isOneDrive }
  if (/\/\.claude\//.test(`${n}/`)) return { label: "Claude Code's settings and mods", isScratch: false, isOneDrive }

  return { label: '', isScratch: false, isOneDrive }
}

const survey = async ($: EngineInterface, root: string) => {
  let files = 0
  let folders = 0
  let bytes = 0
  let budget = 4000
  const sample: string[] = []
  const queue = [root]

  while (queue.length > 0 && budget > 0) {
    const dir = queue.shift()!
    const entries = await $.fs.list(dir).catch(() => [])
    for (const entry of entries) {
      budget -= 1
      if (budget <= 0) break
      const path = `${dir.replace(/[\\/]$/, '')}/${entry.name}`
      if (entry.kind === 'dir') {
        folders += 1
        queue.push(path)
      } else {
        files += 1
        bytes += entry.size
        if (sample.length < 5) sample.push(path.slice(root.length + 1))
      }
    }
  }

  return { files, folders, bytes, sample, isPartial: budget <= 0 }
}

const BROAD = /^(\/|~|\*|\.|\.\.|[a-z]:[\\/]?|\$HOME|\$env:USERPROFILE)$/i
const NO_UNDO = "Can't be undone: it skips the Recycle Bin."

/**
 * What deleting `targets` would destroy, or null when it is not worth a finding:
 * a plain (not recursive, not forced) delete only counts in OneDrive.
 */
const previewDelete = async (
  $: EngineInterface,
  { targets, isBroad: isBroadCommand, isTrash }: { targets: string[]; isBroad: boolean; isTrash: boolean },
  ctx: Context,
): Promise<BlastFinding | null> => {
  const undo = isTrash ? 'Goes to the trash, so it can be restored from there.' : NO_UNDO
  if (targets.length === 0) {
    if (!isBroadCommand && !isOneDriveHere(ctx)) return null

    return {
      headline: isTrash ? 'Move files to the trash' : 'Permanently delete files',
      title: "Which files isn't written in the command (they come from a pipe or a list).",
      lines: [],
      level: isTrash ? 'medium' : 'high',
      undo,
    }
  }

  const home = await homeOf($)
  const lines: string[] = []
  let files = 0
  let bytes = 0
  let folders = 0
  let existing = 0
  let isBroad = false
  let isScratchOnly = true
  let isPrecious = false
  let isOneDrive = false
  // A target the mod can't look at counts as there and not scratch: unsure is never low.
  let unseen = 0
  const unsure = (line: string) => {
    lines.push(line)
    existing += 1
    unseen += 1
    isScratchOnly = false
  }
  for (const raw of targets.slice(0, 8)) {
    const target = await expand($, raw, ctx.vars)
    const local = await localPath($, target)
    const isUnresolved = /\$|%\w+%/.test(target)
    const isRelative = !isAbsolute(local)
    const path = isRelative && !isUnresolved ? `${ctx.cwd.replace(/[\\/]$/, '')}/${local}` : local
    // OneDrive rule: the command names OneDrive, or a relative path runs in a OneDrive folder.
    if (ONEDRIVE.test(ctx.command) || ((isRelative || isUnresolved) && ONEDRIVE.test(ctx.cwd))) isOneDrive = true
    if (BROAD.test(target)) {
      isBroad = true
      isScratchOnly = false
      lines.push(`‼ ${target}: a whole drive, home or current folder`)
    }
    if (isUnresolved) {
      unsure(`• ${target}  (set while the command runs; can't look inside)`)
      continue
    }
    if (isRelative && ctx.isCwdUncertain) {
      unsure(`• ${target}  (the command changes folder first, so where this is isn't known)`)
      continue
    }
    const isWindowsPath = /^[a-z]:\//.test(norm(path))
    if ((ctx.isWsl && !/^\/tmp\//.test(target)) || (!isWindowsPath && !/^\/tmp\//.test(norm(path)))) {
      unsure(`• ${target}  (a Linux/WSL path Windows can't look inside)`)
      continue
    }
    if (GLOB.test(target)) {
      const place = placeOf(path, ctx)
      if (place.isOneDrive) isOneDrive = true
      if (place.label !== '' && !place.isScratch) isPrecious = true
      lines.push(`• ${friendly(path, home)}  (everything this pattern matches)${place.label === '' ? '' : `  · ${place.label}`}`)
      isScratchOnly = isScratchOnly && place.isScratch
      existing += 1
      continue
    }
    let failure = ''
    const stat = await $.fs.stat(path, { resolve: true }).catch((err: unknown) => {
      failure = String((err as Error)?.message ?? err)
      return undefined
    })
    if (stat === undefined && !/ENOENT|no such file|not found|cannot find/i.test(failure)) {
      unsure(`• ${friendly(path, home)}  (couldn't look at it: ${failure.slice(0, 80)})`)
      continue
    }
    const place = placeOf(path, ctx, stat?.realPath)
    if (place.isOneDrive) isOneDrive = true
    if (!place.isScratch) isScratchOnly = false
    if (place.label !== '' && !place.isScratch) isPrecious = true
    const where = place.label === '' ? '' : `  · ${place.label}`
    if (stat === undefined) {
      lines.push(`• ${friendly(path, home)}  (not there: nothing to delete)${where}`)
    } else if (stat.kind === 'dir') {
      existing += 1
      folders += 1
      const found = await survey($, path)
      files += found.files
      bytes += found.bytes
      lines.push(
        `• ${friendly(path, home)}/  folder with ${plural(found.files, 'file')}${found.isPartial ? '+' : ''}, ${formatBytes(found.bytes)}${where}`,
      )
      for (const one of found.sample) lines.push(`     ${one}`)
    } else {
      existing += 1
      files += 1
      bytes += stat.size
      lines.push(`• ${friendly(path, home)}  file, ${formatBytes(stat.size)}${where}`)
    }
  }
  if (targets.length > 8) unsure(`… and ${targets.length - 8} more, not looked at`)
  if (!isBroadCommand && !isOneDrive) return null

  const what = targets.length > 1 ? plural(targets.length, 'item') : folders === 1 ? 'a folder' : files === 1 ? 'a file' : 'a file or folder'
  // Low risk runs without asking: nothing there, or only temp files and files Claude made this session.
  const level: BlastLevel =
    existing === 0
      ? 'low'
      : isBroad
        ? isTrash ? 'medium' : 'high'
        : isScratchOnly
          ? 'low'
          : isTrash
            ? isOneDrive ? 'medium' : 'low'
            : isPrecious || files > 100 ? 'high' : 'medium'

  return {
    headline: isTrash ? `Move ${what} to the trash` : `Permanently delete ${what}`,
    title:
      existing === 0
        ? 'Nothing there yet, so nothing would be deleted.'
        : unseen > 0
          ? `Couldn't see what ${unseen === 1 ? 'one target holds' : `${unseen} targets hold`}${files > 0 ? `; ${plural(files, 'file')} (${formatBytes(bytes)}) seen` : ''}.`
          : `${plural(files, 'file')} (${formatBytes(bytes)}) would be gone.`,
    lines,
    level,
    undo,
  }
}

/** `git rm` and deletes written in a script: only in OneDrive, where a synced delete is hardest to undo. */
const previewGitRm = async ($: EngineInterface, targets: string[], ctx: Context): Promise<BlastFinding | null> => {
  const paths = targets.map(t => (isAbsolute(t) ? t : `${ctx.cwd.replace(/[\\/]$/, '')}/${t}`))
  const reals = await Promise.all(paths.slice(0, 10).map(p => $.fs.stat(p, { resolve: true }).then(s => s.realPath, () => undefined)))
  const isOneDrive = isOneDriveHere(ctx) || paths.some((p, i) => placeOf(p, ctx, reals[i]).isOneDrive)
  if (!isOneDrive) return null

  return {
    headline: 'Delete files tracked by git (git rm) in your OneDrive',
    title: targets.length === 0 ? 'Which files depends on the command.' : `${plural(targets.length, 'path')}: ${cap(targets, 6).join(', ')}`,
    lines: [],
    level: 'medium',
    undo: 'The last committed version can be restored with git; uncommitted edits are lost.',
  }
}

const previewCodeDelete = (ctx: Context): BlastFinding | null =>
  isOneDriveHere(ctx)
    ? {
        headline: 'A script deletes files, in your OneDrive',
        title: "Which files depends on the script; they aren't listed here.",
        lines: [],
        level: 'high',
        undo: 'Usually skips the Recycle Bin, so it usually cannot be undone.',
      }
    : null

/** When git itself failed (not a repo, timed out, not installed): unsure, so never low. */
const unchecked = (headline: string, undo: string): BlastFinding => ({
  headline,
  title: "Couldn't check with git what would be lost, so assume something would.",
  lines: [],
  level: 'medium',
  undo,
})

const previewReset = async (
  $: EngineInterface,
  cwd: string | undefined,
  ref: string | null,
): Promise<BlastFinding[]> => {
  const raw = await git($, cwd, ['status', '--porcelain'])
  if (raw === null) return [unchecked('Throw away all unsaved code changes (git reset --hard)', "Uncommitted edits can't be recovered.")]
  const status = splitLines(raw).filter(
    line => !line.startsWith('??'),
  )
  const findings: BlastFinding[] = [
    {
      headline: 'Throw away all unsaved code changes (git reset --hard)',
      title:
        status.length === 0
          ? 'There are no uncommitted changes, so nothing is lost.'
          : `Your uncommitted edits to ${plural(status.length, 'file')} would be lost.`,
      lines: cap(status),
      level: status.length === 0 ? 'low' : 'high',
      undo: status.length === 0 ? 'Nothing to undo.' : "Uncommitted edits can't be recovered.",
    },
  ]
  if (ref !== null && SAFE_REF.test(ref)) {
    const droppedRaw = await git($, cwd, ['log', '--oneline', '-n', '20', 'HEAD', '--not', ref])
    if (droppedRaw === null) findings.push(unchecked(`Move the branch back to ${ref}`, 'Recoverable for a few weeks with git reflog.'))
    const dropped = splitLines(droppedRaw)
    if (dropped.length > 0) {
      findings.push({
        headline: `Move the branch back to ${ref}`,
        title: `${plural(dropped.length, 'commit')} would drop off the branch.`,
        lines: cap(dropped),
        level: 'medium',
        undo: 'Recoverable for a few weeks with git reflog.',
      })
    }
  }

  return findings
}

const previewPush = async (
  $: EngineInterface,
  cwd: string | undefined,
  args: string[],
): Promise<BlastFinding> => {
  const branch = await git($, cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const positional = args.filter(w => !isFlag(w))
  const remote = positional[0] ?? 'origin'
  const spec = (positional[1] ?? branch ?? 'HEAD').replace(/^\+/, '')
  const [src = 'HEAD', dst = src] = spec.includes(':') ? spec.split(':') : [spec, spec]
  const target = dst === 'HEAD' ? (branch ?? 'HEAD') : dst
  const isDelete = args.includes('--delete') || args.includes('-d') || src === ''
  const tracking = `refs/remotes/${remote}/${target}`
  const headline = isDelete ? `Delete the branch ${target} on GitHub/${remote}` : `Force-push to ${remote}/${target}, replacing what's there`

  if (![remote, target, src || 'HEAD'].every(name => SAFE_REF.test(name))) {
    return { headline, title: "Couldn't work out which branches are involved.", lines: [], level: 'high', undo: 'Hard to undo once others have pulled.' }
  }
  if ((await git($, cwd, ['rev-parse', '--verify', '--quiet', tracking])) === null) {
    return {
      headline,
      title: `No local copy of ${remote}/${target} to compare with (run git fetch to see what's there).`,
      lines: [],
      level: 'high',
      undo: 'Hard to undo once others have pulled.',
    }
  }

  const lostRaw = await git($, cwd, ['log', '--oneline', '-n', '20', tracking, '--not', isDelete ? 'HEAD' : src || 'HEAD'])
  if (lostRaw === null) return unchecked(headline, 'Hard to undo once others have pulled.')
  const lost = splitLines(lostRaw)
  if (isDelete) {
    return {
      headline,
      title: lost.length > 0 ? `${plural(lost.length, 'commit')} exist only there and would be lost.` : 'Every commit on it is also here, so nothing is lost.',
      lines: cap(lost),
      level: lost.length > 0 ? 'high' : 'medium',
      undo: lost.length > 0 ? 'Lost unless someone else has a copy.' : 'The branch can be pushed again.',
    }
  }
  const pushed = splitLines(await git($, cwd, ['log', '--oneline', '-n', '20', src || 'HEAD', '--not', tracking]))

  return {
    headline,
    title:
      lost.length === 0
        ? `Nothing on ${remote}/${target} would be lost; ${plural(pushed.length, 'commit')} would be added.`
        : `${plural(lost.length, 'commit')} on ${remote}/${target} would be overwritten.`,
    lines: [
      ...(lost.length > 0 ? ['Lost from the remote:', ...cap(lost, 8)] : []),
      ...(pushed.length > 0 ? ['Pushed:', ...cap(pushed, 6)] : []),
      '(as of your last git fetch)',
    ],
    level: lost.length > 0 ? 'high' : 'low',
    undo: lost.length > 0 ? 'Lost unless someone else has a copy.' : 'Nothing to undo.',
  }
}

const previewClean = async ($: EngineInterface, cwd: string | undefined, args: string[]): Promise<BlastFinding> => {
  const letters = [...new Set(args.filter(w => /^-[a-z]+$/i.test(w)).join('').replace(/[^dxX]/g, ''))]
  const paths = args.filter(w => !isFlag(w))
  const raw = await git($, cwd, [
    'clean',
    '-n',
    ...(letters.length > 0 ? [`-${letters.join('')}`] : []),
    ...(paths.length > 0 ? ['--', ...paths] : []),
  ])
  if (raw === null) return unchecked("Delete files git doesn't track (git clean)", "Can't be undone: git never had a copy.")
  const removed = splitLines(raw).map(line => line.replace(/^Would remove /, ''))

  return {
    headline: "Delete files git doesn't track (git clean)",
    title: removed.length === 0 ? 'No untracked files, so nothing is deleted.' : `${plural(removed.length, 'untracked file')} would be deleted.`,
    lines: cap(removed),
    level: removed.length === 0 ? 'low' : 'high',
    undo: "Can't be undone: git never had a copy.",
  }
}

const some = (finding: BlastFinding | null) => (finding === null ? [] : [finding])

const preview = async ($: EngineInterface, risk: Risk, ctx: Context): Promise<BlastFinding[]> => {
  switch (risk.kind) {
    case 'delete':
      return some(await previewDelete($, risk, ctx))
    case 'git-rm':
      return some(await previewGitRm($, risk.targets, ctx))
    case 'code-delete':
      return some(previewCodeDelete(ctx))
    case 'git-reset':
      return previewReset($, risk.cwd, risk.ref)
    case 'git-push':
      return [await previewPush($, risk.cwd, risk.args)]
    case 'git-clean':
      return [await previewClean($, risk.cwd, risk.args)]
    case 'git-discard': {
      const raw = await git($, risk.cwd, ['diff', '--stat'])
      if (raw === null) return [unchecked('Throw away unsaved edits to files (git checkout / restore)', "Uncommitted edits can't be recovered.")]
      const stat = splitLines(raw)
      return [
        {
          headline: 'Throw away unsaved edits to files (git checkout / restore)',
          title: stat.length === 0 ? 'No unsaved edits, so nothing is lost.' : `Edits would be lost: ${stat[stat.length - 1]!.trim()}.`,
          lines: cap(stat.slice(0, -1)),
          level: stat.length === 0 ? 'low' : 'high',
          undo: "Uncommitted edits can't be recovered.",
        },
      ]
    }
    case 'git-branch-delete':
      return Promise.all(
        risk.branches.filter(b => SAFE_REF.test(b)).map(async (b): Promise<BlastFinding> => {
          const raw = await git($, risk.cwd, ['log', '--oneline', '-n', '20', b, '--not', '--remotes', 'HEAD'])
          if (raw === null) return unchecked(`Delete the git branch ${b}`, 'Recoverable for a few weeks with git reflog.')
          const only = splitLines(raw)
          return {
            headline: `Delete the git branch ${b}`,
            title: only.length === 0 ? 'All its commits are also elsewhere, so nothing is lost.' : `${plural(only.length, 'commit')} exist only on it.`,
            lines: cap(only),
            level: only.length === 0 ? 'low' : 'high',
            undo: 'Recoverable for a few weeks with git reflog.',
          }
        }),
      )
    case 'git-stash': {
      const raw = await git($, risk.cwd, ['stash', 'list'])
      if (raw === null) return [unchecked('Delete saved git stashes', 'Very hard to recover.')]
      const stashes = splitLines(raw)
      return [
        risk.sub === 'clear'
          ? { headline: 'Delete all your saved git stashes', title: `${plural(stashes.length, 'stash')} would be deleted.`, lines: cap(stashes), level: stashes.length === 0 ? 'low' : 'high', undo: 'Very hard to recover.' }
          : { headline: 'Delete a saved git stash', title: 'The newest stash would be deleted.', lines: stashes.slice(0, 1), level: 'medium', undo: 'Very hard to recover.' },
      ]
    }
    case 'find-delete':
      return [{ headline: 'Delete every file a search finds', title: "Which files depends on what the search matches; it isn't listed here.", lines: [], level: 'high', undo: NO_UNDO }]
    case 'disk':
      return [{ headline: 'Write straight to a disk or drive', title: 'This can wipe a whole drive.', lines: [], level: 'high', undo: "Can't be undone." }]
  }
}

// ---------------------------------------------------------------- the check

const LEVELS: Record<BlastLevel, { label: string; color: string }> = {
  low: { label: 'LOW RISK', color: '#3fb950' },
  medium: { label: 'MEDIUM RISK', color: '#e3b341' },
  high: { label: 'HIGH RISK', color: '#f85149' },
}
const RANK: Record<BlastLevel, number> = { low: 0, medium: 1, high: 2 }
const worst = (findings: BlastFinding[]): BlastLevel =>
  findings.reduce<BlastLevel>((top, f) => (RANK[f.level] > RANK[top] ? f.level : top), 'low')

const review = async (
  $: EngineInterface,
  tool: string,
  command: string,
  description: string | undefined,
  id: string,
): Promise<string | null> => {
  const risks = detect(command)
  if (risks.length === 0) return null

  const temps = [...new Set([await $.env.get('TEMP'), await $.env.get('TMP')].filter((t): t is string => t !== undefined).map(norm))]
  const ctx: Context = {
    command,
    vars: assignments(command),
    cwd: await $.session.cwd(),
    temps,
    created: new Set((await $.state.get({ plugin: 'blast-radius', key: 'created' })).value ?? []),
    isCwdUncertain: MOVES_DIR.test(command) || GIT_DASH_C.test(command),
    isWsl: WSL.test(command),
  }
  const found = await Promise.all(
    risks.map(async risk => {
      const findings = await preview($, risk, ctx)
      // After a folder change, git looked in the wrong place: its "nothing to lose" can't be trusted.
      const isGitElsewhere = risk.kind.startsWith('git-') && (ctx.isCwdUncertain || ctx.isWsl)

      return {
        risk,
        findings: isGitElsewhere
          ? findings.map(f => (f.level === 'low' ? { ...f, level: 'medium' as const, title: `${f.title} (checked in the wrong folder: the command changes folder first)` } : f))
          : findings,
      }
    }),
  )
  const findings = found.flatMap(one => one.findings)
  if (findings.length === 0) return null
  const snippet = [...new Set(found.filter(one => one.findings.length > 0).map(one => one.risk.text))].join('\n')
  const check: BlastCheck = { id, tool, command, description, snippet, findings, verdict: 'pending' }

  // Low risk (temp files, Claude's own files, nothing there, no work lost): logged, not asked.
  if (worst(findings) === 'low') {
    await update($, recent, list => [{ ...check, verdict: 'quiet' as const }, ...list.filter(one => one.id !== id)].slice(0, 10))
    return null
  }

  await update($, current, () => check)
  void $.ui.open({ id: PANE, title: 'Blast radius' })

  const level = LEVELS[worst(findings)]
  const said = findings.map(f => `• ${f.headline}: ${f.title}`).join('\n')
  const why = description ? `Claude says: "${description}"\n` : ''
  // The dialog's header holds 12 characters: the risk level leads the question instead.
  const answer = await $.ui
    .ask(`${level.label}\n${why}${said}\n${findings[0]!.undo}\nLet it run?`, {
      header: 'Blast radius',
      options: [RUN, CANCEL],
    })
    .catch(() => CANCEL)
  const isAllowed = answer === RUN
  const decided: BlastCheck = { ...check, verdict: isAllowed ? 'allowed' : 'blocked' }
  await update($, current, () => decided)
  await update($, recent, list => [decided, ...list.filter(one => one.id !== id)].slice(0, 10))

  if (isAllowed) {
    await update($, approved, list => [...list, id].slice(-50))
    return null
  }
  const summary = findings.map(f => `${f.headline}: ${f.title}`).join('; ')
  const reply = answer === CANCEL ? '' : ` The user said: "${answer}".`

  return `Blast Radius: the user did not allow this command (${summary}).${reply} Do not retry it; ask the user how to proceed.`
}

/**
 * `review`, but a failure inside the check asks instead of letting the command through
 * (a hook that throws is skipped, and the command would run unchecked).
 */
const guarded = async (
  $: EngineInterface,
  tool: string,
  command: string,
  description: string | undefined,
  id: string,
): Promise<string | null> => {
  try {
    return await review($, tool, command, description, id)
  } catch (err) {
    if (detect(command).length === 0) return null
    const shown = command.length > 160 ? `${command.slice(0, 157)}...` : command
    const answer = await $.ui
      .ask(`Blast Radius couldn't check this command (${String((err as Error)?.message ?? err).slice(0, 80)}):\n${shown}\nLet it run?`, {
        header: 'Blast radius',
        options: [RUN, CANCEL],
      })
      .catch(() => CANCEL)

    return answer === RUN ? null : 'Blast Radius: the check failed and the user did not allow this command. Do not retry it; ask the user how to proceed.'
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'blast-radius',
      description: 'Open the Blast Radius pane: the last risky commands Claude tried and what they would touch',
    })

    return next(e)
  })

  on('command.run', { command: 'blast-radius' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Blast radius' })

    return { text: 'Blast Radius pane opened.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const denied = await guarded($, e.tool, String(e.command), typeof e.description === 'string' ? e.description : undefined, e.tool_use_id)
    return denied === null ? next(e) : { deny: denied }
  })

  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const denied = await guarded($, e.tool, String(e.command), typeof e.description === 'string' ? e.description : undefined, e.tool_use_id)
    return denied === null ? next(e) : { deny: denied }
  })

  // Files Claude creates are its own: deleting them later is low risk.
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const path = String(e.file_path)
    const isNew = (await $.fs.stat(path).catch(() => undefined)) === undefined
    const result = await next(e)
    if (isNew && !('deny' in result) && !('isError' in result && result.isError)) {
      await update($, created, list => [...list.filter(p => p !== norm(path)), norm(path)].slice(-500))
    }

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const check = await read($, current)
    const past = (await read($, recent)).filter(one => one.id !== check?.id).slice(0, 5)
    const verdict =
      check?.verdict === 'allowed'
        ? { text: '✔ You let it run', color: '#3fb950' }
        : check?.verdict === 'blocked'
          ? { text: '✖ You stopped it', color: '#f85149' }
          : { text: '⏳ Waiting for your answer', color: '#e3b341' }
    const commandLines = check?.command.split(/\r?\n/) ?? []

    return (
      <Box flexDirection="column" rowGap={1}>
        {check === null && <Text dimColor>No risky commands so far. 🛡</Text>}
        {check !== null && (
          <Box flexDirection="column">
            <Text bold>Claude wants to run a command that can destroy things.</Text>
            {check.description !== undefined && (
              <Text italic wrap="wrap">
                Claude says it will: "{check.description}"
              </Text>
            )}
            <Text bold color={verdict.color}>{verdict.text}</Text>
          </Box>
        )}
        {check?.findings.map((finding, i) => {
          const level = LEVELS[finding.level]
          return (
            <Box key={`f${i}`} flexDirection="column">
              <Box flexDirection="row" columnGap={1}>
                <Text bold backgroundColor={level.color} color="#141413">{` ${level.label} `}</Text>
                <Text bold wrap="wrap">{finding.headline}</Text>
              </Box>
              <Text wrap="wrap">{finding.title}</Text>
              {finding.lines.map((line, j) => (
                <Text key={`l${j}`} dimColor wrap="truncate-end">
                  {line}
                </Text>
              ))}
              <Text color={level.color} wrap="wrap">↺ {finding.undo}</Text>
            </Box>
          )
        })}
        {check !== null && (
          <Box flexDirection="column">
            <Text dimColor>The risky part of the command:</Text>
            <Text color="cyan" wrap="wrap">
              {check.snippet}
            </Text>
            {commandLines.length > 1 && (
              <Text dimColor wrap="truncate-end">
                {`(part of a ${commandLines.length}-line command: ${commandLines[0]!.trim()} …)`}
              </Text>
            )}
          </Box>
        )}
        {past.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>Earlier</Text>
            {past.map((one, i) => (
              <Text key={`p${i}`} dimColor wrap="truncate-end">
                {one.verdict === 'allowed' ? '✔' : one.verdict === 'blocked' ? '✖' : one.verdict === 'quiet' ? '·' : '…'}{' '}
                {one.findings[0]?.headline ?? one.command}
                {one.verdict === 'quiet' ? ' (low risk, not asked)' : ''}
                {one.description ? ` · "${one.description}"` : ''}
              </Text>
            ))}
          </Box>
        )}
        <Button key="close" label="Close" role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
      </Box>
    )
  })
}
