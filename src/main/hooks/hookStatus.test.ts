import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Account, Project } from '../../shared/types'
import type { Json } from '../profile/settingsFile'
import {
  hooksDisabledProjects,
  managedHooksOnly,
  managedSettingsFiles,
  projectHooksDisabled,
  registryBlocksHooks,
  type HookStatusFs
} from './hookStatus'

function fakeFs(
  files: Record<string, Json | null>,
  dirs: Record<string, string[]> = {}
): HookStatusFs {
  return {
    readJson: (path) => (path in files ? files[path] : undefined),
    list: (dir) => dirs[dir] ?? [],
    exists: (path) => path in files
  }
}

describe('managed settings', () => {
  it('lists managed-settings.json and the drop-in folder per OS', () => {
    const fs = fakeFs(
      {},
      { 'C:\\PF\\ClaudeCode\\managed-settings.d': ['b.json', 'a.json', 'x.txt'] }
    )
    expect(managedSettingsFiles('win32', { ProgramFiles: 'C:\\PF' }, fs)).toEqual([
      'C:\\PF\\ClaudeCode\\managed-settings.json',
      'C:\\PF\\ClaudeCode\\managed-settings.d\\a.json',
      'C:\\PF\\ClaudeCode\\managed-settings.d\\b.json'
    ])
    expect(managedSettingsFiles('darwin', {}, fakeFs({}))).toEqual([
      '/Library/Application Support/ClaudeCode/managed-settings.json'
    ])
  })

  it('detects allowManagedHooksOnly and disableAllHooks in managed files', async () => {
    const file = '/Library/Application Support/ClaudeCode/managed-settings.json'
    const dropIn = '/Library/Application Support/ClaudeCode/managed-settings.d'
    const opts = (
      files: Record<string, Json | null>,
      dirs = {}
    ): Parameters<typeof managedHooksOnly>[0] => ({
      os: 'darwin',
      env: {},
      fs: fakeFs(files, dirs)
    })
    expect(await managedHooksOnly(opts({}))).toBe(false)
    expect(await managedHooksOnly(opts({ [file]: { allowManagedHooksOnly: true } }))).toBe(true)
    expect(await managedHooksOnly(opts({ [file]: { allowManagedHooksOnly: false } }))).toBe(false)
    expect(
      await managedHooksOnly(
        opts(
          { [`${dropIn}/10-policy.json`]: { disableAllHooks: true } },
          { [dropIn]: ['10-policy.json'] }
        )
      )
    ).toBe(true)
  })

  it('reads the MDM profile and the policy registry best effort', async () => {
    const plist = '/Library/Managed Preferences/com.anthropic.claudecode.plist'
    const calls: string[][] = []
    const mac = await managedHooksOnly({
      os: 'darwin',
      env: {},
      fs: fakeFs({ [plist]: null }),
      run: (file, args) => {
        calls.push([file, ...args])
        return Promise.resolve('{"allowManagedHooksOnly":true}')
      }
    })
    expect(mac).toBe(true)
    expect(calls).toEqual([['/usr/bin/plutil', '-convert', 'json', '-o', '-', plist]])

    const win = await managedHooksOnly({
      os: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      fs: fakeFs({}),
      run: (_file, args) =>
        args[1].startsWith('HKLM')
          ? Promise.reject(new Error('missing'))
          : Promise.resolve('    disableAllHooks    REG_DWORD    0x1\r\n')
    })
    expect(win).toBe(true)
  })

  it('parses registry values', () => {
    expect(registryBlocksHooks('  allowManagedHooksOnly  REG_SZ  true')).toBe(true)
    expect(registryBlocksHooks('  disableAllHooks  REG_DWORD  0x0')).toBe(false)
    expect(registryBlocksHooks('  Settings  REG_SZ  {"disableAllHooks": true}')).toBe(true)
  })
})

describe('project detection', () => {
  const account: Account = { id: 'a', name: 'A', color: '#000', configDir: '/cfg/a' }
  const project = (id: string, path: string): Project => ({ id, name: id, path, accountId: 'a' })

  it('follows local, then project, then account settings', () => {
    const fs = fakeFs({
      '/p1/.claude/settings.json': { disableAllHooks: true },
      '/p2/.claude/settings.json': { disableAllHooks: true },
      '/p2/.claude/settings.local.json': { disableAllHooks: false }
    })
    expect(projectHooksDisabled('/p1', {}, fs, 'darwin')).toBe(true)
    expect(projectHooksDisabled('/p2', {}, fs, 'darwin')).toBe(false)
    expect(projectHooksDisabled('/p3', { disableAllHooks: true }, fs, 'darwin')).toBe(true)
    expect(projectHooksDisabled('/p3', null, fs, 'darwin')).toBe(false)
  })

  it('lists projects of accounts whose user settings disable hooks', () => {
    // settings.json of an account is found with the host's path functions.
    const fs = fakeFs({ [join('/cfg/a', 'settings.json')]: { disableAllHooks: true } })
    expect(hooksDisabledProjects([project('x', '/x')], [account], fs, 'darwin')).toEqual(['x'])
  })
})
