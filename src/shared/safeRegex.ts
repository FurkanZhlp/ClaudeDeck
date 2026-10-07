/**
 * Static check for user regexes that could backtrack catastrophically (ReDoS). Conservative:
 * it refuses
 * - backreferences (`\1`, `\k<name>`),
 * - a repeated group that contains a repeated element (`(a+)+`, `(\w*x)*`, `((ab)*c){2,}`),
 * - a repeated group that contains an alternation (`(a|ab)*`).
 * `?` and `{0,1}` / `{1}` do not count as repetition. Patterns that do not compile are left to
 * the caller.
 */
export function isSafeRegex(pattern: string): boolean {
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
