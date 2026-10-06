import { describe, expect, it } from 'vitest'
import { encodeProjectPath, memoryDir } from './memoryPath'

describe('memoryPath', () => {
  it('encodes paths like Claude Code, including non-ASCII characters', () => {
    expect(encodeProjectPath('/Users/me/Boen Proje Dosyaları/BoenCV')).toBe(
      '-Users-me-Boen-Proje-Dosyalar--BoenCV'
    )
  })
  it('builds the memory folder path', () => {
    expect(memoryDir('/cfg', '/tmp/app')).toBe('/cfg/projects/-tmp-app/memory')
  })
})
