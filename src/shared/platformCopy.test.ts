import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import tr from './locales/tr.json'
import { PLATFORM_COPY_KEY, withPlatformCopy } from './platformCopy'

/** Dotted paths of every string in a dictionary. */
const leaves = (obj: object, prefix = ''): string[] =>
  Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null ? leaves(v, `${prefix}${k}.`) : [`${prefix}${k}`]
  )

describe('withPlatformCopy', () => {
  it('replaces only the overridden strings', () => {
    const dict = {
      a: { b: 'mac', c: 'same' },
      d: 'x',
      platformCopy: { win32: { a: { b: 'win' } } }
    }
    expect(withPlatformCopy(dict, 'win32')).toEqual({ a: { b: 'win', c: 'same' }, d: 'x' })
    expect(withPlatformCopy(dict, 'darwin')).toEqual({ a: { b: 'mac', c: 'same' }, d: 'x' })
  })
  it('works without a variants section', () => {
    expect(withPlatformCopy({ a: 'x' }, 'win32')).toEqual({ a: 'x' })
  })
  it.each([
    ['en', en],
    ['tr', tr]
  ])('every %s platform string overrides an existing key', (_, dict) => {
    const base = leaves(withPlatformCopy(dict, 'darwin'))
    const variants = (dict as unknown as Record<string, Record<string, object>>)[PLATFORM_COPY_KEY]
    for (const overrides of Object.values(variants)) {
      for (const key of leaves(overrides)) expect(base).toContain(key)
    }
  })
  it('keeps macOS wording unchanged and uses Windows wording on win32', () => {
    expect(withPlatformCopy(tr, 'darwin')).toMatchObject({ notes: { reveal: "Finder'da göster" } })
    expect(withPlatformCopy(tr, 'win32')).toMatchObject({
      notes: { reveal: "Dosya Gezgini'nde göster" }
    })
    expect(withPlatformCopy(en, 'win32')).toMatchObject({
      errors: {
        CLAUDE_NOT_FOUND: expect.stringContaining('irm https://claude.ai/install.ps1 | iex')
      }
    })
  })
})
