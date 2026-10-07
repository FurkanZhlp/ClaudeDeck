import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isRootPath,
  isWindowsUncPath,
  isWithin,
  pathKey,
  permissionRulePath,
  samePath,
  splitPath,
  stripPathPrefix
} from './paths'

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

describe('pathKey / samePath', () => {
  it('ignores case and separator style on Windows only', () => {
    expect(pathKey('C:/Users/Me', win32)).toBe('c:\\users\\me')
    expect(pathKey('/Users/Me', posix)).toBe('/Users/Me')
    expect(samePath('C:\\Users\\Me', 'c:/users/me/', win32)).toBe(true)
    expect(samePath('C:\\', 'c:/', win32)).toBe(true)
    expect(samePath('C:\\a\\..\\b', 'C:\\b', win32)).toBe(true)
    expect(samePath('/Users/Me', '/users/me', posix)).toBe(false)
    expect(samePath('/a/b/', '/a/b', posix)).toBe(false)
  })
})

describe('stripPathPrefix', () => {
  it('keeps the original spelling of the rest', () => {
    expect(stripPathPrefix('C:/Users/Me/X/y', 'c:\\users\\me\\', win32)).toBe('X/y')
    expect(stripPathPrefix('C:\\Other', 'C:\\Users\\', win32)).toBeNull()
    expect(stripPathPrefix('/a/B', '/A/', posix)).toBeNull()
    expect(stripPathPrefix('/a/B', '/a/', posix)).toBe('B')
  })
})

describe('isWithin', () => {
  it('matches the root and paths below it on POSIX', () => {
    expect(isWithin('/a/b', '/a/b', posix)).toBe(true)
    expect(isWithin('/a/b/c', '/a/b', posix)).toBe(true)
    expect(isWithin('/a/bc', '/a/b', posix)).toBe(false)
    expect(isWithin('/A/b/c', '/a/b', posix)).toBe(false)
  })

  it('is case-insensitive with either separator on Windows', () => {
    expect(isWithin('c:\\users\\me\\.claude\\x', 'C:\\Users\\Me\\.claude', win32)).toBe(true)
    expect(isWithin('C:/Users/Me/.claude/x', 'C:\\Users\\Me\\.claude\\', win32)).toBe(true)
    expect(isWithin('C:\\Users\\Me\\.CLAUDE', 'c:/users/me/.claude', win32)).toBe(true)
    expect(isWithin('C:\\Users\\Me\\.claude2', 'C:\\Users\\Me\\.claude', win32)).toBe(false)
    expect(isWithin('D:\\x', 'C:\\', win32)).toBe(false)
    expect(isWithin('C:\\x', 'C:\\', win32)).toBe(true)
  })
})

describe('splitPath', () => {
  it('splits on both separators on Windows and on / elsewhere', () => {
    expect(splitPath('claudedeck\\backups/x', win32)).toEqual(['claudedeck', 'backups', 'x'])
    expect(splitPath('a\\b/c', posix)).toEqual(['a\\b', 'c'])
    expect(splitPath('', posix)).toEqual([])
  })
})

describe('isWindowsUncPath', () => {
  it.each([
    '\\\\server\\share',
    '//server/share',
    '\\\\wsl$\\Ubuntu',
    '\\\\?\\C:\\x',
    '\\\\.\\pipe\\x'
  ])('flags %s', (value) => expect(isWindowsUncPath(value)).toBe(true))

  it.each(['C:\\Users\\me', 'c:/x', '\\Users\\me', 'relative'])('keeps %s', (value) =>
    expect(isWindowsUncPath(value)).toBe(false)
  )
})

describe('isRootPath', () => {
  it('detects drive and share roots on Windows', () => {
    expect(isRootPath('C:\\', win32)).toBe(true)
    expect(isRootPath('d:/', win32)).toBe(true)
    expect(isRootPath('\\\\server\\share\\', win32)).toBe(true)
    expect(isRootPath('C:\\Users', win32)).toBe(false)
    expect(isRootPath('C:', win32)).toBe(false)
  })

  it('detects / on POSIX', () => {
    expect(isRootPath('/', posix)).toBe(true)
    expect(isRootPath('/Users', posix)).toBe(false)
  })
})
