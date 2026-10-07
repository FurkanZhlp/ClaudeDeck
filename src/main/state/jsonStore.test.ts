import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { JsonStore } from './jsonStore'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claudedeck-store-'))
  file = join(dir, 'nested', 'config.json')
})

describe('JsonStore', () => {
  it('dosya yoksa varsayılanı döner', () => {
    expect(new JsonStore(file, () => ({ a: 1 })).load()).toEqual({ a: 1 })
  })

  it('kaydeder ve geri okur, eksik alanları varsayılandan tamamlar', () => {
    const store = new JsonStore<{ a: number; b?: string }>(file, () => ({ a: 1, b: 'x' }))
    store.save({ a: 2 })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ a: 2 })
    expect(store.load()).toEqual({ a: 2, b: 'x' })
    expect(readdirSync(join(dir, 'nested'))).toEqual(['config.json'])
  })

  it('bozuk dosyayı yedekleyip varsayılana döner', () => {
    new JsonStore(file, () => ({})).save({})
    writeFileSync(file, '{bozuk')
    expect(new JsonStore(file, () => ({ a: 1 })).load()).toEqual({ a: 1 })
    expect(readdirSync(join(dir, 'nested')).some((f) => f.startsWith('config.json.corrupt-'))).toBe(
      true
    )
  })
})
