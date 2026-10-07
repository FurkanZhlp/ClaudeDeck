import { constants as fsConstants } from 'node:fs'
import { lstat, open, type FileHandle } from 'node:fs/promises'

/** Lines longer than this are skipped (counted in `skippedLines`), never buffered whole. */
export const MAX_LINE_BYTES = 1024 * 1024

const READ_CHUNK_BYTES = 256 * 1024
const SCAN_CHUNK_BYTES = 64 * 1024
const NEWLINE = 0x0a
const EMPTY = Buffer.alloc(0)

/** One complete, parsed JSONL line and the byte offset where it starts. */
export interface JsonlLine {
  offset: number
  value: Record<string, unknown>
}

/** Incremental reader state for one file. */
export interface TailState {
  /** Next byte to read. */
  offset: number
  /** Bytes of the unfinished last line; it starts at `offset - carry.length`. */
  carry: Buffer
  /** Inside a line over MAX_LINE_BYTES: bytes are dropped until the next newline. */
  skipping: boolean
  /** Inode of the file read so far; a different one means the file was replaced. */
  ino: number | null
  skippedLines: number
  badLines: number
}

export function createTail(offset = 0): TailState {
  return { offset, carry: EMPTY, skipping: false, ino: null, skippedLines: 0, badLines: 0 }
}

/** Where the next unread line starts (the unfinished line, if any). */
export const nextLineStart = (state: TailState): number => state.offset - state.carry.length

function resetTail(state: TailState): void {
  state.offset = 0
  state.carry = EMPTY
  state.skipping = false
}

function decodeLine(bytes: Buffer, state: TailState): Record<string, unknown> | null {
  const text = bytes.toString('utf8').trim()
  if (!text) return null
  try {
    const value: unknown = JSON.parse(text)
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    // Counted below; a torn or foreign line must not stop the reader.
  }
  state.badLines++
  return null
}

/**
 * Feeds the bytes that follow `state.offset` and returns the lines they complete. Only whole
 * lines (ending in 0x0A) are decoded, so a multi-byte character split across reads stays intact.
 */
export function feedTail(state: TailState, chunk: Buffer): JsonlLine[] {
  const lines: JsonlLine[] = []
  const base = state.offset
  let pos = 0
  while (pos < chunk.length) {
    const newline = chunk.indexOf(NEWLINE, pos)
    if (newline === -1) {
      if (!state.skipping) {
        const rest = chunk.subarray(pos)
        if (state.carry.length + rest.length > MAX_LINE_BYTES) {
          state.carry = EMPTY
          state.skipping = true
          state.skippedLines++
        } else {
          // Copied: the caller may reuse its read buffer.
          state.carry = Buffer.concat([state.carry, rest])
        }
      }
      break
    }
    if (state.skipping) {
      state.skipping = false
    } else {
      const piece = chunk.subarray(pos, newline)
      const lineOffset = base + pos - state.carry.length
      const whole = state.carry.length ? Buffer.concat([state.carry, piece]) : piece
      state.carry = EMPTY
      if (whole.length > MAX_LINE_BYTES) {
        state.skippedLines++
      } else {
        const value = decodeLine(whole, state)
        if (value) lines.push({ offset: lineOffset, value })
      }
    }
    pos = newline + 1
  }
  state.offset = base + chunk.length
  return lines
}

// Windows has neither flag (undefined there); the lstat and fstat checks still apply.
const OPEN_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)

/**
 * Opens a regular file for reading, or null. Symlinks, FIFOs, sockets and devices are refused
 * (lstat before, fstat after opening; O_NOFOLLOW closes the race in between, O_NONBLOCK keeps
 * a FIFO swapped in from blocking the open), so a planted link or pipe in a transcript folder
 * never makes ClaudeDeck read elsewhere or hang.
 */
