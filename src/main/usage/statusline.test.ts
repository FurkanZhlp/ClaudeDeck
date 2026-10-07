import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { shellQuote as shQuote } from '../env/shellEnv'
import {
  installStatusline,
  statuslineScriptPath,
  type StatuslineHost,
  uninstallStatusline,
  usageRawPath
} from './statusline'

const tempDir = (name = 'profile'): string => {
  const dir = join(mkdtempSync(join(tmpdir(), 'claudedeck-usage-')), name)
  mkdirSync(dir, { recursive: true })
  return dir
}
const settingsFile = (dir: string): string => join(dir, 'settings.json')
const readSettings = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(settingsFile(dir), 'utf8'))
const originalFile = (dir: string): string => join(dir, 'claudedeck', 'statusline-original.json')

const SAMPLE = JSON.stringify({
  session_id: 'abc',
  cwd: '/tmp',
  rate_limits: {
    five_hour: { used_percentage: 29, resets_at: 1791329400 },
    seven_day: { used_percentage: 60, resets_at: 1791507600 }
  }
})

const runScript = (dir: string, input: string): string =>
  execFileSync('/bin/sh', [statuslineScriptPath(dir)], { input, encoding: 'utf8', cwd: dir })

describe('installStatusline', () => {
  it('creates the script and settings when missing', () => {
    const dir = tempDir()
    expect(installStatusline(dir)).toBe(true)
    const script = statuslineScriptPath(dir)
    expect(statSync(script).mode & 0o777).toBe(0o755)
    expect(statSync(settingsFile(dir)).mode & 0o777).toBe(0o600)
    expect(readSettings(dir)).toEqual({
      statusLine: { type: 'command', command: shQuote(script) }
    })
    expect(existsSync(originalFile(dir))).toBe(false)
  })

  it('tolerates an empty settings.json', () => {
    const dir = tempDir()
    writeFileSync(settingsFile(dir), '  \n')
    installStatusline(dir)
    expect(readSettings(dir).statusLine).toBeDefined()
  })

  it('keeps other keys and is idempotent', () => {
    const dir = tempDir()
    const other = { model: 'opus', env: { A: '1' }, permissions: { allow: ['Bash(ls)'] } }
    writeFileSync(settingsFile(dir), JSON.stringify(other))
    expect(installStatusline(dir)).toBe(true)
    const first = readFileSync(settingsFile(dir), 'utf8')
    expect(installStatusline(dir)).toBe(false)
    expect(readFileSync(settingsFile(dir), 'utf8')).toBe(first)
    expect(readSettings(dir)).toMatchObject(other)
  })

  it('refuses to overwrite invalid JSON', () => {
    const dir = tempDir()
    writeFileSync(settingsFile(dir), '{ broken')
    expect(installStatusline(dir)).toBe(false)
    expect(readFileSync(settingsFile(dir), 'utf8')).toBe('{ broken')
    writeFileSync(settingsFile(dir), '[1, 2]')
    expect(installStatusline(dir)).toBe(false)
    expect(readFileSync(settingsFile(dir), 'utf8')).toBe('[1, 2]')
  })

  it('saves an existing statusline once and chains to it', () => {
    const dir = tempDir()
    const original = { type: 'command', command: 'cat >/dev/null; echo mine', padding: 2 }
    writeFileSync(settingsFile(dir), JSON.stringify({ statusLine: original, model: 'x' }))
    installStatusline(dir)
    expect(JSON.parse(readFileSync(originalFile(dir), 'utf8'))).toEqual(original)
    const entry = readSettings(dir).statusLine
    expect(entry).toEqual({
      padding: 2,
      type: 'command',
      command: shQuote(statuslineScriptPath(dir))
    })
    // A second run must not save our own entry as the original.
    expect(installStatusline(dir)).toBe(false)
    expect(JSON.parse(readFileSync(originalFile(dir), 'utf8'))).toEqual(original)
    expect(readSettings(dir).model).toBe('x')
  })

  it('adopts a statusline imported after installation', () => {
    const dir = tempDir()
    installStatusline(dir)
    const imported = { type: 'command', command: 'echo imported' }
    writeFileSync(settingsFile(dir), JSON.stringify({ statusLine: imported }))
    expect(installStatusline(dir)).toBe(true)
    expect(JSON.parse(readFileSync(originalFile(dir), 'utf8'))).toEqual(imported)
    expect(runScript(dir, SAMPLE)).toBe('imported\n')
  })

  it('treats another account script as ours instead of chaining to it', () => {
    const dir = tempDir()
    const foreign = { type: 'command', command: "'/other/acct/claudedeck/statusline.sh'" }
    writeFileSync(settingsFile(dir), JSON.stringify({ statusLine: foreign }))
    installStatusline(dir)
    expect(existsSync(originalFile(dir))).toBe(false)
    expect(readSettings(dir).statusLine).toEqual({
      type: 'command',
      command: shQuote(statuslineScriptPath(dir))
    })
  })

  it('uninstall restores the original', () => {
    const dir = tempDir()
    const original = { type: 'command', command: 'echo mine' }
    writeFileSync(settingsFile(dir), JSON.stringify({ statusLine: original, model: 'x' }))
    installStatusline(dir)
    expect(uninstallStatusline(dir)).toBe(true)
    expect(readSettings(dir)).toEqual({ statusLine: original, model: 'x' })
    expect(existsSync(statuslineScriptPath(dir))).toBe(false)
    expect(existsSync(originalFile(dir))).toBe(false)
  })

  it('uninstall removes the key when there was no original', () => {
    const dir = tempDir()
    writeFileSync(settingsFile(dir), JSON.stringify({ model: 'x' }))
    installStatusline(dir)
    uninstallStatusline(dir)
    expect(readSettings(dir)).toEqual({ model: 'x' })
  })
})

