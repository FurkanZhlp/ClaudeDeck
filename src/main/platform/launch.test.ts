import { describe, expect, it } from 'vitest'
import { createPlatform } from '.'
import { PERMISSION_MODES, permissionModeArgs } from '../../shared/permissionMode'
import type { LocatorFs } from './claudeLocator'
import { claudeLaunch, shellLaunch } from './launch'

const CONFIG_DIR = "/Users/me/Library/Application Support/ClaudeDeck/accounts/it's"
// Deliberately extended in phase 1: Anthropic profile and federation variables are unset too.
const UNSET =
  '-u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN ' +
  '-u ANTHROPIC_PROFILE -u ANTHROPIC_FEDERATION_RULE_ID -u ANTHROPIC_ORGANIZATION_ID ' +
  '-u ANTHROPIC_SERVICE_ACCOUNT_ID -u ANTHROPIC_IDENTITY_TOKEN -u ANTHROPIC_IDENTITY_TOKEN_FILE ' +
  '-u ANTHROPIC_WORKSPACE_ID ' +
  // Deliberately extended again: endpoint and provider switches (subscription accounts only).
  '-u ANTHROPIC_BASE_URL -u ANTHROPIC_CUSTOM_HEADERS -u CLAUDE_CODE_USE_BEDROCK ' +
  '-u CLAUDE_CODE_USE_VERTEX -u CLAUDE_CODE_USE_FOUNDRY -u CLAUDE_CODE_USE_MANTLE -u CLAUDE_CODE_USE_ANTHROPIC_AWS -u ANTHROPIC_BEDROCK_BASE_URL -u ANTHROPIC_VERTEX_BASE_URL -u AWS_BEARER_TOKEN_BEDROCK'
const BASE = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', HOME: '/Users/me' }

describe('claudeLaunch (macOS)', () => {
  // Pins the exact macOS command line; later phases must not change it.
  it('runs claude through the login shell with the account config dir', () => {
    const launch = claudeLaunch('darwin', CONFIG_DIR, ['--resume', 'a b', "x'y"], BASE)
    expect(launch.file).toBe('/bin/zsh')
    expect(launch.args).toEqual([
      '-ilc',
      `exec env ${UNSET} ` +
        "CLAUDE_CONFIG_DIR='/Users/me/Library/Application Support/ClaudeDeck/accounts/it'\\''s' " +
        "claude '--resume' 'a b' 'x'\\''y'"
    ])
    expect(launch.env).toEqual({
      ...BASE,
      CLAUDE_CONFIG_DIR: CONFIG_DIR,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'ClaudeDeck',
      LANG: 'en_US.UTF-8'
    })
  })

  it('falls back to zsh without SHELL', () => {
    expect(claudeLaunch('darwin', '/cfg', ['auth', 'login'], { PATH: '/bin' })).toMatchObject({
      file: '/bin/zsh',
      args: ['-ilc', `exec env ${UNSET} CLAUDE_CONFIG_DIR='/cfg' claude 'auth' 'login'`]
    })
  })
})

describe('claudeLaunch with permission modes (macOS)', () => {
  const ID = '1b4e28ba-2fa1-11d2-883f-0016d3cca427'
  const command = (args: string[]): string =>
    claudeLaunch('darwin', '/cfg', args, BASE).args[1] as string

  it('keeps the exact current command for the default mode', () => {
    const args = ['--session-id', ID, ...permissionModeArgs('default', false)]
    expect(claudeLaunch('darwin', '/cfg', args, BASE).args).toEqual([
      '-ilc',
      `exec env ${UNSET} CLAUDE_CONFIG_DIR='/cfg' claude '--session-id' '${ID}'`
    ])
  })

  it('appends the quoted mode flag for fresh and resumed tabs', () => {
    expect(command(['--resume', ID, ...permissionModeArgs('bypassPermissions', false)])).toBe(
      `exec env ${UNSET} CLAUDE_CONFIG_DIR='/cfg' claude '--resume' '${ID}' ` +
        "'--permission-mode' 'bypassPermissions'"
    )
    expect(command(['--session-id', ID, ...permissionModeArgs('manual', true)])).toBe(
      `exec env ${UNSET} CLAUDE_CONFIG_DIR='/cfg' claude '--session-id' '${ID}' ` +
        "'--permission-mode' 'default' '--allow-dangerously-skip-permissions'"
    )
    for (const mode of PERMISSION_MODES.filter((m) => m !== 'default' && m !== 'manual')) {
      expect(command(['--session-id', ID, ...permissionModeArgs(mode, false)])).toBe(
        `exec env ${UNSET} CLAUDE_CONFIG_DIR='/cfg' claude '--session-id' '${ID}' ` +
          `'--permission-mode' '${mode}'`
      )
    }
  })
})

describe('shellLaunch (macOS)', () => {
  it('opens an interactive login shell with the config dir in its env', () => {
    const launch = shellLaunch('darwin', '/cfg', { ...BASE, SHELL: '/bin/bash', LANG: 'tr_TR' })
    expect(launch.file).toBe('/bin/bash')
    expect(launch.args).toEqual(['-il'])
    expect(launch.env.CLAUDE_CONFIG_DIR).toBe('/cfg')
    expect(launch.env.LANG).toBe('tr_TR')
  })
})

