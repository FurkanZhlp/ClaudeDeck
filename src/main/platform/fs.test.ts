import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  cloneCopy,
  copyRunner,
  nodeCopy,
  renameWithRetry,
  renameWithRetryAsync,
  retrySync,
  RETRY_DELAYS_MS,
  rmWithRetry,
  rmWithRetryAsync,
  safeSymlink
} from './fs'
import { windowsOnly } from '../../test/platform'

/** Lets a test make the next `cp` fail like Windows refusing to create a symlink. */
const cpControl = vi.hoisted(() => ({ failNext: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    cp: (...args: Parameters<typeof actual.cp>) => {
      if (cpControl.failNext) {
        cpControl.failNext = false
        return Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' }))
      }
      return actual.cp(...args)
    }
  }
})

const fsError = (code: string): NodeJS.ErrnoException =>
  Object.assign(new Error(code), { code }) as NodeJS.ErrnoException

/** Fails with `code` for the first `times` calls, then succeeds. */
const flaky = (code: string, times: number): Mock<(...args: unknown[]) => void> => {
  let calls = 0
  return vi.fn<(...args: unknown[]) => void>(() => {
    if (calls++ < times) throw fsError(code)
  })
}

describe('rmWithRetry and friends (Windows)', () => {
  it.each(['EPERM', 'EBUSY', 'EACCES'])('retries %s with a short backoff', (code) => {
    const rm = flaky(code, 2)
    const sleep = vi.fn()
    rmWithRetry('win32', { rm, sleep })('a')
    expect(rm).toHaveBeenCalledTimes(3)
    expect(rm).toHaveBeenLastCalledWith('a', undefined)
    expect(sleep.mock.calls).toEqual([[RETRY_DELAYS_MS[0]], [RETRY_DELAYS_MS[1]]])
  })

  it('gives up after the last delay and rethrows', () => {
    const rm = flaky('EBUSY', 100)
    const sleep = vi.fn()
    expect(() => rmWithRetry('win32', { rm, sleep })('x', { force: true })).toThrow('EBUSY')
    expect(rm).toHaveBeenCalledTimes(RETRY_DELAYS_MS.length + 1)
    expect(rm).toHaveBeenLastCalledWith('x', { force: true })
  })

  it('does not retry other errors', () => {
    const rm = flaky('ENOENT', 1)
    const sleep = vi.fn()
    expect(() => rmWithRetry('win32', { rm, sleep })('a')).toThrow('ENOENT')
    expect(sleep).not.toHaveBeenCalled()
  })

  it('never retries on POSIX', () => {
    const rm = flaky('EBUSY', 1)
    const sleep = vi.fn()
    expect(() => rmWithRetry('darwin', { rm, sleep })('a')).toThrow('EBUSY')
    expect(rm).toHaveBeenCalledTimes(1)
  })

  it('retries a sync rename on Windows only', () => {
    const rename = flaky('EBUSY', 1)
    const sleep = vi.fn()
    renameWithRetry('win32', { rename, sleep })('a', 'b')
    expect(rename).toHaveBeenCalledTimes(2)
    expect(rename).toHaveBeenLastCalledWith('a', 'b')
    expect(sleep).toHaveBeenCalledWith(RETRY_DELAYS_MS[0])

    const posixRename = flaky('EBUSY', 1)
    expect(() => renameWithRetry('darwin', { rename: posixRename, sleep })('a', 'b')).toThrow(
      'EBUSY'
    )
    expect(posixRename).toHaveBeenCalledTimes(1)
  })

  it('has async variants', async () => {
    let calls = 0
    const rename = vi.fn(async () => {
      if (calls++ === 0) throw fsError('EPERM')
    })
    const sleep = vi.fn(async () => undefined)
    await renameWithRetryAsync('win32', { rename, sleep })('a', 'b')
    expect(rename).toHaveBeenCalledTimes(2)
    const rm = vi.fn(async () => {
      throw fsError('EPERM')
    })
    await expect(rmWithRetryAsync('darwin', { rm, sleep })('x')).rejects.toThrow('EPERM')
    expect(rm).toHaveBeenCalledTimes(1)
  })

  it('retrySync returns the value of the first success', () => {
    let n = 0
    expect(
      retrySync(
        () => {
          if (n++ === 0) throw fsError('EACCES')
          return 42
        },
        () => undefined
      )
    ).toBe(42)
  })

  it('works against the real file system', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claudedeck-fs-'))
    writeFileSync(join(dir, 'a'), 'x')
    await renameWithRetryAsync('win32')(join(dir, 'a'), join(dir, 'b'))
    expect(readFileSync(join(dir, 'b'), 'utf8')).toBe('x')
    renameWithRetry('win32')(join(dir, 'b'), join(dir, 'c'))
    expect(readFileSync(join(dir, 'c'), 'utf8')).toBe('x')
    rmWithRetry('win32')(dir, { recursive: true, force: true })
    expect(existsSync(dir)).toBe(false)
  })
})