describe('statusline script', () => {
  it('records the input and prints nothing without an original', () => {
    const dir = tempDir()
    installStatusline(dir)
    expect(runScript(dir, SAMPLE)).toBe('')
    expect(JSON.parse(readFileSync(usageRawPath(dir), 'utf8'))).toEqual(JSON.parse(SAMPLE))
  })

  it('skips input without rate limits', () => {
    const dir = tempDir()
    installStatusline(dir)
    runScript(dir, JSON.stringify({ session_id: 'x' }))
    expect(existsSync(usageRawPath(dir))).toBe(false)
  })

  it('works under a path with spaces and quotes, chaining the original', () => {
    const dir = tempDir("Application Support/Claude Deck/it's")
    // The original reads the same JSON from stdin.
    const original = { type: 'command', command: 'grep -o "five_hour" | head -1; echo done' }
    writeFileSync(settingsFile(dir), JSON.stringify({ statusLine: original }))
    installStatusline(dir)
    expect(runScript(dir, SAMPLE)).toBe('five_hour\ndone\n')
    expect(JSON.parse(readFileSync(usageRawPath(dir), 'utf8')).rate_limits).toBeDefined()
    // Run the configured command string through a shell, as Claude Code does.
    const command = readSettings(dir).statusLine as { command: string }
    const out = execFileSync('/bin/sh', ['-c', command.command], {
      input: SAMPLE,
      encoding: 'utf8'
    })
    expect(out).toBe('five_hour\ndone\n')
  })

  it('exits 0 when the usage folder is gone and the original fails', () => {
    const dir = tempDir()
    writeFileSync(
      settingsFile(dir),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo out; exit 3' } })
    )
    installStatusline(dir)
    const script = readFileSync(statuslineScriptPath(dir), 'utf8')
    const moved = join(tempDir('elsewhere'), 'statusline.sh')
    writeFileSync(moved, script.replace(/^dir=.*$/m, "dir='/nonexistent/claudedeck'"))
    expect(execFileSync('/bin/sh', [moved], { input: SAMPLE, encoding: 'utf8' })).toBe('out\n')
  })
})

describe('installStatusline on Windows', () => {
  const host = (gitBash: string | null): StatuslineHost => ({
    os: 'win32',
    env: {},
    exists: (p) => p === gitBash
  })

  it('writes statusline.ps1 and a powershell -File command', () => {
    const dir = tempDir()
    expect(installStatusline(dir, host(null))).toBe(true)
    const script = statuslineScriptPath(dir, 'win32')
    expect(script.endsWith('statusline.ps1')).toBe(true)
    expect(readSettings(dir).statusLine).toEqual({
      type: 'command',
      command: `C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '${script.replace(/\\/g, '/')}'`
    })
    expect(readFileSync(script, 'utf8')).toContain('[System.IO.File]::WriteAllText')
    expect(installStatusline(dir, host(null))).toBe(false)
  })

  it('uses %SystemRoot% for the absolute PowerShell path, in the command and the chain', () => {
    const dir = tempDir()
    writeFileSync(
      settingsFile(dir),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo mine' } })
    )
    installStatusline(dir, { os: 'win32', env: { SYSTEMROOT: 'D:\\Win' }, exists: () => false })
    const ps = 'D:/Win/System32/WindowsPowerShell/v1.0/powershell.exe'
    const { command } = readSettings(dir).statusLine as { command: string }
    expect(command.startsWith(`${ps} -NoProfile`)).toBe(true)
    const script = readFileSync(statuslineScriptPath(dir, 'win32'), 'utf8')
    expect(script).toContain(`$psi.FileName = '${ps}'`)
  })

  it('chains the original through Git Bash when it is installed', () => {
    const dir = tempDir()
    const original = { type: 'command', command: 'echo mine' }
    writeFileSync(settingsFile(dir), JSON.stringify({ statusLine: original }))
    installStatusline(dir, host('C:\\Program Files\\Git\\bin\\bash.exe'))
    const script = readFileSync(statuslineScriptPath(dir, 'win32'), 'utf8')
    expect(script).toContain("$psi.FileName = 'C:\\Program Files\\Git\\bin\\bash.exe'")
    expect(script).toContain(`$psi.Arguments = '-c "echo mine"'`)
  })

  it('treats a macOS script entry as ours and uninstall removes both scripts', () => {
    const dir = tempDir()
    installStatusline(dir)
    installStatusline(dir, host(null))
    expect(existsSync(originalFile(dir))).toBe(false)
    expect(uninstallStatusline(dir)).toBe(true)
    expect(readSettings(dir)).toEqual({})
    expect(existsSync(statuslineScriptPath(dir, 'darwin'))).toBe(false)
    expect(existsSync(statuslineScriptPath(dir, 'win32'))).toBe(false)
  })
})
