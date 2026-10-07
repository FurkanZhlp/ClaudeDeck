import { describe, expect, it } from 'vitest'
import { optimizeSupported } from './optimizeSupport'

describe('optimizeSupported', () => {
  it('is off on Windows only', () => {
    expect(optimizeSupported('win32')).toBe(false)
    expect(optimizeSupported('darwin')).toBe(true)
    expect(optimizeSupported('linux')).toBe(true)
  })
})