export async function openRegularFile(path: string): Promise<FileHandle | null> {
  try {
    if (!(await lstat(path)).isFile()) return null
  } catch {
    return null
  }
  let fh: FileHandle
  try {
    fh = await open(path, OPEN_FLAGS)
  } catch {
    return null
  }
  try {
    if ((await fh.stat()).isFile()) return fh
  } catch {
    // treated as not a regular file
  }
  await fh.close().catch(() => undefined)
  return null
}

async function readRange(fh: FileHandle, from: number, to: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(Math.max(0, to - from))
  let filled = 0
  while (filled < buffer.length) {
    const { bytesRead } = await fh.read(buffer, filled, buffer.length - filled, from + filled)
    if (bytesRead <= 0) break
    filled += bytesRead
  }
  return buffer.subarray(0, filled)
}

/**
 * Reads what was appended since the last call. Starts over when the file shrank or was replaced.
 * A missing file yields nothing and keeps the state.
 */
export async function readNewLines(path: string, state: TailState): Promise<JsonlLine[]> {
  const fh = await openRegularFile(path)
  if (!fh) return []
  const lines: JsonlLine[] = []
  try {
    const { size, ino } = await fh.stat()
    const replaced = state.ino !== null && ino !== 0 && ino !== state.ino
    if (replaced || size < state.offset) resetTail(state)
    state.ino = ino
    if (size === state.offset) return []
    while (state.offset < size) {
      const chunk = await readRange(
        fh,
        state.offset,
        Math.min(size, state.offset + READ_CHUNK_BYTES)
      )
      if (chunk.length === 0) break
      for (const line of feedTail(state, chunk)) lines.push(line)
    }
  } finally {
    await fh.close()
  }
  return lines
}

/** Index of the last newline strictly before `pos`, or -1. */
async function lastNewlineBefore(fh: FileHandle, pos: number): Promise<number> {
  let end = pos
  while (end > 0) {
    const from = Math.max(0, end - SCAN_CHUNK_BYTES)
    const chunk = await readRange(fh, from, end)
    const index = chunk.lastIndexOf(NEWLINE)
    if (index !== -1) return from + index
    end = from
  }
  return -1
}

export interface LinesPage {
  lines: JsonlLine[]
  /** Offset of the first line covered (pass as `end` for the previous page); null at offset 0. */
  start: number | null
  /** Offset right after the last complete line covered; a tail may continue from here. */
  end: number
}

/**
 * Complete lines in roughly the last `bytes` before `end` (an unfinished line at `end` is left
 * out). A line straddling the window start is included whole when it fits MAX_LINE_BYTES; a
 * longer one is skipped and the page may be empty with a non-null `start`.
 */
export async function readLinesBefore(
  path: string,
  end: number,
  bytes: number
): Promise<LinesPage> {
  const none: LinesPage = { lines: [], start: null, end: 0 }
  const fh = await openRegularFile(path)
  if (!fh) return none
  try {
    const size = (await fh.stat()).size
    const stopNewline = await lastNewlineBefore(fh, Math.min(end, size))
    if (stopNewline < 0) return none
    const stop = stopNewline + 1
    if (bytes <= 0) return { lines: [], start: stop, end: stop }

    const lastStart = (await lastNewlineBefore(fh, stopNewline)) + 1
    if (stop - lastStart > MAX_LINE_BYTES) {
      return { lines: [], start: lastStart === 0 ? null : lastStart, end: stop }
    }
    const from = Math.max(0, stop - bytes)
    let begin: number
    let buffer: Buffer
    if (from === 0 || lastStart <= from) {
      begin = from === 0 ? 0 : lastStart
      buffer = await readRange(fh, begin, stop)
    } else {
      // Read one byte early so a line starting exactly at `from` is recognised.
      const window = await readRange(fh, from - 1, stop)
      const first = window.indexOf(NEWLINE)
      begin = from + first
      buffer = window.subarray(first + 1)
    }
    const lines = feedTail(createTail(begin), buffer)
    return { lines, start: begin === 0 ? null : begin, end: stop }
  } finally {
    await fh.close()
  }
}