describe('createPlatform', () => {
  it('binds the POSIX implementation for darwin', () => {
    const darwin = createPlatform('darwin')
    expect(darwin.os).toBe('darwin')
    expect(darwin.spawnDefaults()).toEqual({ detached: true })
    expect(darwin.claudeLaunch('/cfg', [], BASE).args[0]).toBe('-ilc')
  })

  it('binds the win32 implementation', () => {
    const win = createPlatform('win32')
    expect(win.os).toBe('win32')
    expect(win.spawnDefaults()).toEqual({ detached: false, windowsHide: true })
  })
})

/** In-memory file system keyed case-insensitively, like NTFS. */
function fakeFs(files: Record<string, string> = {}): LocatorFs {
  const byKey = new Map(Object.entries(files).map(([p, text]) => [p.toLowerCase(), text]))
  return {
    isFile: (p) => byKey.has(p.toLowerCase()),
    readText: (p) => byKey.get(p.toLowerCase()) ?? null
  }
}

const WIN_BASE = {
  Path: 'C:\\Windows\\System32;C:\\Users\\me\\.local\\bin',
  USERPROFILE: 'C:\\Users\\me',
  APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\system32\\cmd.exe'
}
const WIN_CFG = 'C:\\Users\\me\\AppData\\Roaming\\ClaudeDeck\\accounts\\a'
const CLAUDE_EXE = 'C:\\Users\\me\\.local\\bin\\claude.exe'

describe('claudeLaunch (Windows)', () => {
  it('starts claude.exe directly with the config dir and no credential variables', () => {
    const launch = claudeLaunch(
      'win32',
      WIN_CFG,
      ['--resume', 'a b'],
      {
        ...WIN_BASE,
        anthropic_api_key: 'k',
        ANTHROPIC_PROFILE: 'p',
        Claude_Config_Dir: 'C:\\old',
        PATH: 'C:\\Tools'
      },
      fakeFs({ [CLAUDE_EXE]: '' })
    )
    expect(launch.file).toBe(CLAUDE_EXE)
    expect(launch.args).toEqual(['--resume', 'a b'])
    expect(launch.env.CLAUDE_CONFIG_DIR).toBe(WIN_CFG)
    expect(launch.env.TERM).toBe('xterm-256color')
    const keys = Object.keys(launch.env).map((k) => k.toUpperCase())
    expect(keys).not.toContain('ANTHROPIC_API_KEY')
    expect(keys).not.toContain('ANTHROPIC_PROFILE')
    expect(keys.filter((k) => k === 'CLAUDE_CONFIG_DIR')).toHaveLength(1)
    expect(keys.filter((k) => k === 'PATH')).toHaveLength(1)
    expect(launch.env.Path.split(';')).toContain('C:\\Tools')
  })

  it('passes the permission mode flags as separate arguments', () => {
    const fs = fakeFs({ [CLAUDE_EXE]: '' })
    expect(
      claudeLaunch(
        'win32',
        WIN_CFG,
        ['--session-id', 'x', ...permissionModeArgs('default', false)],
        WIN_BASE,
        fs
      ).args
    ).toEqual(['--session-id', 'x'])
    for (const mode of PERMISSION_MODES.filter((m) => m !== 'default')) {
      const flag = permissionModeArgs(mode, true)
      expect(claudeLaunch('win32', WIN_CFG, ['--resume', 'x', ...flag], WIN_BASE, fs).args).toEqual(
        ['--resume', 'x', ...flag]
      )
    }
    expect(permissionModeArgs('dontAsk', true)).toEqual([
      '--permission-mode',
      'dontAsk',
      '--allow-dangerously-skip-permissions'
    ])
  })

  it('reports CLAUDE_NOT_FOUND when there is no claude.exe', () => {
    expect(() => claudeLaunch('win32', WIN_CFG, [], WIN_BASE, fakeFs())).toThrow('CLAUDE_NOT_FOUND')
  })
})

describe('shellLaunch (Windows)', () => {
  const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
  const POWERSHELL = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

  it('prefers pwsh on the search path', () => {
    const base = { ...WIN_BASE, Path: `${WIN_BASE.Path};C:\\Program Files\\PowerShell\\7` }
    const launch = shellLaunch('win32', WIN_CFG, base, fakeFs({ [PWSH]: '', [POWERSHELL]: '' }))
    expect(launch).toMatchObject({ file: PWSH, args: ['-NoLogo'] })
    expect(launch.env.CLAUDE_CONFIG_DIR).toBe(WIN_CFG)
    // cmd and Windows PowerShell must not run a same-named exe from the current folder.
    expect(launch.env.NoDefaultCurrentDirectoryInExePath).toBe('1')
  })

  it('falls back to Windows PowerShell, then ComSpec', () => {
    expect(shellLaunch('win32', WIN_CFG, WIN_BASE, fakeFs({ [POWERSHELL]: '' }))).toMatchObject({
      file: POWERSHELL,
      args: ['-NoLogo']
    })
    expect(shellLaunch('win32', WIN_CFG, WIN_BASE, fakeFs())).toMatchObject({
      file: 'C:\\Windows\\system32\\cmd.exe',
      args: []
    })
  })
})
