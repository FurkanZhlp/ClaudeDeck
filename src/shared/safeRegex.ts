/**
 * Static check for user regexes that could backtrack catastrophically (ReDoS). Conservative:
 * it refuses
 * - backreferences (`\1`, `\k<name>`),
 * - a repeated group that contains a repeated element (`(a+)+`, `(\w*x)*`, `((ab)*c){2,}`),
 * - a repeated group that contains an alternation (`(a|ab)*`),
 * - two unbounded repetitions over overlapping characters in sequence, where everything
 *   between them can be matched by the first (`.*.*`, `.+\w*.*`, `.*-rf.*`): searching for
 *   those is polynomial with a high degree. `\s+-rf\s+` is fine (`-` ends the first run).
 * `?` and `{0,1}` / `{1}` do not count as repetition; `{n,m}` with m above 32 counts as
 * unbounded. Patterns that do not compile are left to the caller.
 */
export function isSafeRegex(pattern: string): boolean {
  return noNestedRepetition(pattern) && noOverlappingRuns(pattern)
}

function noNestedRepetition(pattern: string): boolean {
  interface Group {
    repeats: boolean
    alternates: boolean
  }
  const stack: Group[] = [{ repeats: false, alternates: false }]
  let i = 0

  /** Length of a repeating quantifier at `at` (0 when there is none or it does not repeat). */
  const repeating = (at: number): { length: number; repeats: boolean } => {
    const c = pattern[at]
    if (c === '*' || c === '+') return { length: 1, repeats: true }
    if (c === '?') return { length: 1, repeats: false }
    if (c !== '{') return { length: 0, repeats: false }
    const match = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(at))
    if (!match) return { length: 0, repeats: false }
    const min = Number(match[1])
    const max = match[2] === undefined ? min : match[3] === '' ? Infinity : Number(match[3])
    return { length: match[0].length, repeats: max > 1 }
  }

  while (i < pattern.length) {
    const c = pattern[i]
    const top = stack[stack.length - 1]
    if (c === '\\') {
      const next = pattern[i + 1] ?? ''
      if (/[1-9]/.test(next) || next === 'k') return false
      i += 2
    } else if (c === '[') {
      // Character class: skip to its unescaped closing bracket.
      i++
      if (pattern[i] === '^') i++
      if (pattern[i] === ']') i++
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1
      i++
    } else if (c === '(') {
      stack.push({ repeats: false, alternates: false })
      i++
      // Skip group syntax such as `?:`, `?=`, `?<name>`, so its `?` is not read as a quantifier.
      if (pattern[i] === '?') {
        const named = /^\?<[A-Za-z_$][\w$]*>/.exec(pattern.slice(i))
        i += named ? named[0].length : pattern[i + 1] === '<' ? 3 : 2
      }
      continue
    } else if (c === ')') {
      if (stack.length === 1) return true
      const closed = stack.pop() as Group
      i++
      const q = repeating(i)
      if (q.repeats && (closed.repeats || closed.alternates)) return false
      const parent = stack[stack.length - 1]
      parent.repeats ||= closed.repeats || q.repeats
      if (q.length > 0) {
        i += q.length
        if (pattern[i] === '?') i++
      }
      continue
    } else if (c === '|') {
      top.alternates = true
      i++
      continue
    } else {
      i++
    }
    const q = repeating(i)
    if (q.length > 0) {
      if (q.repeats) stack[stack.length - 1].repeats = true
      i += q.length
      if (pattern[i] === '?') i++
    }
  }
  return true
}

/* Overlapping runs ---------------------------------------------------------------------------- */

/** A character set: the 128 ASCII characters as bits, and whether anything else is in it. */
interface CharSet {
  ascii: boolean[]
  other: boolean
}

const UNBOUNDED_MAX = 32

const charSet = (test: (code: number) => boolean, other: boolean): CharSet => ({
  ascii: Array.from({ length: 128 }, (_, c) => test(c)),
  other
})
const ALL = charSet(() => true, true)
const single = (ch: string): CharSet => {
  const code = ch.codePointAt(0) ?? 0
  return code < 128 ? charSet((c) => c === code, false) : charSet(() => false, true)
}
const isDigit = (c: number): boolean => c >= 48 && c <= 57
const isWord = (c: number): boolean =>
  isDigit(c) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95
const isSpace = (c: number): boolean => (c >= 9 && c <= 13) || c === 32
const CLASSES: Record<string, CharSet> = {
  d: charSet(isDigit, false),
  D: charSet((c) => !isDigit(c), true),
  w: charSet(isWord, false),
  W: charSet((c) => !isWord(c), true),
  s: charSet(isSpace, true),
  S: charSet((c) => !isSpace(c), true)
}
const ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', f: '\f', v: '\v', 0: '\0' }

function union(a: CharSet, b: CharSet): CharSet {
  return { ascii: a.ascii.map((x, i) => x || b.ascii[i]), other: a.other || b.other }
}
const overlaps = (a: CharSet, b: CharSet): boolean =>
  (a.other && b.other) || a.ascii.some((x, i) => x && b.ascii[i])
const invert = (a: CharSet): CharSet => ({ ascii: a.ascii.map((x) => !x), other: true })

