import {
  claudeScript,
  cmdName,
  cmdScript,
  full,
  nested,
  newState,
  packageRunner,
  parsePosix,
  powershellScript,
  push,
  type Arg,
  type Cmd,
  type ParseContext,
  type ParseState
} from './commands'
import { deleteTargets, psParam, psPositionals, psValue } from './targets'

/**
 * Small tokenizers for PowerShell and cmd.exe. They cover the common forms (cmdlets and their
 * aliases, parameters, quoting, pipelines, `$(...)`, `(...)` and `{...}` blocks, literal
 * strings run with `Invoke-Expression`), not the whole grammar: anything they cannot follow is
 * left as opaque text. The PowerShell tokenizer reads every character once (nested blocks are
 * tokenized where they are found), so its cost is linear in the input.
 */

/** PowerShell aliases (Windows PowerShell and pwsh) of the cmdlets the guard checks. */
const ALIASES: Record<string, string> = {
  rm: 'remove-item',
  del: 'remove-item',
  erase: 'remove-item',
  rd: 'remove-item',
  rmdir: 'remove-item',
  ri: 'remove-item',
  iwr: 'invoke-webrequest',
  wget: 'invoke-webrequest',
  curl: 'invoke-webrequest',
  irm: 'invoke-restmethod',
  iex: 'invoke-expression',
  icm: 'invoke-command',
  kill: 'stop-process',
  spps: 'stop-process',
  cp: 'copy-item',
  copy: 'copy-item',
  cpi: 'copy-item',
  mv: 'move-item',
  move: 'move-item',
  mi: 'move-item',
  ren: 'rename-item',
  rni: 'rename-item',
  ni: 'new-item',
  sc: 'set-content',
  ac: 'add-content',
  gc: 'get-content',
  cat: 'get-content',
  type: 'get-content',
  saps: 'start-process',
  start: 'start-process',
  sp: 'set-itemproperty',
  '%': 'foreach-object',
  foreach: 'foreach-object',
  echo: 'write-output',
  gci: 'get-childitem',
  ls: 'get-childitem',
  dir: 'get-childitem',
  gi: 'get-item'
}

interface PsToken {
  kind: 'word' | 'op' | 'redir'
  text: string
  quoted: boolean
  opaque: boolean
  /** Token lists of the blocks inside the word (`$(...)`, `(...)`, `{...}`, `@(...)`). */
  bodies?: PsToken[][]
}

/** Nested blocks tokenized before the rest of a block is skipped (and the input is truncated). */
const MAX_PS_NESTING = 32

const BREAKS = new Set([' ', '\t', '\r', '\n', ';', '|', ')', '}'])
const REDIRECT = /(\d|\*)?>>?(&\d)?/y

class PsLexer {
  pos = 0
  truncated = false

  constructor(private readonly src: string) {}

  /** Tokens until `close` at this level (consumed) or the end of the input. */
  tokens(close: string | null, depth: number): PsToken[] {
    const { src } = this
    const out: PsToken[] = []
    while (this.pos < src.length) {
      const ch = src[this.pos]
      const next = src[this.pos + 1]
      if (ch === ' ' || ch === '\t' || ch === '\r') {
        this.pos++
      } else if (ch === close) {
        this.pos++
        return out
      } else if (ch === ')' || ch === '}') {
        // A closer of no open block: ignored.
        this.pos++
      } else if (ch === '\n' || ch === ';') {
        out.push(op(';'))
        this.pos++
      } else if (ch === '<' && next === '#') {
        const end = src.indexOf('#>', this.pos + 2)
        this.pos = end < 0 ? src.length : end + 2
      } else if (ch === '#') {
        while (this.pos < src.length && src[this.pos] !== '\n') this.pos++
      } else if ((ch === '|' && next === '|') || (ch === '&' && next === '&')) {
        out.push(op(ch + next))
        this.pos += 2
      } else if (ch === '|') {
        out.push(op('|'))
        this.pos++
      } else if (ch === '>' || ((ch === '*' || (ch >= '0' && ch <= '9')) && next === '>')) {
        REDIRECT.lastIndex = this.pos
        const m = REDIRECT.exec(src) as RegExpExecArray
        out.push({ kind: 'redir', text: m[0], quoted: false, opaque: false })
        this.pos += m[0].length
      } else if (ch === '{' || ch === '(' || ((ch === '$' || ch === '@') && next === '(')) {
        out.push(this.block(depth))
      } else {
        out.push(this.word(depth))
      }
    }
    return out
  }

