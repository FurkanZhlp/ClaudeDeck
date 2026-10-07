import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  encodeProjectKey,
  encodeProjectPath,
  memoryDir,
  memoryDirForKey,
  resolveMemoryKey
} from './memoryPath'

const LONG =
  '/private/tmp/claude-501/-Volumes-Furkan-SSD-Projects-Furkan-CoreTechs/b20d8270-03af-4e10-9ba1-e05594e495e8/scratchpad/gitroot/long/segment-number-01/segment-number-02/segment-number-03/segment-number-04/segment-number-05/segment-number-06/segment-number-07/segment-number-08/segment-number-09'

describe('encodeProjectKey', () => {
  it('encodes paths like Claude Code, including non-ASCII characters', () => {
    expect(encodeProjectKey('/Users/me/Boen Proje Dosyaları/BoenCV')).toBe(
      '-Users-me-Boen-Proje-Dosyalar--BoenCV'
    )
    expect(encodeProjectPath).toBe(encodeProjectKey)
  })

  it('keeps names up to 200 chars as they are', () => {
    const path = `/${'a'.repeat(199)}`
    expect(encodeProjectKey(path)).toBe(`-${'a'.repeat(199)}`)
  })

  it('cuts long names and appends the hash of the raw path', () => {
    const name = encodeProjectKey(LONG)
    expect(name).toHaveLength(207)
    expect(name.endsWith('-x76oab')).toBe(true)
    expect(name.slice(0, 200)).toBe(LONG.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 200))
  })

  it('uses the absolute value of a negative hash', () => {
    expect(encodeProjectKey(`${LONG}/neg0`).endsWith('-1bt2ro')).toBe(true)
  })
})

describe('resolveMemoryKey', () => {
  let root: string

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'claudedeck-key-')))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('uses the git root for nested folders', () => {
    const repo = join(root, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'packages', 'web'), { recursive: true })
    expect(resolveMemoryKey(join(repo, 'packages', 'web'))).toBe(repo)
    expect(resolveMemoryKey(repo)).toBe(repo)
  })

  it('counts a .git file (worktree or submodule) as a root', () => {
    const outer = join(root, 'outer')
    const worktree = join(outer, 'wt')
    mkdirSync(join(outer, '.git'), { recursive: true })
    mkdirSync(join(worktree, 'src'), { recursive: true })
    writeFileSync(join(worktree, '.git'), 'gitdir: /somewhere\n')
    expect(resolveMemoryKey(join(worktree, 'src'))).toBe(worktree)
  })

  it('falls back to the real path outside a repository and resolves symlinks', () => {
    const plain = join(root, 'plain', 'app')
    mkdirSync(plain, { recursive: true })
    const link = join(root, 'link')
    symlinkSync(plain, link)
    // tmpdir may itself sit inside a repo on some machines; only assert when it does not.
    if (resolveMemoryKey(plain) === plain) expect(resolveMemoryKey(link)).toBe(plain)
  })

  it('keeps a missing path as given', () => {
    expect(resolveMemoryKey('/definitely/missing/claudedeck-app')).toBe(
      '/definitely/missing/claudedeck-app'
    )
  })

  it('builds the memory folder from the key', () => {
    const repo = join(root, 'repo')
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, 'web'))
    expect(memoryDir('/cfg', join(repo, 'web'))).toBe(
      join('/cfg', 'projects', encodeProjectKey(repo), 'memory')
    )
  })
})

describe('memory paths on Windows', () => {
  const realpath = (path: string): string => win32.resolve(path)

  it('encodes drive-letter paths like C:\\Users\\x\\p -> C--Users-x-p', () => {
    expect(encodeProjectKey(win32.join('C:\\', 'Users', 'x', 'p'))).toBe('C--Users-x-p')
    expect(encodeProjectKey('D:\\Work\\Boen Proje\\app.v2')).toBe('D--Work-Boen-Proje-app-v2')
  })

  it('finds the git root through backslashes and forward slashes', () => {
    const hasGitEntry = (dir: string): boolean => dir === 'C:\\Users\\x\\repo'
    const deps = { path: win32, realpath, hasGitEntry }
    expect(resolveMemoryKey('C:\\Users\\x\\repo\\packages\\web', deps)).toBe('C:\\Users\\x\\repo')
    expect(resolveMemoryKey('C:/Users/x/repo/packages', deps)).toBe('C:\\Users\\x\\repo')
  })

  it('stops at the drive root and falls back to the real path', () => {
    const visited: string[] = []
    const hasGitEntry = (dir: string): boolean => {
      visited.push(dir)
      return false
    }
    const key = resolveMemoryKey('D:\\code\\app', { path: win32, realpath, hasGitEntry })
    expect(key).toBe('D:\\code\\app')
    expect(visited).toEqual(['D:\\code\\app', 'D:\\code', 'D:\\'])
  })

  it('accepts a git root at the drive root and resolves a missing path', () => {
    const hasGitEntry = (dir: string): boolean => dir === 'E:\\'
    const missing = (): string => {
      throw new Error('ENOENT')
    }
    expect(resolveMemoryKey('E:/x/y', { path: win32, realpath: missing, hasGitEntry })).toBe('E:\\')
  })

  it('joins the memory folder with backslashes', () => {
    expect(memoryDirForKey('C:\\Users\\x\\.claude', 'C:\\Users\\x\\p', win32)).toBe(
      'C:\\Users\\x\\.claude\\projects\\C--Users-x-p\\memory'
    )
  })
})
