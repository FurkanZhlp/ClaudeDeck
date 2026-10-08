import { describe, expect, it } from 'vitest'
import {
  defaultClaudeSettings,
  effectivePermissionMode,
  isPermissionMode,
  PERMISSION_MODES,
  permissionModeArgs
} from './permissionMode'
import type { PermissionMode } from './types'

describe('effectivePermissionMode', () => {
  const global = { permissionMode: 'acceptEdits' as PermissionMode, allowBypass: false }

  it('prefers the tab, then the project, then the global setting', () => {
    expect(effectivePermissionMode(global)).toBe('acceptEdits')
    expect(effectivePermissionMode(global, {})).toBe('acceptEdits')
    expect(effectivePermissionMode(global, { claude: { permissionMode: 'plan' } })).toBe('plan')
    expect(
      effectivePermissionMode(
        global,
        { claude: { permissionMode: 'plan' } },
        { permissionMode: 'bypassPermissions' }
      )
    ).toBe('bypassPermissions')
    expect(effectivePermissionMode(global, {}, { permissionMode: 'default' })).toBe('default')
  })

  it('ignores unknown stored values', () => {
    const bad = 'yolo' as PermissionMode
    expect(
      effectivePermissionMode(global, { claude: { permissionMode: bad } }, { permissionMode: bad })
    ).toBe('acceptEdits')
    expect(effectivePermissionMode({ permissionMode: bad, allowBypass: false })).toBe('default')
  })

  it('defaults to passing no flag', () => {
    expect(effectivePermissionMode(defaultClaudeSettings())).toBe('default')
  })
})

describe('permissionModeArgs', () => {
  it('maps every mode to its CLI value', () => {
    const expected: Record<PermissionMode, string[]> = {
      default: [],
      manual: ['--permission-mode', 'default'],
      acceptEdits: ['--permission-mode', 'acceptEdits'],
      plan: ['--permission-mode', 'plan'],
      auto: ['--permission-mode', 'auto'],
      dontAsk: ['--permission-mode', 'dontAsk'],
      bypassPermissions: ['--permission-mode', 'bypassPermissions']
    }
    for (const mode of PERMISSION_MODES)
      expect(permissionModeArgs(mode, false)).toEqual(expected[mode])
  })

  it('adds the allow flag unless the tab already starts in bypass', () => {
    expect(permissionModeArgs('default', true)).toEqual(['--allow-dangerously-skip-permissions'])
    expect(permissionModeArgs('plan', true)).toEqual([
      '--permission-mode',
      'plan',
      '--allow-dangerously-skip-permissions'
    ])
    expect(permissionModeArgs('bypassPermissions', true)).toEqual([
      '--permission-mode',
      'bypassPermissions'
    ])
  })

  it('recognises modes', () => {
    expect(isPermissionMode('auto')).toBe(true)
    expect(isPermissionMode('inherit')).toBe(false)
    expect(isPermissionMode(undefined)).toBe(false)
  })
})
