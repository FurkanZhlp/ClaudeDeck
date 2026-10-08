import { describe, expect, it } from 'vitest'
import { navTargetIndex, pageScrollDelta } from './navKeys'
import {
  DEFAULT_SETTINGS_SECTION,
  isSettingsSectionId,
  readLastSection,
  writeLastSection
} from './sectionIds'

const memoryStorage = (): Storage => {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value)
  }
}

const throwingStorage = (): Storage =>
  ({
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('blocked')
    }
  }) as unknown as Storage

describe('settings last section', () => {
  it('remembers a written section', () => {
    const storage = memoryStorage()
    writeLastSection('testQueue', storage)
    expect(readLastSection(storage)).toBe('testQueue')
  })
  it('falls back to the default without storage, on errors and on unknown values', () => {
    expect(readLastSection(undefined)).toBe(DEFAULT_SETTINGS_SECTION)
    expect(readLastSection(throwingStorage())).toBe(DEFAULT_SETTINGS_SECTION)
    expect(() => writeLastSection('about', throwingStorage())).not.toThrow()
    const storage = memoryStorage()
    storage.setItem('claudedeck.settings.section', 'nope')
    expect(readLastSection(storage)).toBe(DEFAULT_SETTINGS_SECTION)
  })
  it('recognises only known ids', () => {
    expect(isSettingsSectionId('guard')).toBe(true)
    expect(isSettingsSectionId('Accounts')).toBe(false)
    expect(isSettingsSectionId(null)).toBe(false)
  })
})

describe('navTargetIndex', () => {
  it('wraps with the arrow keys', () => {
    expect(navTargetIndex('ArrowDown', 2, 3)).toBe(0)
    expect(navTargetIndex('ArrowUp', 0, 3)).toBe(2)
    expect(navTargetIndex('ArrowDown', 0, 3)).toBe(1)
  })
  it('starts at an end when nothing is focused', () => {
    expect(navTargetIndex('ArrowDown', -1, 3)).toBe(0)
    expect(navTargetIndex('ArrowUp', -1, 3)).toBe(2)
  })
  it('jumps with Home and End and ignores other keys', () => {
    expect(navTargetIndex('Home', 2, 3)).toBe(0)
    expect(navTargetIndex('End', 0, 3)).toBe(2)
    expect(navTargetIndex('Enter', 0, 3)).toBeNull()
    expect(navTargetIndex('ArrowDown', 0, 0)).toBeNull()
  })
})

describe('pageScrollDelta', () => {
  it('pages the content by most of its height', () => {
    expect(pageScrollDelta('PageDown', 800)).toBe(720)
    expect(pageScrollDelta('PageUp', 800)).toBe(-720)
  })
  it('leaves other keys to the navigation', () => {
    expect(pageScrollDelta('ArrowDown', 800)).toBeNull()
    expect(pageScrollDelta(' ', 800)).toBeNull()
  })
})
