import { describe, expect, it } from 'vitest'
import { resolveLanguage } from './language'

describe('resolveLanguage', () => {
  it('kullanıcı tercihi varsa onu döner', () => {
    expect(resolveLanguage('en', 'tr-TR')).toBe('en')
  })
  it('tercih yoksa tr ile başlayan sistem dilinde tr döner', () => {
    expect(resolveLanguage(null, 'tr-TR')).toBe('tr')
    expect(resolveLanguage(null, 'TR')).toBe('tr')
  })
  it('diğer sistem dillerinde en döner', () => {
    expect(resolveLanguage(null, 'de-DE')).toBe('en')
  })
})
