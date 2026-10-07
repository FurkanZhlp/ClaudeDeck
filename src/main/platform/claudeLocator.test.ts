import { describe, expect, it } from 'vitest'
import { locateClaudeWindows, shimTarget, windowsLocator, type LocatorFs } from './claudeLocator'

function fakeFs(files: Record<string, string> = {}): LocatorFs {
  const byKey = new Map(Object.entries(files).map(([p, text]) => [p.toLowerCase(), text]))
  return {
    isFile: (p) => byKey.has(p.toLowerCase()),
    readText: (p) => byKey.get(p.toLowerCase()) ?? null
  }
}

const ENV = {
  Path: 'C:\\Windows\\System32;"C:\\Tools";;relative\\dir',
  USERPROFILE: 'C:\\Users\\me',
  APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local'
}
const NPM = 'C:\\Users\\me\\AppData\\Roaming\\npm'
const NPM_EXE = `${NPM}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`

// What npm's cmd-shim writes for a bin that is not a JavaScript file.
const EXE_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
  ''
].join('\r\n')

// Older JavaScript entry point.
const JS_SHIM = [
  '@ECHO off',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  ')',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  ' +
    '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*'
].join('\r\n')

describe('locateClaudeWindows', () => {
  it('finds the native installer binary through the fallback dirs', () => {
    const exe = 'C:\\Users\\me\\.local\\bin\\claude.exe'
    expect(locateClaudeWindows(ENV, fakeFs({ [exe]: '' }))).toBe(exe)
  })

  it('finds the WinGet link', () => {
    const exe = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe'
    expect(locateClaudeWindows(ENV, fakeFs({ [exe]: '' }))).toBe(exe)
  })

  it('prefers an exe anywhere over an earlier npm shim, and strips quotes', () => {
    const fs = fakeFs({
      'C:\\Windows\\System32\\claude.cmd': EXE_SHIM,
      'C:\\Tools\\claude.exe': ''
    })
    expect(locateClaudeWindows(ENV, fs)).toBe('C:\\Tools\\claude.exe')
  })

  it('matches the PATH variable in any case and ignores relative entries', () => {
    const fs = fakeFs({ 'relative\\dir\\claude.exe': '', 'D:\\bin\\claude.exe': '' })
    expect(locateClaudeWindows({ PATH: 'relative\\dir;D:\\bin', USERPROFILE: 'C:\\u' }, fs)).toBe(
      'D:\\bin\\claude.exe'
    )
  })

  it('searches only drive and UNC paths, never root- or drive-relative ones', () => {
    const fs = fakeFs({
      '\\tools\\claude.exe': '',
      'C:tools\\claude.exe': '',
      '\\\\server\\share\\bin\\claude.exe': ''
    })
    const env = { PATH: '\\tools;C:tools;\\\\server\\share\\bin', USERPROFILE: 'C:\\u' }
    expect(locateClaudeWindows(env, fs)).toBe('\\\\server\\share\\bin\\claude.exe')
    expect(locateClaudeWindows({ PATH: '\\tools;C:tools', USERPROFILE: 'C:\\u' }, fs)).toBeNull()
  })

  it('follows the npm shim to the native binary', () => {
    const fs = fakeFs({ [`${NPM}\\claude.cmd`]: EXE_SHIM, [NPM_EXE]: '' })
    expect(locateClaudeWindows(ENV, fs)).toBe(NPM_EXE)
  })

  it('returns null when nothing spawnable exists', () => {
    expect(locateClaudeWindows(ENV, fakeFs({ [`${NPM}\\claude.cmd`]: JS_SHIM }))).toBeNull()
    expect(locateClaudeWindows(ENV, fakeFs())).toBeNull()
  })

  it('honours PATHEXT', () => {
    const fs = fakeFs({ 'C:\\Tools\\claude.exe': '' })
    expect(locateClaudeWindows({ ...ENV, PATHEXT: '.CMD' }, fs)).toBeNull()
  })
})

describe('shimTarget', () => {
  it('skips node.exe and a JavaScript target without the packaged binary', () => {
    expect(shimTarget(`${NPM}\\claude.cmd`, fakeFs({ [`${NPM}\\claude.cmd`]: JS_SHIM }))).toBeNull()
  })

  it('uses the packaged binary next to a JavaScript entry point', () => {
    const fs = fakeFs({ [`${NPM}\\claude.cmd`]: JS_SHIM, [NPM_EXE]: '' })
    expect(shimTarget(`${NPM}\\claude.cmd`, fs)).toBe(NPM_EXE)
  })

  it('refuses a target outside the shim folder or not named claude.exe', () => {
    const outside = 'C:\\Users\\me\\AppData\\evil\\claude.exe'
    const other = `${NPM}\\node_modules\\x\\other.exe`
    const fs = fakeFs({
      [`${NPM}\\claude.cmd`]: '"%dp0%\\..\\..\\evil\\claude.exe" %*',
      [`${NPM}\\c2.cmd`]: '"%dp0%\\node_modules\\x\\other.exe" %*',
      [outside]: '',
      [other]: ''
    })
    expect(shimTarget(`${NPM}\\claude.cmd`, fs)).toBeNull()
    expect(shimTarget(`${NPM}\\c2.cmd`, fs)).toBeNull()
  })

  it('reads older %~dp0 shims', () => {
    const exe = 'C:\\n\\node_modules\\x\\claude.exe'
    const fs = fakeFs({ 'C:\\n\\claude.cmd': '"%~dp0\\node_modules\\x\\claude.exe" %*', [exe]: '' })
    expect(shimTarget('C:\\n\\claude.cmd', fs)).toBe(exe)
  })
})

describe('windowsLocator', () => {
  it('reports availability and rejects with CLAUDE_NOT_FOUND', async () => {
    const missing = windowsLocator(fakeFs())
    await expect(missing.available(ENV)).resolves.toBe(false)
    await expect(missing.file(ENV)).rejects.toThrow('CLAUDE_NOT_FOUND')
    const exe = 'C:\\Tools\\claude.exe'
    const found = windowsLocator(fakeFs({ [exe]: '' }))
    await expect(found.available(ENV)).resolves.toBe(true)
    await expect(found.file(ENV)).resolves.toBe(exe)
  })
})
