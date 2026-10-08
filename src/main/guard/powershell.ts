import {
  cmdName,
  cmdScript,
  nested,
  newState,
  parsePosix,
  powershellScript,
  push,
  type Arg,
  type Cmd,
  type ParseContext,
  type ParseState
} from './commands'

/**
 * Small tokenizers for PowerShell and cmd.exe. They cover the common forms (cmdlets and their
 * aliases, parameters, quoting, pipelines, `$(...)`, `(...)` and `{...}` blocks), not the whole
 * grammar: anything they cannot follow is left as opaque text.
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
  echo: 'write-output'
}

interface PsToken {
  kind: 'word' | 'op' | 'redir'
  text: string
  quoted: boolean
  opaque: boolean
}

/** Inner texts of `$(...)`, `@(...)`, `(...)` and `{...}` found while reading words. */
type Bodies = string[]

function readBlock(src: string, start: number, open: string, close: string): number {
  let depth = 0
  let i = start
  while (i < src.length) {
    const ch = src[i]
    if (ch === "'") {
      i = skipSingle(src, i)
      continue
    }
    if (ch === '"') {
      i = skipDouble(src, i)
      continue
    }
    if (ch === '`') {
      i += 2
      continue
    }
    if (ch === open) depth++
    else if (ch === close && --depth === 0) return i + 1
    i++
  }
  return src.length
}

function skipSingle(src: string, i: number): number {
  let j = i + 1
  while (j < src.length) {
    if (src[j] === "'" && src[j + 1] === "'") j += 2
    else if (src[j] === "'") return j + 1
    else j++
  }
  return src.length
}

function skipDouble(src: string, i: number): number {
  let j = i + 1
  while (j < src.length && src[j] !== '"') j += src[j] === '`' ? 2 : 1
  return Math.min(j + 1, src.length)
}

function tokenizePs(src: string, bodies: Bodies): PsToken[] {
  const tokens: PsToken[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++
    } else if (ch === '\n' || ch === ';') {
      tokens.push({ kind: 'op', text: ';', quoted: false, opaque: false })
      i++
    } else if (ch === '<' && next === '#') {
      const end = src.indexOf('#>', i + 2)
      i = end < 0 ? src.length : end + 2
    } else if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i++
    } else if ((ch === '|' && next === '|') || (ch === '&' && next === '&')) {
      tokens.push({ kind: 'op', text: ch + next, quoted: false, opaque: false })
      i += 2
    } else if (ch === '|') {
      tokens.push({ kind: 'op', text: '|', quoted: false, opaque: false })
      i++
    } else if (ch === '>' || (/[\d*]/.test(ch) && next === '>')) {
      const m = /^(\d|\*)?>>?(&\d)?/.exec(src.slice(i)) as RegExpExecArray
      tokens.push({ kind: 'redir', text: m[0], quoted: false, opaque: false })
      i += m[0].length
    } else if (
      ch === '{' ||
      ch === '(' ||
      (ch === '$' && next === '(') ||
      (ch === '@' && next === '(')
    ) {
      const open = ch === '{' ? '{' : '('
      const close = ch === '{' ? '}' : ')'
      const from = ch === '$' || ch === '@' ? i + 1 : i
      const end = readBlock(src, from, open, close)
      const body = src.slice(from + 1, src[end - 1] === close ? end - 1 : end)
      bodies.push(body)
      tokens.push({ kind: 'word', text: src.slice(i, end), quoted: false, opaque: true })
      i = end
    } else {
      // A word: runs until whitespace or an operator; quotes and backtick escapes join it.
      let text = ''
      let quoted = false
      let opaque = false
      while (i < src.length) {
        const c = src[i]
        if (' \t\r\n;|'.includes(c)) break
        if (c === '>' && text === '') break
        if (c === "'") {
          const end = skipSingle(src, i)
          text += src.slice(i + 1, src[end - 1] === "'" ? end - 1 : end).replace(/''/g, "'")
          quoted = true
          i = end
        } else if (c === '"') {
          const end = skipDouble(src, i)
          const inner = src.slice(i + 1, src[end - 1] === '"' ? end - 1 : end)
          for (let k = inner.indexOf('$('); k >= 0; k = inner.indexOf('$(', k + 2)) {
            const stop = readBlock(inner, k + 1, '(', ')')
            bodies.push(inner.slice(k + 2, Math.max(k + 2, stop - 1)))
            opaque = true
          }
          text += inner.replace(/`(.)/g, '$1')
          quoted = true
          i = end
        } else if (c === '`') {
          text += src[i + 1] ?? ''
          i += 2
        } else if (c === '$' && src[i + 1] === '(') {
          const end = readBlock(src, i + 1, '(', ')')
          bodies.push(src.slice(i + 2, Math.max(i + 2, end - 1)))
          text += src.slice(i, end)
          opaque = true
          i = end
        } else if (c === '(' && text !== '') {
          // Method call or grouping glued to a word: `(New-Object Net.WebClient).DownloadString(...)`.
          const end = readBlock(src, i, '(', ')')
          bodies.push(src.slice(i + 1, Math.max(i + 1, end - 1)))
          text += src.slice(i, end)
          opaque = true
          i = end
        } else {
          text += c
          i++
        }
      }
      tokens.push({ kind: 'word', text, quoted, opaque })
    }
  }
  return tokens
}

/** Canonical cmdlet name: lower case, aliases resolved, `.exe` dropped. */
export function psName(text: string): string {
  const lower = text.toLowerCase()
  if (ALIASES[lower]) return ALIASES[lower]
  if (/^[a-z]+-[a-z]+$/.test(lower)) return lower
  return cmdName(text)
}

/** Parses PowerShell text into `state.cmds`. */
export function parsePowerShell(input: string, state: ParseState): void {
  const bodies: Bodies = []
  const tokens = tokenizePs(input, bodies)
  let pipeline = state.nextPipeline++
  let words: PsToken[] = []
  let redirects: Cmd['redirects'] = []
  let redir: string | null = null

  const flush = (op: string): void => {
    let list = words
    // Call operator and dot sourcing: `& "C:\x\tool.exe" args`.
    if (list[0] && !list[0].quoted && (list[0].text === '&' || list[0].text === '.'))
      list = list.slice(1)
    if (list.length || redirects.length) {
      const head = list[0]
      const args: Arg[] = list
        .slice(1)
        .map((t) => ({ text: t.text, quoted: t.quoted, opaque: t.opaque }))
      const raw = [
        ...list.map((t) => t.text),
        ...redirects.map((r) => `${r.op} ${r.target.text}`)
      ].join(' ')
      const name = head
        ? head.opaque && !head.quoted
          ? head.text.toLowerCase()
          : psName(head.text)
        : ''
      push(state, { name, args, redirects, raw, pipeline, shell: 'powershell' })
      followNative(name, args, state)
    }
    words = []
    redirects = []
    redir = null
    if (op !== '|') pipeline = state.nextPipeline++
  }

  for (const token of tokens) {
    if (token.kind === 'op') flush(token.text)
    else if (token.kind === 'redir') redir = token.text
    else if (redir !== null) {
      if (!/&\d$/.test(redir))
        redirects.push({
          op: redir,
          target: { text: token.text, quoted: token.quoted, opaque: token.opaque }
        })
      redir = null
    } else words.push(token)
  }
  flush('')
  for (const body of bodies) nested(state, 'substitution', () => parsePowerShell(body, state))
}

/** Native programs started from PowerShell that wrap another command line. */
function followNative(name: string, args: Arg[], state: ParseState): void {
  const texts = args.map((a) => a.text)
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
