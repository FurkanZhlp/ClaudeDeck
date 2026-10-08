/**
 * POSIX-ish shell tokenizer shared by the test queue classifier and the command guard. It never
 * executes or expands anything:
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
  /** Set on a heredoc delimiter word: the body that follows the command line. */
  heredoc?: HeredocBody
}

export interface HeredocBody {
  /** Lines between the operator's line and the delimiter (tabs stripped for `<<-`). */
  body: string
  /** The delimiter was not quoted: the body undergoes `$(...)` and variable expansion. */
  expands: boolean
}

export interface Redirect {
  /** Operator as written (`>`, `>>`, `&>`, `<`, `2>` is `>` with the fd dropped, ...). */
  op: string
  target: Word
  /** Heredoc (`<<`, `<<-`) body; here-strings (`<<<`) keep their text in `target`. */
  heredoc?: HeredocBody
}

export interface Segment {
  words: Word[]
  /** Source text of the segment (from its first to its last token, redirections included). */
  raw: string
  /** Redirections of the segment with their targets (heredoc delimiters included). */
  redirects: Redirect[]
  /** Operator that ended the segment (`|`, `&&`, `;`, newline, `(`, ...); '' at the end. */
  op: string
}

type Token =
  | { kind: 'word'; word: Word; start: number; end: number }
  | { kind: 'op'; start: number; end: number }
  | { kind: 'redir'; start: number; end: number }

interface Heredoc {
  delimiter: string
  stripTabs: boolean
  doc: HeredocBody
}

/** Nested `$(...)` levels scanned before the rest of the input is treated as opaque. */
const MAX_NESTING = 32
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/
const REDIRECTIONS = ['<<<', '<<-', '<<', '<>', '<&', '<', '>>', '>&', '>|', '>']

const ANSI_C_SIMPLE: Record<string, string> = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?'
}

const isBlank = (ch: string): boolean => ch === ' ' || ch === '\t' || ch === '\r'
const isMeta = (ch: string): boolean => ';&|()<>\n'.includes(ch) || isBlank(ch)

class Lexer {
  private pos = 0
  private pending: Heredoc[] = []
  private heredocNext: { stripTabs: boolean } | null = null
  private nesting = 0
  /** Nesting went past MAX_NESTING: the rest of the input was not followed. */
  truncated = false

  constructor(private readonly src: string) {}

  /** End (exclusive) of the substitution starting at `from` (`$(`, `<(` or `>(`). */
  substitutionEnd(from: number): number {
    this.pos = from
    this.readSubstitution()
    return this.pos
  }

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
      const doc: HeredocBody = { body: '', expands: !quoted }
      this.pending.push({ delimiter: text, stripTabs: this.heredocNext.stripTabs, doc })
      this.heredocNext = null
      return { text, quoted, opaque, assignable, heredoc: doc }
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

  /** `$'...'` with the escapes bash applies (`\n`, `\x72`, `\162`, `\u0072`, `\cX`, ...). */
  private readAnsiC(): string {
    const { src } = this
    let text = ''
    while (this.pos < src.length && src[this.pos] !== "'") {
      if (src[this.pos] !== '\\' || this.pos + 1 >= src.length) {
        text += src[this.pos++]
        continue
      }
      const esc = src[this.pos + 1]
      this.pos += 2
      const simple = ANSI_C_SIMPLE[esc]
      if (simple !== undefined) {
        text += simple
      } else if (esc === 'x' || esc === 'u' || esc === 'U') {
        const max = esc === 'x' ? 2 : esc === 'u' ? 4 : 8
        const digits = /^[0-9A-Fa-f]+/.exec(src.slice(this.pos, this.pos + max))?.[0] ?? ''
        this.pos += digits.length
        const code = digits ? parseInt(digits, 16) : NaN
        text += digits && code <= 0x10ffff ? String.fromCodePoint(code) : `\\${esc}`
      } else if (esc >= '0' && esc <= '7') {
        const digits = esc + (/^[0-7]{0,2}/.exec(src.slice(this.pos, this.pos + 2))?.[0] ?? '')
        this.pos += digits.length - 1
        text += String.fromCharCode(parseInt(digits, 8) & 0xff)
      } else if (esc === 'c' && this.pos < src.length) {
        text += String.fromCharCode(src.charCodeAt(this.pos++) & 0x1f)
      } else {
        text += `\\${esc}`
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
      this.truncated = true
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
      const lines: string[] = []
      while (this.pos < src.length) {
        const newline = src.indexOf('\n', this.pos)
        const lineEnd = newline < 0 ? src.length : newline
        let line = src.slice(this.pos, lineEnd).replace(/\r$/, '')
        if (doc.stripTabs) line = line.replace(/^\t+/, '')
        this.pos = newline < 0 ? src.length : newline + 1
        if (line === doc.delimiter) break
        lines.push(line)
      }
      doc.doc.body = lines.join('\n')
    }
  }
}

/** Splits a shell command line into simple commands. Never throws; bad syntax degrades. */
export function lex(input: string): Segment[] {
  return lexInfo(input).segments
}

/** `lex`, and whether nesting limits cut the input short (the rest was not followed). */
export function lexInfo(input: string): { segments: Segment[]; truncated: boolean } {
  const lexer = new Lexer(input)
  const tokens = lexer.readList(false)
  const segments: Segment[] = []
  let words: Word[] = []
  let redirects: Redirect[] = []
  let start = -1
  let end = -1
  let redirOp: string | null = null

  const flush = (op: string): void => {
    if (words.length || redirects.length) {
      segments.push({ words, raw: input.slice(start, end), redirects, op })
    }
    words = []
    redirects = []
    start = -1
    redirOp = null
  }

  for (const token of tokens) {
    if (token.kind === 'op') {
      flush(input.slice(token.start, token.end))
      continue
    }
    if (start < 0) start = token.start
    end = token.end
    if (token.kind === 'redir') {
      redirOp = input.slice(token.start, token.end)
    } else if (redirOp !== null) {
      const { heredoc, ...target } = token.word
      redirects.push(heredoc ? { op: redirOp, target, heredoc } : { op: redirOp, target })
      redirOp = null
    } else {
      words.push(token.word)
    }
  }
  flush('')
  return { segments, truncated: lexer.truncated }
}

/**
 * Inner command texts of the substitutions in a word's text (`$(...)`, `<(...)`, `>(...)`,
 * backticks). Arithmetic `$((...))` is skipped. Only meaningful for opaque words: the text of a
 * quoted literal such as `'$(x)'` would be reported too, which errs on the side of checking.
 */
export function substitutionBodies(text: string): string[] {
  const bodies: string[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '\\') {
      i += 2
    } else if ((ch === '$' || ch === '<' || ch === '>') && next === '(') {
      if (ch === '$' && text[i + 2] === '(') {
        i += 3
        continue
      }
      const end = new Lexer(text).substitutionEnd(i)
      const closed = text[end - 1] === ')' && end > i + 2
      bodies.push(text.slice(i + 2, closed ? end - 1 : end))
      i = Math.max(end, i + 2)
    } else if (ch === '`') {
      let j = i + 1
      let body = ''
      while (j < text.length && text[j] !== '`') {
        if (text[j] === '\\' && j + 1 < text.length) {
          body += text[j + 1]
          j += 2
        } else {
          body += text[j++]
        }
      }
      bodies.push(body)
      i = j + 1
    } else {
      i++
    }
  }
  return bodies
}
