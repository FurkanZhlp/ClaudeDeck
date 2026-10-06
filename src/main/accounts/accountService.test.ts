import { describe, expect, it } from 'vitest'
import { isInside, parseAuthStatus } from './accountService'

describe('parseAuthStatus', () => {
  it('giriş durumunu ve e-postayı okur', () => {
    expect(
      parseAuthStatus('{"loggedIn":true,"authMethod":"claude.ai","email":"a@b.co"}')
    ).toEqual({ loggedIn: true, email: 'a@b.co' })
  })
  it('giriş yoksa loggedIn false döner', () => {
    expect(parseAuthStatus('{"loggedIn": false, "authMethod": "none"}')).toEqual({
      loggedIn: false
    })
  })
  it('JSON öncesindeki gürültüyü tolere eder', () => {
    expect(parseAuthStatus('Uyarı: x\n{"loggedIn":true}').loggedIn).toBe(true)
  })
  it('geçersiz çıktıyı giriş yok sayar', () => {
    expect(parseAuthStatus('zsh: command not found: claude')).toEqual({ loggedIn: false })
  })
})

describe('isInside', () => {
  it('yalnızca kökün altındaki yolları kabul eder', () => {
    expect(isInside('/a/accounts', '/a/accounts/1')).toBe(true)
    expect(isInside('/a/accounts', '/a/accounts')).toBe(false)
    expect(isInside('/a/accounts', '/a/other')).toBe(false)
    expect(isInside('/a/accounts', '/a/accounts/../x')).toBe(false)
  })
})
