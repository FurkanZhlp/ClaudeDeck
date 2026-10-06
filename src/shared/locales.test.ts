import { describe, expect, it } from 'vitest'
import en from './locales/en.json'
import tr from './locales/tr.json'
import { createTranslator } from './translate'

const keys = (obj: object, prefix = ''): string[] =>
  Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]
  )

describe('çeviriler', () => {
  it('tr ve en aynı anahtarlara sahip', () => {
    expect(keys(tr).sort()).toEqual(keys(en).sort())
  })
  it('uzun tire içermez', () => {
    expect(JSON.stringify([tr, en])).not.toMatch(/[\u2013\u2014]/)
  })
  it('createTranslator değişkenleri yerleştirir', () => {
    expect(createTranslator('tr')('session.claudeTitle', { n: 2 })).toBe('Claude 2')
    expect(createTranslator('en')('menu.quit')).toBe('Quit ClaudeDeck')
  })
  it('bilinmeyen anahtarda anahtarın kendisini döner', () => {
    expect(createTranslator('tr')('yok.boyle')).toBe('yok.boyle')
  })
})
