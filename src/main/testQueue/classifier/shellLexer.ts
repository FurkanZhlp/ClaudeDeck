/**
 * POSIX-ish shell tokenizer for test command detection. It never executes or expands anything:
 * quotes and escapes are removed, `$(...)`, backticks and process substitutions are kept as
 * opaque text, heredoc bodies are skipped and redirections are dropped. The result is a list of
 * simple commands (one per pipeline element, list element or subshell part).
 */

export interface Word {
  /** Text with quotes and escapes removed; substitutions are kept verbatim. */
  text: string
  /** Any part of the word was quoted or escaped. */
  quoted: boolean
  /** Contains a command substitution (`$(...)`, backticks, `<(...)`): its value is unknown. */
  opaque: boolean
  /** Starts with an unquoted `NAME=` (or `NAME+=`), so it is an assignment in command position. */
  assignable: boolean
}

export interface Segment {
  words: Word[]
  /** Source text of the segment (from its first to its last token, redirections included). */
  raw: string
}

type Token =
  | { kind: 'word'; word: Word; start: number; end: number }
  | { kind: 'op'; start: number; end: number }
  | { kind: 'redir'; start: number; end: number }

interface Heredoc {
  delimiter: string
  stripTabs: boolean
}

/** Nested `$(...)` levels scanned before the rest of the input is treated as opaque. */
const MAX_NESTING = 32
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/
const REDIRECTIONS = ['<<<', '<<-', '<<', '<>', '<&', '<', '>>', '>&', '>|', '>']

const isBlank = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\r'
const isMeta = (ch: string): boolean => ';&|()<>\n'.includes(ch) || isBlank(ch)

class Lexer {
  private pos = 0
  private pending: Heredoc[] = []
  private heredocNext: { stripTabs: boolean } | null = null
  private nesting = 0

  constructor(private readonly src: string) {}

  /** Reads tokens until the end, or until the unmatched `)` when `nested`. */
  readList(nested: boolean): Token[] {
    const { src } = this
    const tokens: Token[] = []
    let depth = 0
    while (this.pos < src.length) {
      const start = this.pos
      const ch = src[this.pos]
      const next = src[this.pos + 1]
      if (isBlank(ch)) {
        this.pos++
      } else if (ch === '\\' && next === '\n') {
        this.pos += 2
      } else if (ch === '\n') {
        this.pos++
        tokens.push({ kind: 'op', start, end: this.pos })
        this.skipHeredocBodies()
      } else if (ch === '#') {
        while (this.pos < src.length && src[this.pos] !== '\n') this.pos++
      } else if (ch === ')') {
        this.pos++
        if (nested && depth === 0) return tokens
        if (depth > 0) depth--
        tokens.push({ kind: 'op', start, end: this.pos })
      } else if (ch === '(') {
        this.pos++
        depth++
        tokens.push({ kind: 'op', start, end: this.pos })
      } else if (ch === ';' || ch === '|') {
        this.pos +=
          next === ch || (ch === '|' && next === '&') || (ch === ';' && next === '&') ? 2 : 1
        tokens.push({ kind: 'op', start, end: this.pos })
      } else if (ch === '&') {
        if (next === '>') {
          this.pos += src[this.pos + 2] === '>' ? 3 : 2
          tokens.push({ kind: 'redir', start, end: this.pos })
        } else {
          this.pos += next === '&' ? 2 : 1
          tokens.push({ kind: 'op', start, end: this.pos })
        }
      } else if ((ch === '<' || ch === '>') && next !== '(') {
        tokens.push(this.readRedirection())
      } else {
        const word = this.readWord()
        if (word) tokens.push({ kind: 'word', word, start, end: this.pos })
      }
    }
    return tokens
  }

  private readRedirection(): Token {
    const start = this.pos
    const op = REDIRECTIONS.find((r) => this.src.startsWith(r, this.pos)) ?? '>'
    this.pos += op.length
    if (op === '<<' || op === '<<-') this.heredocNext = { stripTabs: op === '<<-' }
    return { kind: 'redir', start, end: this.pos }
  }