  /** `{...}`, `(...)`, `$(...)`, `@(...)` as one opaque word with its tokens. */
  private block(depth: number): PsToken {
    const start = this.pos
    const ch = this.src[this.pos]
    this.pos += ch === '$' || ch === '@' ? 2 : 1
    const close = ch === '{' ? '}' : ')'
    const body = this.inner(close, depth)
    return {
      kind: 'word',
      text: this.src.slice(start, this.pos),
      quoted: false,
      opaque: true,
      bodies: [body]
    }
  }

  /** Tokens of a nested block; past the nesting limit the block is skipped. */
  private inner(close: string, depth: number): PsToken[] {
    if (depth + 1 > MAX_PS_NESTING) {
      this.truncated = true
      this.skip(close)
      return []
    }
    return this.tokens(close, depth + 1)
  }

  /** Skips to the `close` of the current block with a stack (quotes and nesting followed). */
  private skip(close: string): void {
    const { src } = this
    const stack: string[] = [close]
    while (this.pos < src.length && stack.length) {
      const ch = src[this.pos]
      const top = stack[stack.length - 1]
      if (top === '"') {
        if (ch === '`') this.pos++
        else if (ch === '"') stack.pop()
        else if (ch === '$' && src[this.pos + 1] === '(') {
          stack.push(')')
          this.pos++
        }
      } else if (top === "'") {
        if (ch === "'") stack.pop()
      } else if (ch === '`') this.pos++
      else if (ch === '"' || ch === "'") stack.push(ch)
      else if (ch === '(') stack.push(')')
      else if (ch === '{') stack.push('}')
      else if (ch === top) stack.pop()
      this.pos++
    }
  }

  /** A word: runs until whitespace or an operator; quotes, escapes and glued blocks join it. */
  private word(depth: number): PsToken {
    const { src } = this
    let text = ''
    let quoted = false
    let opaque = false
    const bodies: PsToken[][] = []
    while (this.pos < src.length) {
      const c = src[this.pos]
      if (BREAKS.has(c)) break
      if (c === '>' && text === '') break
      if (c === "'") {
        this.pos++
        while (this.pos < src.length) {
          if (src[this.pos] === "'" && src[this.pos + 1] === "'") {
            text += "'"
            this.pos += 2
          } else if (src[this.pos] === "'") {
            this.pos++
            break
          } else text += src[this.pos++]
        }
        quoted = true
      } else if (c === '"') {
        this.pos++
        while (this.pos < src.length && src[this.pos] !== '"') {
          const d = src[this.pos]
          if (d === '`') {
            text += src[this.pos + 1] ?? ''
            this.pos += 2
          } else if (d === '$' && src[this.pos + 1] === '(') {
            const start = this.pos
            this.pos += 2
            bodies.push(this.inner(')', depth))
            text += src.slice(start, this.pos)
            opaque = true
          } else text += src[this.pos++]
        }
        this.pos++
        quoted = true
      } else if (c === '`') {
        text += src[this.pos + 1] ?? ''
        this.pos += 2
      } else if (c === ',') {
        // An array (`a, b`): one word; the targets split it again.
        text += ','
        this.pos++
        while (src[this.pos] === ' ' || src[this.pos] === '\t') this.pos++
      } else if (c === '$' && src[this.pos + 1] === '{') {
        const end = src.indexOf('}', this.pos)
        const stop = end < 0 ? src.length : end + 1
        text += src.slice(this.pos, stop)
        this.pos = stop
      } else if ((c === '$' && src[this.pos + 1] === '(') || (c === '(' && text !== '')) {
        // A subexpression, or a method call glued to a word: `[IO.File]::Delete(...)`.
        const start = this.pos
        this.pos += c === '$' ? 2 : 1
        bodies.push(this.inner(')', depth))
        text += src.slice(start, this.pos)
        opaque = true
      } else {
        text += c
        this.pos++
      }
    }
    return { kind: 'word', text, quoted, opaque, ...(bodies.length ? { bodies } : {}) }
  }
}

const op = (text: string): PsToken => ({ kind: 'op', text, quoted: false, opaque: false })

/** Canonical cmdlet name: lower case, aliases resolved, `.exe` dropped. */
export function psName(text: string): string {
  const lower = text.toLowerCase()
  if (ALIASES[lower]) return ALIASES[lower]
  if (/^[a-z]+-[a-z]+$/.test(lower)) return lower
  return cmdName(text)
}

const toArg = (t: PsToken): Arg => ({ text: t.text, quoted: t.quoted, opaque: t.opaque })

