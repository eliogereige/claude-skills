import { expect, test } from 'claude-code/testing'

/** `real`: where a link or junction at this path really leads. */
type Stat = { kind: 'file' | 'dir'; size: number; real?: string }

/** A fake machine: `files` are the paths that exist, `cwd` the session's folder. Returns what the mod asked. */
const machine = (on: any, { files = {} as Record<string, Stat>, cwd = 'C:/Users/someone/project' } = {}) => {
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_: unknown, e: any) => {
    asked.push(`${e.questions[0].header}\n${e.questions[0].question}`)
    return { deny: 'declined in the test' }
  })
  on('tool.call', { tool: 'Write' }, (_: unknown, e: any) => {
    files[e.file_path] = { kind: 'file', size: 10 }
    return { result: { ok: true } }
  })
  on('tool.call', () => ({ result: { ok: true } }))
  on('env.get', (_: unknown, e: any) => ({ value: e.name === 'USERPROFILE' ? 'C:/Users/someone' : e.name === 'TEMP' ? 'C:\\Users\\someone\\AppData\\Local\\Temp' : undefined }))
  on('session.cwd', () => ({ value: cwd }))
  // The engine hands paths over in the platform's own form (backslashes on Windows).
  const same = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
  on('fs.stat', (_: unknown, e: any) => {
    const stat = Object.entries(files).find(([p]) => same(p, e.path))?.[1]
    // A call on $ rejects through `{ deny }`; the engine's own stat rejects ENOENT for a missing path.
    if (stat === undefined) return { deny: `ENOENT: no such file or directory, stat '${e.path}'` }
    const { real, ...rest } = stat
    return { value: { ...rest, mtimeMs: 0, isLink: real !== undefined, ...(e.resolve ? { realPath: real ?? e.path } : {}) } }
  })
  // git is not reachable here: every preview that needs it fails.
  on('process.run', () => ({ deny: 'git: not found' }))
  on('fs.list', () => ({ value: [{ name: 'a.txt', kind: 'file', size: 5 }] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', ($: any, e: any) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  return asked
}

const paneText = async ($: any) => {
  const ui = await $.ui.mount({ plugin: 'blast-radius', surface: 'desktop', component: 'Pane', requestId: 'blast-radius',
    viewport: { columns: 100, rows: 40 }, props: {} })
  const text = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join('\n')
  await ui.unmount()
  return text
}

const bash = ($: any, command: string, description?: string) => $.tool.call({ tool: 'Bash', command, description })

test('a delete in a temp folder runs without asking, and is logged as low risk', async ($, on) => {
  const asked = machine(on)
  const scratch = 'C:/Users/someone/AppData/Local/Temp/claude/session/scratchpad/dottest-that-is-not-there'
  const ran = await bash($, `S="${scratch}"; rm -rf "$S"; cp -r ~/mods/x "$S"`, 'Test a renamed copy of the mod')
  const ranInTemp = await bash($, 'rm -rf "C:\\Users\\someone\\AppData\\Local\\Temp\\pytest-of-someone"')

  expect(asked.length).toBe(0)
  expect(JSON.stringify(ran)).toContain('"ok":true')
  expect(JSON.stringify(ranInTemp)).toContain('"ok":true')
  expect(await paneText($)).toContain('(low risk, not asked)')
})

test("deleting a file Claude wrote this session runs without asking, even recursively", async ($, on) => {
  const asked = machine(on)
  const file = 'C:/Users/someone/project/out/tmp_result.csv'
  await $.tool.call({ tool: 'Write', file_path: file, content: 'x' } as never)
  const ran = await bash($, `rm -rf "${file}"`)

  expect(asked.length).toBe(0)
  expect(JSON.stringify(ran)).toContain('"ok":true')
  // Logged, which shows the check ran (a failed hook would also let the command through).
  expect(await paneText($)).toContain('Permanently delete a file (low risk, not asked)')
})

test('a recursive delete of a real project folder still asks, with what would be lost', async ($, on) => {
  const asked = machine(on, { files: { 'C:/Users/someone/project/data': { kind: 'dir', size: 0 } } })
  const denied = await bash($, 'rm -rf data', 'Clean old data')

  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('MEDIUM RISK')
  expect(asked[0]).toContain('Claude says: "Clean old data"')
  expect(asked[0]).toContain("Can't be undone")
  expect(JSON.stringify(denied)).toContain('did not allow')
  const text = await paneText($)
  expect(text).toContain('You stopped it')
  expect(text).toContain('rm -rf data')
})

test('a plain delete in OneDrive asks (as a OneDrive safety check would); elsewhere it does not', async ($, on) => {
  const report = 'C:/Users/someone/OneDrive/Docs/report.docx'
  const asked = machine(on, { files: { [report]: { kind: 'file', size: 2048 }, 'C:/Users/someone/project/notes.txt': { kind: 'file', size: 10 } } })

  const plain = await bash($, 'rm notes.txt')
  expect(asked.length).toBe(0)
  expect(JSON.stringify(plain)).toContain('"ok":true')

  const denied = await bash($, `rm "${report}"`)
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('HIGH RISK')
  expect(JSON.stringify(denied)).toContain('did not allow')
  expect(await paneText($)).toContain('in your OneDrive')
})

test('a script that deletes files asks only when it runs in OneDrive', async ($, on) => {
  const script = `python -c "import os; os.remove('result.csv')"`
  const askedHere = machine(on)
  const ran = await bash($, script)
  expect(askedHere.length).toBe(0)
  expect(JSON.stringify(ran)).toContain('"ok":true')
})

// ---------------------------------------------------------------- unsure is never low (garde-fou review)

const SCRATCH = 'C:/Users/someone/AppData/Local/Temp/claude/s1/scratchpad'

test('a cd before a relative delete asks: where it lands is not known', async ($, on) => {
  const asked = machine(on, { files: { 'D:/x/build': { kind: 'dir', size: 0 } } })
  await bash($, 'cd D:/x && rm -rf build')
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain("Couldn't see")
  expect(await paneText($)).toContain('changes folder first')
})

test('a plain delete after a cd into OneDrive asks', async ($, on) => {
  const asked = machine(on)
  await bash($, 'cd "C:/Users/someone/OneDrive/T" && rm a.txt')
  expect(asked.length).toBe(1)
})

test('climbing out of a temp folder with .. is not scratch', async ($, on) => {
  const asked = machine(on, { cwd: SCRATCH, files: {
    'C:/Users/someone/AppData/Local': { kind: 'dir', size: 0 },
    'C:/Users/someone/AppData/Local/Temp/claude/s1': { kind: 'dir', size: 0 },
  } })
  await bash($, 'rm -rf ../../../..')
  await bash($, `rm -rf "${SCRATCH}/../../../../Documents"`)
  await bash($, 'rm -rf ..')
  expect(asked.length).toBe(2)
  expect(asked[0]).toContain('MEDIUM RISK')
  expect(asked[1]).toContain('HIGH RISK')
})

test('a link inside Temp that leads into OneDrive is not scratch', async ($, on) => {
  const link = 'C:/Users/someone/AppData/Local/Temp/linked'
  const asked = machine(on, { files: { [link]: { kind: 'dir', size: 0, real: 'C:/Users/someone/OneDrive/Documents' } } })
  await bash($, `rm -rf "${link}"`)
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('HIGH RISK')
})

test('a pattern over the whole temp folder asks (other apps keep files there)', async ($, on) => {
  const asked = machine(on)
  await bash($, 'rm -rf "C:/Users/someone/AppData/Local/Temp/"*')
  expect(asked.length).toBe(1)
})

test('a WSL path asks: Windows cannot see whether it is there', async ($, on) => {
  const asked = machine(on)
  await bash($, 'wsl bash -c "rm -rf ~/project/build"')
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('MEDIUM RISK')
})

test('more than 8 targets asks even when the first 8 are scratch', async ($, on) => {
  const asked = machine(on)
  const scratch = Array.from({ length: 8 }, (_, i) => `"${SCRATCH}/t${i}"`).join(' ')
  await bash($, `rm -rf ${scratch} "C:/Users/someone/Documents"`)
  expect(asked.length).toBe(1)
})

test('when git fails, a reset asks instead of assuming nothing is lost', async ($, on) => {
  const asked = machine(on)
  await bash($, 'git reset --hard')
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain("Couldn't check with git")
})

test('a script that deletes files in OneDrive asks', async ($, on) => {
  const asked = machine(on, { cwd: 'C:/Users/someone/OneDrive/Documents' })
  const denied = await bash($, `python -c "import os; os.remove('result.csv')"`)
  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('A script deletes files, in your OneDrive')
  expect(JSON.stringify(denied)).toContain('did not allow')
})