describe('safeSymlink', () => {
  it('makes a plain symlink on POSIX', async () => {
    const symlink = vi.fn(async () => undefined)
    await safeSymlink('darwin', { symlink })('../x', '/p/link')
    expect(symlink).toHaveBeenCalledWith('../x', '/p/link')
  })

  it('uses a junction with an absolute target for folders on Windows', async () => {
    const symlink = vi.fn(async () => undefined)
    await safeSymlink('win32', { symlink, isDirectory: async () => true })('../x', '/p/q/link')
    expect(symlink).toHaveBeenCalledWith(resolve('/p/x'), '/p/q/link', 'junction')
  })

  it('uses a file symlink for files on Windows', async () => {
    const symlink = vi.fn(async () => undefined)
    await safeSymlink('win32', { symlink, isDirectory: async () => false })('x.md', '/p/link')
    expect(symlink).toHaveBeenCalledWith('x.md', '/p/link', 'file')
  })

  it('copies a target inside the given roots when Windows refuses the link', async () => {
    // .native expands Windows 8.3 short names (RUNNER~1) like the async realpath does.
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'claudedeck-fs-')))
    writeFileSync(join(dir, 'x.md'), 'x')
    const symlink = vi.fn(async () => {
      throw fsError('EPERM')
    })
    const copy = vi.fn(async () => undefined)
    const link = safeSymlink('win32', { symlink, isDirectory: async () => false, copy })
    await link('x.md', join(dir, 'link'), [dir])
    expect(copy).toHaveBeenCalledWith(join(dir, 'x.md'), join(dir, 'link'))
  })

  it('skips the copy for a target outside the roots or a missing one', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'claudedeck-fs-'))
    const outside = mkdtempSync(join(tmpdir(), 'claudedeck-fs-'))
    writeFileSync(join(outside, 'secret'), 's')
    const symlink = vi.fn(async () => {
      throw fsError('EPERM')
    })
    const copy = vi.fn(async () => undefined)
    const link = safeSymlink('win32', { symlink, isDirectory: async () => false, copy })
    await link(join(outside, 'secret'), join(profile, 'a'), [profile])
    await link('missing.md', join(profile, 'b'), [profile])
    await link(join(outside, 'secret'), join(profile, 'c'))
    expect(copy).not.toHaveBeenCalled()
  })

  windowsOnly('creates a real junction for a folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claudedeck-fs-'))
    mkdirSync(join(dir, 'target'))
    writeFileSync(join(dir, 'target', 'f.md'), 'x')
    mkdirSync(join(dir, 'sub'))
    // A relative folder target becomes an absolute junction; no privilege is needed for it.
    await safeSymlink('win32')(join('..', 'target'), join(dir, 'sub', 'link'), [dir])
    expect(lstatSync(join(dir, 'sub', 'link')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(dir, 'sub', 'link', 'f.md'), 'utf8')).toBe('x')
  })

  it('rethrows other errors', async () => {
    const symlink = vi.fn(async () => {
      throw fsError('EEXIST')
    })
    const copy = vi.fn(async () => undefined)
    await expect(
      safeSymlink('win32', { symlink, isDirectory: async () => true, copy })('x', '/p/link')
    ).rejects.toThrow('EEXIST')
    expect(copy).not.toHaveBeenCalled()
  })
})

describe('copyRunner', () => {
  it('clones only on macOS', () => {
    expect(copyRunner('darwin')).toBe(cloneCopy)
    expect(copyRunner('win32')).toBe(nodeCopy)
  })

  it('nodeCopy resolves links on EPERM only when they stay inside src or the roots', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claudedeck-fs-'))
    const profile = join(dir, 'profile')
    const src = join(profile, 'plugins')
    mkdirSync(join(src, 'p'), { recursive: true })
    mkdirSync(join(dir, 'outside'))
    writeFileSync(join(src, 'p', 'f'), 'inside')
    writeFileSync(join(profile, 'shared.md'), 'profile file')
    writeFileSync(join(dir, 'outside', 'secret'), 'secret')
    symlinkSync(join(src, 'p', 'f'), join(src, 'in-src'))
    symlinkSync(join(profile, 'shared.md'), join(src, 'in-profile'))
    symlinkSync(join(dir, 'outside', 'secret'), join(src, 'out'))
    symlinkSync(join(dir, 'outside'), join(src, 'out-dir'))
    symlinkSync(join(dir, 'gone'), join(src, 'dangling'))
    // Windows without Developer Mode: creating the verbatim links is refused.
    cpControl.failNext = true
    await nodeCopy(src, join(dir, 'dst'), false, [profile])
    const dst = join(dir, 'dst')
    expect(readFileSync(join(dst, 'in-src'), 'utf8')).toBe('inside')
    expect(lstatSync(join(dst, 'in-src')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(dst, 'in-profile'), 'utf8')).toBe('profile file')
    for (const name of ['out', 'out-dir', 'dangling']) {
      expect(existsSync(join(dst, name))).toBe(false)
    }
  })

  it('nodeCopy copies a folder with timestamps', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'claudedeck-fs-'))
    mkdirSync(join(dir, 'src', 'n'), { recursive: true })
    writeFileSync(join(dir, 'src', 'n', 'f'), 'hello')
    await nodeCopy(join(dir, 'src'), join(dir, 'dst'), true)
    expect(readFileSync(join(dir, 'dst', 'n', 'f'), 'utf8')).toBe('hello')
  })
})
