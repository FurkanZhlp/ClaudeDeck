import { describe, expect, it } from 'vitest'
import { createPlatform } from '.'
import { claudeLaunch, shellLaunch } from './launch'

const CONFIG_DIR = "/Users/me/Library/Application Support/ClaudeDeck/accounts/it's"
const BASE = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', HOME: '/Users/me' }

describe('claudeLaunch (macOS)', () => {
  // Pins the exact macOS command line; later phases must not change it.
  it('runs claude through the login shell with the account config dir', () => {
    const launch = claudeLaunch('darwin', CONFIG_DIR, ['--resume', 'a b', "x'y"], BASE)
    expect(launch.file).toBe('/bin/zsh')
    expect(launch.args).toEqual([
      '-ilc',
      'exec env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN ' +
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
      args: [
        '-ilc',
        'exec env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN ' +
          "CLAUDE_CONFIG_DIR='/cfg' claude 'auth' 'login'"
      ]
    })
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

  it('does not launch on Windows yet', () => {
    const win = createPlatform('win32')
    expect(win.spawnDefaults()).toEqual({ detached: false, windowsHide: true })
    expect(() => win.claudeLaunch('C:\\cfg', [], {})).toThrow('not implemented')
    expect(() => win.shellLaunch('C:\\cfg', {})).toThrow('not implemented')
  })
})
