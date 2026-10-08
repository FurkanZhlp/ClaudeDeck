import type { OsName } from '../platform/types'
import { canon } from './paths'

/**
 * Brace expansion and glob matching for paths the guard checks. Nothing touches the file
 * system: a glob is compared with the protected and critical locations it could match.
 */

/** Words one brace expression may expand to before the target counts as unknown. */
export const MAX_BRACE_WORDS = 64

const RANGE = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(?:\.\.(-?\d+))?$/

/** Alternatives of the first `{a,b}` or `{1..3}` group in `text`, or null when there is none. */
function firstGroup(text: string): { start: number; end: number; parts: string[] } | null {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') {
      i++
      continue
    }
    if (text[i] !== '{' || text[i - 1] === '$') continue
    let depth = 0
    const commas: number[] = []
    let end = -1
    for (let j = i; j < text.length; j++) {
      const ch = text[j]
      if (ch === '\\') j++
      else if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) {
        end = j
        break
      } else if (ch === ',' && depth === 1) commas.push(j)
    }
    if (end < 0) return null
    const inner = text.slice(i + 1, end)
    if (commas.length) {
      const parts: string[] = []
      let from = i + 1
      for (const c of commas) {
        parts.push(text.slice(from, c))
        from = c + 1
      }
      parts.push(text.slice(from, end))
      return { start: i, end: end + 1, parts }
    }
    const range = RANGE.exec(inner)
    if (range) {
      const parts = rangeParts(range[1], range[2], range[3])
      if (parts) return { start: i, end: end + 1, parts }
    }
  }
  return null
}

function rangeParts(a: string, b: string, stepText: string | undefined): string[] | null {
  const numeric = /^-?\d+$/.test(a) && /^-?\d+$/.test(b)
  if (!numeric && (a.length !== 1 || b.length !== 1 || /\d/.test(a + b))) return null
  const from = numeric ? Number(a) : a.charCodeAt(0)
  const to = numeric ? Number(b) : b.charCodeAt(0)
  const step = Math.abs(Number(stepText ?? 1)) || 1
  const count = Math.floor(Math.abs(to - from) / step) + 1
  // A range too long counts as too many words (the caller treats the target as unknown).
  if (count > MAX_BRACE_WORDS) return Array.from({ length: MAX_BRACE_WORDS + 1 }, () => '')
  const dir = to >= from ? 1 : -1
  const out: string[] = []
  for (let k = 0; k < count; k++) {
    const v = from + dir * step * k
    out.push(numeric ? String(v) : String.fromCharCode(v))
  }
  return out
}

/**
 * Brace expansion as bash does it (`~/{.ssh,x}`, `/etc{,}`, `{1..3}`), nested groups included;
 * a word without braces comes back as it is. Null when it would give more than MAX words.
 */
export function expandBraces(text: string, max = MAX_BRACE_WORDS): string[] | null {
  if (!text.includes('{')) return [text]
  let done: string[] = []
  let todo = [text]
  while (todo.length) {
    const next: string[] = []
    for (const word of todo) {
      const group = firstGroup(word)
      if (!group) {
        done.push(word)
        continue
      }
      for (const part of group.parts)
        next.push(word.slice(0, group.start) + part + word.slice(group.end))
    }
    if (done.length + next.length > max) return null
    todo = next
  }
  done = [...new Set(done)]
  return done
}

/** Glob characters in a path (`*`, `?`, `[`). */
export const hasGlob = (text: string): boolean => /[*?[]/.test(text)

/** A path segment of a location: a fixed name, any name, or any name not starting with a dot. */
export type CandidatePart = string | { any: true; dot: boolean }

export const ANY: CandidatePart = { any: true, dot: true }
export const NON_DOT: CandidatePart = { any: true, dot: false }

/** A location a glob is compared with. */
export interface Candidate {
  parts: CandidatePart[]
  rule: string
  /** Critical folder: only its own deletion counts, not writes inside it. */
  critical: boolean
}

/** Regex for one glob segment (`*` and `?` stay within the segment). */
function segmentRegex(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '*') out += '.*'
    else if (ch === '?') out += '.'
    else if (ch === '[') {
      const close = glob.indexOf(']', i + 2)
      if (close < 0) {
        out += '\\['
        continue
      }
      let body = glob.slice(i + 1, close)
      const negated = body.startsWith('!') || body.startsWith('^')
      if (negated) body = body.slice(1)
      out += `[${negated ? '^' : ''}${body.replace(/[\\\]^]/g, '\\$&')}]`
      i = close
    } else out += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  }
  return new RegExp(`^${out}$`, 'is')
}

/** A glob segment can name `part`. Leading dots are only matched by a literal dot. */
function segmentMatches(glob: string, part: CandidatePart): boolean {
  if (typeof part !== 'string') return part.dot || !glob.startsWith('.')
  if (part.startsWith('.') && !glob.startsWith('.')) return false
  if (!hasGlob(glob)) return glob === part
  return segmentRegex(glob).test(part)
}

/** Segments of an absolute path (canonical case, so globs keep their characters). */
function globSegments(path: string, os: OsName): string[] {
  return canon(path, os)
    .split(os === 'win32' ? '\\' : '/')
    .filter(Boolean)
}

/**
 * Rules of the candidates an absolute glob path can reach: it may be the location itself or a
 * path inside it (protected locations), or, for a recursive delete, one of its parents.
 */
export function globRules(
  path: string,
  recursive: boolean,
  candidates: readonly Candidate[],
  os: OsName
): string[] {
  const glob = globSegments(path, os)
  const rules: string[] = []
  for (const c of candidates) {
    const k = Math.min(glob.length, c.parts.length)
    if (glob.length < c.parts.length && !recursive) continue
    if (glob.length > c.parts.length && c.critical) continue
    if (glob.length === c.parts.length && c.critical && !recursive) continue
    let match = true
    for (let i = 0; i < k && match; i++) match = segmentMatches(glob[i], c.parts[i])
    if (match) rules.push(c.rule)
  }
  return [...new Set(rules)]
}

/** Candidate parts of a fixed absolute path. */
export const fixedParts = (path: string, os: OsName): CandidatePart[] => globSegments(path, os)
