import { describe, expect, it } from 'vitest'
import { permissionRulePath } from './paths'

describe('permissionRulePath', () => {
  it('prefixes a POSIX absolute path with one more slash', () => {
    expect(permissionRulePath('/Users/me/Library/Application Support/x', 'darwin')).toBe(
      '//Users/me/Library/Application Support/x'
    )
    expect(permissionRulePath('/cfg', 'linux')).toBe('//cfg')
  })

  it('maps a Windows drive path to the //c/... form Claude matches against', () => {
    expect(permissionRulePath('C:\\Users\\A B\\x', 'win32')).toBe('//c/Users/A B/x')
    expect(
      permissionRulePath('D:\\Users\\me\\AppData\\Roaming\\ClaudeDeck\\accounts\\id', 'win32')
    ).toBe('//d/Users/me/AppData/Roaming/ClaudeDeck/accounts/id')
  })

  it('accepts forward slashes, doubled and trailing separators on Windows', () => {
    expect(permissionRulePath('c:/Users/me/', 'win32')).toBe('//c/Users/me')
    expect(permissionRulePath('C:\\\\Users\\me\\', 'win32')).toBe('//c/Users/me')
    expect(permissionRulePath('C:\\', 'win32')).toBe('//c')
  })

  it('refuses Windows paths without a drive letter', () => {
    for (const bad of ['\\\\server\\share\\x', '\\\\wsl$\\Ubuntu', 'Users\\me', 'C:rel', '']) {
      expect(() => permissionRulePath(bad, 'win32')).toThrow()
    }
  })
})