  /** Returns null for an fd number glued to a redirection (`2>&1`). */
  private readWord(): Word | null {
    const { src } = this
    let text = ''
    let quoted = false
    let opaque = false
    // Length of the leading text that came from plain, unquoted characters.
    let literalPrefix = -1
    const markSpecial = (): void => {
      if (literalPrefix < 0) literalPrefix = text.length
    }

    while (this.pos < src.length) {
      const ch = src[this.pos]
      const next = src[this.pos + 1]
      if ((ch === '<' || ch === '>') && next === '(') {
        markSpecial()
        text += this.readSubstitution()
        opaque = true
      } else if (isMeta(ch)) {
        break
      } else if (ch === '\\') {
        if (next === '\n') {
          this.pos += 2
          continue
        }
        markSpecial()
        quoted = true
        if (next !== undefined) text += next
        this.pos += 2
      } else if (ch === "'") {
        markSpecial()
        quoted = true
        const end = src.indexOf("'", this.pos + 1)
        const stop = end < 0 ? src.length : end
        text += src.slice(this.pos + 1, stop)
        this.pos = stop + 1
      } else if (ch === '"') {
        markSpecial()
        quoted = true
        this.pos++
        const inner = this.readDoubleQuoted()
        text += inner.text
        opaque ||= inner.opaque
      } else if (ch === '$' && next === "'") {
        markSpecial()
        quoted = true
        this.pos += 2
        text += this.readAnsiC()
      } else if (ch === '$' && next === '"') {
        this.pos++
      } else if (ch === '$' && next === '(') {
        markSpecial()
        text += this.readSubstitution()
        opaque = true
      } else if (ch === '$' && next === '{') {
        markSpecial()
        text += this.readBraced()
      } else if (ch === '`') {
        markSpecial()
        text += this.readBackticks()
        opaque = true
      } else {
        text += ch
        this.pos++
      }
    }

    const glued = src[this.pos] === '<' || src[this.pos] === '>'
    if (glued && !quoted && /^\d+$/.test(text)) return null

    const assignment = ASSIGNMENT.exec(text)
    const assignable = !!assignment && (literalPrefix < 0 || assignment[0].length <= literalPrefix)
    if (this.heredocNext) {
      this.pending.push({ delimiter: text, stripTabs: this.heredocNext.stripTabs })
      this.heredocNext = null
    }
    return { text, quoted, opaque, assignable }
  }

  private readDoubleQuoted(): { text: string; opaque: boolean } {
    const { src } = this
    let text = ''
    let opaque = false
    while (this.pos < src.length && src[this.pos] !== '"') {
      const ch = src[this.pos]
      const next = src[this.pos + 1]
      if (ch === '\\' && next !== undefined && '$`"\\\n'.includes(next)) {
        if (next !== '\n') text += next
        this.pos += 2
      } else if (ch === '$' && next === '(') {
        text += this.readSubstitution()
        opaque = true
      } else if (ch === '$' && next === '{') {
        text += this.readBraced()
      } else if (ch === '`') {
        text += this.readBackticks()
        opaque = true
      } else {
        text += ch
        this.pos++
      }
    }
    this.pos++
    return { text, opaque }
  }

  private readAnsiC(): string {
    const { src } = this
    let text = ''
    while (this.pos < src.length && src[this.pos] !== "'") {
      if (src[this.pos] === '\\' && this.pos + 1 < src.length) {
        const esc = src[this.pos + 1]
        text += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc
        this.pos += 2
      } else {
        text += src[this.pos++]
      }
    }
    this.pos++
    return text
  }

  /** `$(...)`, `$((...))`, `<(...)`, `>(...)`: scanned with the full lexer, kept verbatim. */
  private readSubstitution(): string {
    const start = this.pos
    this.pos += 2
    if (this.nesting >= MAX_NESTING) {
      this.pos = this.src.length
      return this.src.slice(start)
    }
    const outerPending = this.pending
    const outerHeredocNext = this.heredocNext
    this.pending = []
    this.heredocNext = null
    this.nesting++
    this.readList(true)
    this.nesting--
    this.pending = outerPending
    this.heredocNext = outerHeredocNext
    return this.src.slice(start, Math.min(this.pos, this.src.length))
  }

  private readBraced(): string {
    const { src } = this
    const start = this.pos
    let depth = 0
    while (this.pos < src.length) {
      const ch = src[this.pos++]
      if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) break
    }
    return src.slice(start, this.pos)
  }

  private readBackticks(): string {
    const { src } = this
    const start = this.pos++
    while (this.pos < src.length && src[this.pos] !== '`') {
      this.pos += src[this.pos] === '\\' ? 2 : 1
    }
    this.pos = Math.min(this.pos + 1, src.length)
    return src.slice(start, this.pos)
  }

  private skipHeredocBodies(): void {
    const { src } = this
    while (this.pending.length) {
      const doc = this.pending.shift() as Heredoc
      while (this.pos < src.length) {
        const newline = src.indexOf('\n', this.pos)
        const lineEnd = newline < 0 ? src.length : newline
        let line = src.slice(this.pos, lineEnd).replace(/\r$/, '')
        if (doc.stripTabs) line = line.replace(/^\t+/, '')
        this.pos = newline < 0 ? src.length : newline + 1
        if (line === doc.delimiter) break
      }
    }
  }
}

/** Splits a shell command line into simple commands. Never throws; bad syntax degrades. */
export function lex(input: string): Segment[] {
  const tokens = new Lexer(input).readList(false)
  const segments: Segment[] = []
  let words: Word[] = []
  let start = -1
  let end = -1
  let dropNextWord = false

  const flush = (): void => {
    if (words.length) segments.push({ words, raw: input.slice(start, end) })
    words = []
    start = -1
    dropNextWord = false
  }

  for (const token of tokens) {
    if (token.kind === 'op') {
      flush()
      continue
    }
    if (start < 0) start = token.start
    end = token.end
    if (token.kind === 'redir') {
      dropNextWord = true
    } else if (dropNextWord) {
      dropNextWord = false
    } else {
      words.push(token.word)
    }
  }
  flush()
  return segments
}