/** Parses PowerShell text into `state.cmds`. */
export function parsePowerShell(input: string, state: ParseState): void {
  const lexer = new PsLexer(input)
  const tokens = lexer.tokens(null, 0)
  if (lexer.truncated) state.truncated = true
  parseTokens(tokens, state)
}

/** `$name = value` (one word or three): the name and the value token. */
function assignment(
  list: PsToken[]
): { name: string; value: PsToken | null; rest: PsToken[] } | null {
  const head = list[0]
  if (!head || head.opaque) return null
  const glued = /^\$([\w:]+)\s*=(.*)$/s.exec(head.text)
  if (glued) {
    const value: PsToken | null = glued[2] ? { ...head, text: glued[2] } : (list[1] ?? null)
    return { name: glued[1].toLowerCase(), value, rest: list.slice(glued[2] ? 1 : 2) }
  }
  const name = /^\$([\w:]+)$/.exec(head.text)
  if (name && list[1]?.text === '=' && !list[1].quoted) {
    return { name: name[1].toLowerCase(), value: list[2] ?? null, rest: list.slice(3) }
  }
  return null
}

/** The literal text a token stands for (a string, or a variable holding one), or null. */
function literal(t: PsToken | undefined, state: ParseState): string | null {
  if (!t || t.opaque) return null
  const v = /^\$([\w:]+)$/.exec(t.text)
  if (v && !t.quoted) return state.psVars.get(v[1].toLowerCase()) ?? null
  return t.text
}

