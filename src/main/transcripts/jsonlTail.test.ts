import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_LINE_BYTES,
  createTail,
  feedTail,
  nextLineStart,
  readLinesBefore,
  readNewLines,
  type JsonlLine
} from './jsonlTail'

const line = (n: number, pad = 0): string => `${JSON.stringify({ n, pad: 'x'.repeat(pad) })}\n`
const values = (lines: JsonlLine[]): unknown[] => lines.map((l) => l.value.n)

describe('feedTail', () => {
  it('decodes complete lines only and keeps the rest for the next chunk', () => {
    const state = createTail()
    const text = Buffer.from(`${line(1)}${line(2)}{"n":`)
    expect(values(feedTail(state, text))).toEqual([1, 2])
    expect(nextLineStart(state)).toBe(line(1).length + line(2).length)
    const lines = feedTail(state, Buffer.from('3}\n'))
    expect(values(lines)).toEqual([3])
    expect(lines[0].offset).toBe(line(1).length + line(2).length)
  })

  it('keeps a multi-byte character split across chunks intact', () => {
    const state = createTail()
    const bytes = Buffer.from(`${JSON.stringify({ n: 1, s: 'çşığöü İ 🙂' })}\n`)
    const cut = bytes.indexOf(Buffer.from('🙂')) + 2
    expect(feedTail(state, bytes.subarray(0, cut))).toEqual([])
    const [only] = feedTail(state, bytes.subarray(cut))
    expect(only.value.s).toBe('çşığöü İ 🙂')
  })

  it('tolerates CRLF, blank lines, bad JSON and non-object values', () => {
    const state = createTail()
    const lines = feedTail(state, Buffer.from('{"n":1}\r\n\n{oops\n[1,2]\n"str"\n{"n":2}\n'))
    expect(values(lines)).toEqual([1, 2])
    expect(state.badLines).toBe(3)
  })

  it('skips lines over the limit, also when they span chunks', () => {
    const state = createTail()
    const huge = `${JSON.stringify({ n: 0, pad: 'y'.repeat(MAX_LINE_BYTES) })}\n`
    const all = Buffer.from(`${line(1)}${huge}${line(2)}`)
    const result: JsonlLine[] = []
    for (let i = 0; i < all.length; i += 300_000) {
      result.push(...feedTail(state, all.subarray(i, i + 300_000)))
    }
    expect(values(result)).toEqual([1, 2])
    expect(result[1].offset).toBe(line(1).length + huge.length)
    expect(state.skippedLines).toBe(1)
  })

  it('skips an over-long line contained in one chunk', () => {
    const state = createTail()
    const huge = `${JSON.stringify({ n: 0, pad: 'y'.repeat(MAX_LINE_BYTES) })}\n`
    expect(values(feedTail(state, Buffer.from(`${huge}${line(5)}`)))).toEqual([5])
    expect(state.skippedLines).toBe(1)
  })
})

describe('file reading', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cd-tail-'))
    file = join(dir, 't.jsonl')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('readNewLines follows appends, waits for unfinished lines and restarts on truncation', async () => {
    const state = createTail()
    expect(await readNewLines(file, state)).toEqual([])
    writeFileSync(file, `${line(1)}{"n":`)
    expect(values(await readNewLines(file, state))).toEqual([1])
    appendFileSync(file, `2}\n${line(3)}`)
    expect(values(await readNewLines(file, state))).toEqual([2, 3])
    expect(await readNewLines(file, state)).toEqual([])
    writeFileSync(file, line(9))
    const restarted = await readNewLines(file, state)
    expect(values(restarted)).toEqual([9])
    expect(restarted[0].offset).toBe(0)
  })

  it('readLinesBefore returns the tail window without the unfinished line', async () => {
    writeFileSync(file, `${line(1)}${line(2)}${line(3)}{"n":4`)
    const page = await readLinesBefore(file, Number.MAX_SAFE_INTEGER, 1 << 20)
    expect(values(page.lines)).toEqual([1, 2, 3])
    expect(page.start).toBeNull()
    expect(page.end).toBe(line(1).length * 3)

    const state = createTail(page.end)
    appendFileSync(file, '}\n')
    expect(values(await readNewLines(file, state))).toEqual([4])
  })

  it('pages backwards over every line exactly once', async () => {
    const text = Array.from({ length: 200 }, (_, i) => line(i, i % 7 === 0 ? 900 : 20)).join('')
    writeFileSync(file, text)
    const seen: unknown[] = []
    let end = Number.MAX_SAFE_INTEGER
    let pages = 0
    for (;;) {
      const page = await readLinesBefore(file, end, 2000)
      seen.unshift(...values(page.lines))
      pages++
      if (page.start === null) break
      expect(page.start).toBeLessThan(end)
      end = page.start
    }
    expect(seen).toEqual(Array.from({ length: 200 }, (_, i) => i))
    expect(pages).toBeGreaterThan(5)
  })

  it('includes a line straddling the window start when it fits', async () => {
    writeFileSync(file, `${line(1)}${line(2, 5000)}${line(3)}`)
    const page = await readLinesBefore(file, Number.MAX_SAFE_INTEGER, 10)
    expect(values(page.lines)).toEqual([3])
    const before = await readLinesBefore(file, page.start ?? 0, 10)
    expect(values(before.lines)).toEqual([2])
    expect(before.start).toBe(line(1).length)
  })

  it('skips an over-long line while paging and keeps going', async () => {
    const huge = `${JSON.stringify({ n: 0, pad: 'z'.repeat(MAX_LINE_BYTES + 10) })}\n`
    writeFileSync(file, `${line(1)}${huge}${line(2)}`)
    const last = await readLinesBefore(file, Number.MAX_SAFE_INTEGER, 100)
    expect(values(last.lines)).toEqual([2])
    const skipped = await readLinesBefore(file, last.start ?? 0, 100)
    expect(skipped.lines).toEqual([])
    expect(skipped.start).toBe(line(1).length)
    const first = await readLinesBefore(file, skipped.start ?? 0, 100)
    expect(values(first.lines)).toEqual([1])
    expect(first.start).toBeNull()
  })

  it('handles missing files and zero-byte windows', async () => {
    expect(await readLinesBefore(join(dir, 'none.jsonl'), 100, 100)).toEqual({
      lines: [],
      start: null,
      end: 0
    })
    writeFileSync(file, `${line(1)}${line(2)}`)
    const page = await readLinesBefore(file, Number.MAX_SAFE_INTEGER, 0)
    expect(page.lines).toEqual([])
    expect(page.end).toBe(line(1).length * 2)
  })
})