/** An escape at `at` (after the backslash): its set (null for zero-width) and its length. */
function escapeAt(pattern: string, at: number): { set: CharSet | null; length: number } {
  const c = pattern[at] ?? ''
  if (CLASSES[c]) return { set: CLASSES[c], length: 1 }
  if (c === 'b' || c === 'B') return { set: null, length: 1 }
  if (ESCAPES[c]) return { set: single(ESCAPES[c]), length: 1 }
  const hex = /^(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4})/.exec(pattern.slice(at, at + 5))
  if (hex)
    return {
      set: single(String.fromCharCode(parseInt(hex[0].slice(1), 16))),
      length: hex[0].length
    }
  if (c === 'p' || c === 'P' || c === 'u' || c === 'c') {
    const braced = /^[pPu]\{[^}]*\}/.exec(pattern.slice(at))
    return { set: ALL, length: braced ? braced[0].length : 2 }
  }
  return { set: single(c), length: 1 }
}

/** A character class starting at `at` (`[`): its set and the index after it. */
function classAt(pattern: string, at: number): { set: CharSet; end: number } {
  let i = at + 1
  const negated = pattern[i] === '^'
  if (negated) i++
  let set = charSet(() => false, false)
  let first = true
  while (i < pattern.length && (pattern[i] !== ']' || first)) {
    first = false
    let item: CharSet
    let lowCode = -1
    if (pattern[i] === '\\') {
      const esc = escapeAt(pattern, i + 1)
      item = esc.set ?? charSet(() => false, false)
      if (esc.length === 1 && !CLASSES[pattern[i + 1]])
        lowCode = (ESCAPES[pattern[i + 1]] ?? pattern[i + 1]).charCodeAt(0)
      i += 1 + esc.length
    } else {
      lowCode = pattern.charCodeAt(i)
      item = single(pattern[i])
      i++
    }
    if (pattern[i] === '-' && pattern[i + 1] !== ']' && i + 1 < pattern.length && lowCode >= 0) {
      let high = pattern.charCodeAt(i + 1)
      let step = 2
      if (pattern[i + 1] === '\\') {
        high = (ESCAPES[pattern[i + 2]] ?? pattern[i + 2] ?? '').charCodeAt(0)
        step = 3
      }
      const low = lowCode
      item = charSet((c) => c >= low && c <= high, high >= 128)
      i += step
    }
    set = union(set, item)
  }
  return { set: negated ? invert(set) : set, end: i + 1 }
}

interface Atom {
  set: CharSet
  unbounded: boolean
  /** May match nothing (`?`, `*`, `{0,n}`, inside an alternation or optional group). */
  optional: boolean
}

/** Repetition at `at`: its length and whether it is unbounded. */
function quantifierAt(
  pattern: string,
  at: number
): { length: number; unbounded: boolean; optional: boolean } {
  const c = pattern[at]
  let length = 0
  let unbounded = false
  let optional = false
  if (c === '*' || c === '+') {
    length = 1
    unbounded = true
    optional = c === '*'
  } else if (c === '?') {
    length = 1
    optional = true
  } else if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(at))
    if (m) {
      length = m[0].length
      const max = m[2] === undefined ? Number(m[1]) : m[3] === '' ? Infinity : Number(m[3])
      unbounded = max > UNBOUNDED_MAX
      optional = Number(m[1]) === 0
    }
  }
  if (length && pattern[at + length] === '?') length++
  return { length, unbounded, optional }
}

/** The pattern as a flat sequence of atoms (groups and alternatives inlined: conservative). */
function atoms(pattern: string): Atom[] {
  const out: Atom[] = []
  const groupStarts: number[] = []
  // Atoms in a group with an alternation may be skipped.
  const alternates: boolean[] = []
  let topAlternation = false
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]
    let set: CharSet | null = null
    if (c === '(') {
      groupStarts.push(out.length)
      alternates.push(false)
      i++
      if (pattern[i] === '?') {
        const named = /^\?<[A-Za-z_$][\w$]*>/.exec(pattern.slice(i))
        i += named ? named[0].length : pattern[i + 1] === '<' ? 3 : 2
      }
      continue
    }
    if (c === ')') {
      const start = groupStarts.pop() ?? 0
      const alternated = alternates.pop() ?? false
      i++
      const q = quantifierAt(pattern, i)
      i += q.length
      if (q.unbounded) {
        // A repeated group is one run over everything in it.
        const inside = out.splice(start)
        const merged = inside.reduce(
          (acc, a) => union(acc, a.set),
          charSet(() => false, false)
        )
        out.push({ set: merged, unbounded: true, optional: q.optional || alternated })
      } else if (q.optional || alternated) {
        for (let k = start; k < out.length; k++) out[k].optional = true
      }
      continue
    }
    if (c === '|') {
      // Alternatives are inlined one after the other; each may be skipped.
      if (alternates.length) alternates[alternates.length - 1] = true
      else topAlternation = true
      i++
      continue
    }
    if (c === '^' || c === '$') {
      i++
      continue
    }
    if (c === '\\') {
      const esc = escapeAt(pattern, i + 1)
      set = esc.set
      i += 1 + esc.length
    } else if (c === '[') {
      const cls = classAt(pattern, i)
      set = cls.set
      i = cls.end
    } else {
      set = c === '.' ? ALL : single(c)
      i++
    }
    const q = quantifierAt(pattern, i)
    i += q.length
    if (set) out.push({ set, unbounded: q.unbounded, optional: q.optional })
  }
  return topAlternation ? out.map((a) => ({ ...a, optional: true })) : out
}

function noOverlappingRuns(pattern: string): boolean {
  const list = atoms(pattern)
  for (let a = 0; a < list.length; a++) {
    if (!list[a].unbounded) continue
    for (let b = a + 1; b < list.length; b++) {
      // A character the first run cannot take ends it: later runs are independent.
      if (!list[b].optional && !overlaps(list[b].set, list[a].set)) break
      if (list[b].unbounded && overlaps(list[b].set, list[a].set)) return false
    }
  }
  return true
}