const STATIC_CALL =
  /^\[(?:system\.)?io\.(file|directory)\]::(delete|move|copy|replace|writeall\w*|appendall\w*|create\w*|appendtext|open\w*)\(/i
const SCRIPTBLOCK_CREATE = /^\[(?:system\.management\.automation\.)?scriptblock\]::create\(/i
const LISTERS = new Set(['get-childitem', 'get-item'])

function parseTokens(tokens: PsToken[], state: ParseState): void {
  let pipeline = state.nextPipeline++
  let words: PsToken[] = []
  let redirects: Cmd['redirects'] = []
  let redir: string | null = null
  let previous: Cmd | null = null
  const blocks: PsToken[][] = []

  const flush = (separator: string): void => {
    let list = words
    // Call operator and dot sourcing: `& "C:\x\tool.exe" args`.
    if (list[0] && !list[0].quoted && (list[0].text === '&' || list[0].text === '.'))
      list = list.slice(1)
    const assigned = assignment(list)
    if (assigned) {
      const value = assigned.value
      if (value && !value.opaque && assigned.rest.length === 0) {
        if (state.psVars.size < 64) state.psVars.set(assigned.name, value.text)
        list = []
      } else {
        // `$x = Remove-Item ...` runs the command on the right.
        list = value ? [value, ...assigned.rest] : []
      }
    }
    // `& $x args` where `$x` holds a command name.
    const held = list[0] && !list[0].quoted ? /^\$([\w:]+)$/.exec(list[0].text) : null
    const heldValue = held ? state.psVars.get(held[1].toLowerCase()) : undefined
    if (heldValue) {
      const replacement = new PsLexer(heldValue).tokens(null, MAX_PS_NESTING)
      list = [...replacement.filter((t) => t.kind === 'word'), ...list.slice(1)]
    }
    for (const t of list) for (const body of t.bodies ?? []) blocks.push(body)
    if (list.length || redirects.length) {
      const head = list[0]
      const args = list.slice(1).map(toArg)
      const raw = [
        ...list.map((t) => t.text),
        ...redirects.map((r) => `${r.op} ${r.target.text}`)
      ].join(' ')
      const name = head
        ? head.opaque && !head.quoted
          ? head.text.toLowerCase()
          : psName(head.text)
        : ''
      const cmd = push(state, { name, args, redirects, raw, pipeline, shell: 'powershell' })
      if (cmd) {
        fedListing(cmd, previous)
        special(cmd, list, previous, state)
      }
      followNative(name, args, state)
      previous = cmd
    }
    words = []
    redirects = []
    redir = null
    if (separator !== '|') {
      pipeline = state.nextPipeline++
      previous = null
    }
  }

  for (const token of tokens) {
    if (full(state)) {
      state.truncated = true
      return
    }
    if (token.kind === 'op') flush(token.text)
    else if (token.kind === 'redir') redir = token.text
    else if (redir !== null) {
      if (!/&\d$/.test(redir)) redirects.push({ op: redir, target: toArg(token) })
      for (const body of token.bodies ?? []) blocks.push(body)
      redir = null
    } else words.push(token)
  }
  flush('')
  for (const body of blocks) nested(state, 'substitution', () => parseTokens(body, state))
}

/** `Get-ChildItem C:\x -Recurse | Remove-Item`: the listing's folder is what goes. */
function fedListing(cmd: Cmd, previous: Cmd | null): void {
  if (cmd.name !== 'remove-item' || !previous || !LISTERS.has(previous.name)) return
  if ((deleteTargets(cmd)?.targets.length ?? 0) > 0) return
  const path =
    psValue(previous.args, 'path', 1) ??
    psValue(previous.args, 'literalpath', 1) ??
    psPositionals(previous.args, [
      'path',
      'literalpath',
      'filter',
      'include',
      'exclude',
      'depth'
    ])[0]
  const recurse = psParam(previous.args, 'recurse', 1) || psParam(cmd.args, 'recurse', 1)
  cmd.args = [
    ...cmd.args,
    { text: '-Path', quoted: false, opaque: false },
    path ?? { text: '.', quoted: false, opaque: false },
    ...(recurse ? [{ text: '-Recurse', quoted: false, opaque: false }] : [])
  ]
}

/** Invoke-Expression, `[scriptblock]::Create`, `[IO.File]::Delete`, Start-Process. */
function special(cmd: Cmd, list: PsToken[], previous: Cmd | null, state: ParseState): void {
  const ps = (text: string): void => nested(state, 'powershell', () => parsePowerShell(text, state))
  if (cmd.name === 'invoke-expression') {
    const named = list.findIndex(
      (t, i) => i > 0 && !t.quoted && /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(t.text)
    )
    const source = named > 0 ? list[named + 1] : list.find((t, i) => i > 0 && !/^-/.test(t.text))
    if (source) {
      const text = literal(source, state)
      if (text !== null) ps(text)
      else cmd.unknownScript = true
    } else if (
      previous &&
      previous.name === 'write-output' &&
      previous.args.every((a) => !a.opaque)
    ) {
      ps(previous.args.map((a) => a.text).join(' '))
    } else if (previous && !/^invoke-(webrequest|restmethod)$/.test(previous.name)) {
      cmd.unknownScript = true
    }
  }
  for (const t of list) {
    if (SCRIPTBLOCK_CREATE.test(t.text)) {
      for (const inner of t.bodies?.[0] ?? []) {
        const text = literal(inner, state)
        if (text !== null && inner.kind === 'word') ps(text)
        else if (inner.kind === 'word') cmd.unknownScript = true
      }
    }
    const call = STATIC_CALL.exec(t.text)
    if (call) staticCall(call[1].toLowerCase(), call[2].toLowerCase(), t, state)
  }
  if (cmd.name === 'start-process') startProcess(cmd, state)
}

/** `[IO.Directory]::Delete("C:\x", $true)` as the cmdlet that does the same. */
function staticCall(type: string, method: string, t: PsToken, state: ParseState): void {
  const values = (t.bodies?.[0] ?? [])
    .filter((x) => x.kind === 'word')
    .flatMap((x) => x.text.split(','))
    .filter(Boolean)
  const path = (text: string | undefined): Arg[] =>
    text === undefined
      ? []
      : [
          { text: '-Path', quoted: false, opaque: false },
          { text, quoted: true, opaque: false }
        ]
  const add = (name: string, args: Arg[]): void => {
    push(state, {
      name,
      args,
      redirects: [],
      raw: t.text,
      pipeline: state.nextPipeline++,
      shell: 'powershell'
    })
  }
  if (method === 'delete') {
    const recurse = type === 'directory' && /^\$true$/i.test(values[1] ?? '')
    add('remove-item', [
      ...path(values[0]),
      ...(recurse ? [{ text: '-Recurse', quoted: false, opaque: false }] : [])
    ])
  } else if (method === 'move') {
    add('move-item', [
      ...path(values[0]),
      { text: '-Destination', quoted: false, opaque: false },
      { text: values[1] ?? '', quoted: true, opaque: false }
    ])
  } else if (method === 'copy' || method === 'replace') {
    add('set-content', path(values[1]))
  } else {
    add('set-content', path(values[0]))
  }
}

/** `Start-Process cmd -ArgumentList "/c ..."`: the program and its arguments. */
function startProcess(cmd: Cmd, state: ParseState): void {
  const file =
    psValue(cmd.args, 'filepath', 1) ??
    psPositionals(cmd.args, [
      'filepath',
      'argumentlist',
      'args',
      'verb',
      'workingdirectory',
      'windowstyle',
      'redirectstandardoutput',
      'redirectstandarderror',
      'redirectstandardinput'
    ])[0]
  if (!file || file.opaque) return
  const list = psValue(cmd.args, 'argumentlist', 1) ?? psValue(cmd.args, 'args', 2)
  const words = (list?.text ?? '')
    .split(',')
    .flatMap((part) => part.trim().split(/\s+/))
    .filter(Boolean)
    .map((text) => ({ text, quoted: false, opaque: false }))
  const name = cmdName(file.text)
  // `-UseNewEnvironment` starts the program without the tab's variables.
  const fresh = psParam(cmd.args, 'usenewenvironment', 2)
  nested(state, 'process', () => {
    push(state, {
      name,
      args: words,
      redirects: [],
      raw: cmd.raw,
      pipeline: state.nextPipeline++,
      shell: 'cmd',
      ...(fresh ? { env: { set: [], unset: ['*'] } } : {})
    })
    followNative(name, words, state)
  })
}

/** Native programs started from PowerShell that wrap another command line. */
function followNative(name: string, args: Arg[], state: ParseState): void {
  const texts = args.map((a) => a.text)
  // `npx @anthropic-ai/claude-code ...`, `node .../claude-code/cli.js ...`.
  const words = [name, ...texts].map((text) => ({
    text,
    quoted: false,
    opaque: false,
    assignable: false
  }))
  const runs = packageRunner(name, words) ?? claudeScript(name, words)
  if (runs?.length) {
    const inner = cmdName(runs[0].text)
    nested(state, 'runner', () => {
      push(state, {
        name: inner,
        args: runs.slice(1).map((w) => ({ text: w.text, quoted: false, opaque: false })),
        redirects: [],
        raw: [name, ...texts].join(' '),
        pipeline: state.nextPipeline++,
        shell: 'cmd'
      })
    })
  }
  if (name === 'cmd') {
    const script = cmdScript(texts)
    if (script) nested(state, 'cmd', () => parseCmd(script, state))
  } else if (name === 'powershell' || name === 'pwsh') {
    const script = powershellScript(texts)
    if (script) nested(state, 'powershell', () => parsePowerShell(script, state))
  } else if (['bash', 'sh', 'wsl'].includes(name)) {
    const c = texts.findIndex((t) => t === '-c' || t === '-lc' || t === '--')
    if (c >= 0 && texts[c + 1])
      nested(state, 'shell', () => parsePosix(texts.slice(c + 1).join(' '), state))
  }
}

/** cmd.exe built-ins and the names they are checked as (with `/s` and `/q` kept as flags). */
const CMD_NAMES: Record<string, string> = {
  rd: 'rd',
  rmdir: 'rd',
  del: 'del',
  erase: 'del',
  copy: 'copy',
  move: 'move',
  type: 'type'
}

/** Parses cmd.exe text (`cmd /c ...`) into `state.cmds`. */
export function parseCmd(input: string, state: ParseState): void {
  const parts: string[] = []
  let current = ''
  let quoted = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '"') quoted = !quoted
    if (!quoted && (ch === '&' || ch === '|' || ch === '\n')) {
      parts.push(current)
      current = ''
      if (input[i + 1] === ch) i++
      continue
    }
    if (!quoted && ch === '^') {
      current += input[++i] ?? ''
      continue
    }
    current += ch
  }
  parts.push(current)
  for (const part of parts) {
    const redirects: Cmd['redirects'] = []
    const words: Arg[] = []
    const re = /(\d?>>?)\s*("[^"]*"|\S+)|"([^"]*)"|(\S+)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(part))) {
      if (m[1]) {
        const target = m[2].replace(/^"|"$/g, '')
        if (!/^&\d$/.test(target))
          redirects.push({
            op: m[1].replace(/^\d/, ''),
            target: { text: target, quoted: false, opaque: false }
          })
      } else if (m[3] !== undefined) words.push({ text: m[3], quoted: true, opaque: false })
      else words.push({ text: m[4], quoted: false, opaque: false })
    }
    if (!words.length && !redirects.length) continue
    const head = words[0]?.text.toLowerCase() ?? ''
    const name = CMD_NAMES[head] ?? (head ? cmdName(head) : '')
    const args = words.slice(1)
    push(state, {
      name,
      args,
      redirects,
      raw: part.trim(),
      pipeline: state.nextPipeline++,
      shell: 'cmd'
    })
    followNative(name, args, state)
  }
}

/** Every command of a PowerShell tool call. */
export function parsePowerShellLine(input: string, ctx: ParseContext): ParseState {
  const state = newState(ctx)
  parsePowerShell(input, state)
  return state
}
