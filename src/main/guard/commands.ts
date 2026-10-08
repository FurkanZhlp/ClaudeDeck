import { commandName } from '../shell/normalize'
import { lex, substitutionBodies, type Segment, type Word } from '../shell/shellLexer'
import { resolvePath, type PathEnv } from './paths'

/**
 * The guard's view of a command line: every simple command it would run, with wrappers
 * (`sudo`, `env`, `xargs`, `bash -c`, `npx`, `docker exec`, ...) peeled off and substitutions
 * (`$(...)`, `<(...)`, backticks) looked into. Wrappers stay in the list too, so a detector can
 * look at `sudo` or `xargs` itself. Nothing is executed.
 */

export type ShellKind = 'posix' | 'powershell' | 'cmd'

export interface Arg {
  text: string
  quoted: boolean
  /** Holds a substitution: the value is unknown. */
  opaque: boolean
}

export interface Cmd {
  /** Lower case basename without `.exe`/`.cmd`; '' for a redirection-only segment. */
  name: string
  args: Arg[]
  /** Output and input redirections (`>`, `>>`, `<`, ...). */
  redirects: { op: string; target: Arg }[]
  /** Source text of the segment the command came from (for log excerpts). */
  raw: string
  /** Commands joined by `|` share a pipeline id. */
  pipeline: number
  /** Working folder for this command (after `cd` in the same line); null when unknown. */
  cwd: string | null
  shell: ShellKind
  /** Wrappers the command was found under, outermost first (`sudo`, `xargs`, `shell`, ...). */
  via: string[]
  /** Roots of the `find` feeding this command (`find / ... | xargs rm`, `find ~ -exec rm`). */
  findRoots?: Arg[]
  /** The `find` feeding this command filters by name, path, type, age or size. */
  findFiltered?: boolean
}

export interface ParseContext extends PathEnv {
  /** Parses PowerShell text (`pwsh -c`, `powershell -EncodedCommand`); injected to avoid a cycle. */
  powershell?: (text: string, state: ParseState) => void
  /** Parses cmd.exe text (`cmd /c`). */
  cmd?: (text: string, state: ParseState) => void
}

export interface ParseState {
  ctx: ParseContext
  cmds: Cmd[]
  nextPipeline: number
  depth: number
  via: string[]
  cwd: string | null
  /** Set when the input could not be fully followed (nesting or size limits). */
  truncated: boolean
}

/** Nested shells, substitutions and wrappers followed before giving up. */
export const MAX_DEPTH = 6
/** Commands collected per input. */
export const MAX_COMMANDS = 1000

export const arg = (w: Word): Arg => ({ text: w.text, quoted: w.quoted, opaque: w.opaque })

/** Lower case command name; Windows launcher suffixes dropped. */
export const cmdName = (text: string): string => commandName(text).toLowerCase()

export const isFlag = (a: Arg | undefined): boolean =>
  !!a && a.text.startsWith('-') && a.text !== '-' && !a.opaque

/** Positional arguments: flags dropped (and the values of `valueFlags`), `--` ends flags. */
export function positionals(args: Arg[], valueFlags: ReadonlySet<string> = EMPTY): Arg[] {
  const out: Arg[] = []
  let flags = true
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (flags && a.text === '--') {
      flags = false
      continue
    }
    if (flags && isFlag(a)) {
      if (!a.text.includes('=') && valueFlags.has(a.text)) i++
      continue
    }
    out.push(a)
  }
  return out
}

const EMPTY: ReadonlySet<string> = new Set()
const set = (...items: string[]): ReadonlySet<string> => new Set(items)

/** A short option cluster (`-rf`) or a long option contains `letter` / `long`. */
export function hasFlag(args: Arg[], short: string, ...long: string[]): boolean {
  for (const a of args) {
    if (a.text === '--') return false
    if (a.opaque || !a.text.startsWith('-')) continue
    if (a.text.startsWith('--')) {
      const name = a.text.split('=')[0]
      if (long.includes(name)) return true
    } else if (
      short &&
      /^-[A-Za-z0-9]+$/.test(a.text) &&
      short.split('').some((c) => a.text.includes(c))
    ) {
      return true
    }
  }
  return false
}

export const newState = (ctx: ParseContext): ParseState => ({
  ctx,
  cmds: [],
  nextPipeline: 0,
  depth: 0,
  via: [],
  cwd: ctx.cwd,
  truncated: false
})

/** Runs `fn` one level deeper with an extra wrapper name; stops at MAX_DEPTH. */
export function nested(state: ParseState, via: string, fn: () => void): void {
  if (state.depth >= MAX_DEPTH) {
    state.truncated = true
    return
  }
  const { via: before, cwd } = state
  state.depth++
  state.via = [...before, via]
  try {
    fn()
  } finally {
    state.depth--
    state.via = before
    state.cwd = cwd
  }
}

export function push(
  state: ParseState,
  cmd: Omit<Cmd, 'via' | 'cwd'> & { cwd?: string | null }
): void {
  if (state.cmds.length >= MAX_COMMANDS) {
    state.truncated = true
    return
  }
  state.cmds.push({ ...cmd, cwd: cmd.cwd === undefined ? state.cwd : cmd.cwd, via: state.via })
}

/* Wrappers ------------------------------------------------------------------------------------ */

/** Option flags that take the next word as their value, per wrapper. */
const WRAPPER_FLAGS: Record<string, ReadonlySet<string>> = {
  sudo: set('-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T', '--user', '--group'),
  doas: set('-u', '-C'),
  env: set('-u', '--unset', '-C', '--chdir', '-S', '--split-string'),
  nice: set('-n', '--adjustment'),
  ionice: set('-c', '-n', '-p', '-t'),
  timeout: set('-s', '--signal', '-k', '--kill-after'),
  stdbuf: set('-i', '-o', '-e'),
  time: set('-f', '--format', '-o', '--output'),
  exec: set('-a'),
  xargs: set(
    '-I',
    '-i',
    '-n',
    '-P',
    '-L',
    '-l',
    '-d',
    '-E',
    '-e',
    '-s',
    '-a',
    '--arg-file',
    '--delimiter',
    '--max-args',
    '--max-procs',
    '--replace'
  ),
  npx: set('-p', '--package', '-c', '--call', '--node-options', '--from', '--with', '--python'),
  dockerExec: set(
    '-e',
    '--env',
    '-u',
    '--user',
    '-w',
    '--workdir',
    '--env-file',
    '--detach-keys',
    '--index'
  ),
  kubectl: set(
    '-n',
    '--namespace',
    '-c',
    '--container',
    '--context',
    '--kubeconfig',
    '-f',
    '--filename'
  ),
  shell: set('-o', '-O', '+o', '+O', '--rcfile', '--init-file')
}

const SIMPLE_WRAPPERS = set(
  'nohup',
  'command',
  'builtin',
  'exec',
  'nice',
  'ionice',
  'stdbuf',
  'time',
  'caffeinate',
  'chronic',
  'unbuffer',
  'env',
  'timeout',
  'sudo',
  'doas',
  'pkexec',
  'run0',
  'gsudo',
  'xargs'
)
const SHELLS = set('bash', 'sh', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'ash', 'busybox')
const POWERSHELLS = set('powershell', 'pwsh')
const NPX_LIKE = set('npx', 'pnpx', 'bunx', 'uvx')
const PACKAGE_MANAGERS = set('npm', 'pnpm', 'yarn', 'bun')
/** Tools the guard knows that are often run through a package manager (`pnpm prisma ...`). */
const PM_BINARIES = set(
  'prisma',
  'vercel',
  'netlify',
  'wrangler',
  'firebase',
  'supabase',
  'sequelize',
  'sequelize-cli',
  'typeorm',
  'knex',
  'drizzle-kit',
  'changeset',
  'lerna',
  'semantic-release',
  'vsce',
  'ovsx',
  'jsr',
  'cdk',
  'serverless',
  'sls',
  'rimraf'
)
const PM_FLAGS = set('-C', '--dir', '--filter', '-F', '--prefix', '-w', '--workspace', '--cwd')

/** Index of the first word after leading flags (and their values). */
function afterFlags(words: Word[], from: number, valueFlags: ReadonlySet<string>): number {
  let i = from
  while (i < words.length && words[i].text.startsWith('-') && words[i].text !== '-') {
    const text = words[i].text
    i++
    if (text === '--') break
    if (!text.includes('=') && valueFlags.has(text)) i++
  }
  return i
}

/** The words a wrapper runs, or null when `name` is not a wrapper there. */
function innerWords(name: string, words: Word[]): Word[] | null {
  switch (name) {
    case 'nohup':
    case 'builtin':
    case 'caffeinate':
    case 'chronic':
    case 'unbuffer':
    case 'pkexec':
    case 'run0':
    case 'gsudo':
      return words.slice(afterFlags(words, 1, EMPTY))
    case 'command': {
      const flag = words[1]?.text
      if (flag === '-v' || flag === '-V') return []
      return words.slice(afterFlags(words, 1, EMPTY))
    }
    case 'timeout': {
      const rest = words.slice(afterFlags(words, 1, WRAPPER_FLAGS.timeout))
      return rest.slice(1)
    }
    case 'env': {
      let i = afterFlags(words, 1, WRAPPER_FLAGS.env)
      while (i < words.length && words[i].assignable) i++
      return words.slice(i)
    }
    case 'xargs':
    case 'sudo':
    case 'doas':
    case 'nice':
    case 'ionice':
    case 'stdbuf':
    case 'time':
    case 'exec':
      return words.slice(afterFlags(words, 1, WRAPPER_FLAGS[name] ?? EMPTY))
  }
  return null
}

/** `bash -lc 'script'`: the script, or null when there is no `-c`. */
function shellScript(words: Word[]): Word | null {
  let hasC = false
  let i = 1
  if (cmdName(words[0].text) === 'busybox') i = 2
  for (; i < words.length && /^[-+]/.test(words[i].text) && words[i].text !== '--'; i++) {
    const text = words[i].text
    if (WRAPPER_FLAGS.shell.has(text)) i++
    else if (/^-[a-zA-Z]+$/.test(text) && text.includes('c')) hasC = true
  }
  if (words[i]?.text === '--') i++
  return hasC ? (words[i] ?? null) : null
}

/** `powershell -Command ...` / `-EncodedCommand b64` / a bare script text. */
export function powershellScript(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const flag = args[i].toLowerCase().replace(/^\//, '-')
    if (/^-(e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)$/.test(flag)) {
      try {
        return Buffer.from(args[i + 1] ?? '', 'base64').toString('utf16le')
      } catch {
        return null
      }
    }
    if (/^-(c|co|com|comm|comma|comman|command)$/.test(flag)) return args.slice(i + 1).join(' ')
    if (/^-(f|file)$/.test(flag)) return null
    if (flag.startsWith('-')) {
      if (
        /^-(executionpolicy|ep|ex|exe|windowstyle|w|configurationname|workingdirectory|wd|outputformat|of|inputformat|if|settingsfile|version|v|psconsolefile)$/.test(
          flag
        )
      )
        i++
      continue
    }
    return args.slice(i).join(' ')
  }
  return null
}

/** `cmd /c dir`, `cmd //c dir` (Git Bash), `cmd /k`: the text after the switch. */
export function cmdScript(args: string[]): string | null {
  const i = args.findIndex((a) => /^\/\/?[ck]$/i.test(a) || /^\/[ck]\S/i.test(a))
  if (i < 0) return null
  const first = args[i].replace(/^\/\/?[ck]/i, '')
  return [first, ...args.slice(i + 1)].filter(Boolean).join(' ')
}

/** `docker exec [opts] CONTAINER cmd`, `docker compose exec SVC cmd`, `kubectl exec POD -- cmd`. */
function containerInner(name: string, words: Word[]): Word[] | null {
  if (name === 'docker' || name === 'podman' || name === 'nerdctl') {
    let i = afterFlags(
      words,
      1,
      set('--context', '-H', '--host', '--config', '-c', '-l', '--log-level')
    )
    if (words[i]?.text === 'compose')
      i = afterFlags(
        words,
        i + 1,
        set(
          '-f',
          '--file',
          '-p',
          '--project-name',
          '--profile',
          '--env-file',
          '--project-directory'
        )
      )
    if (words[i]?.text === 'container') i++
    const sub = words[i]?.text
    if (sub !== 'exec' && sub !== 'run') return null
    const start = afterFlags(words, i + 1, sub === 'exec' ? WRAPPER_FLAGS.dockerExec : RUN_FLAGS)
    return start + 1 < words.length ? words.slice(start + 1) : null
  }
  if (name === 'docker-compose') {
    const i = afterFlags(
      words,
      1,
      set('-f', '--file', '-p', '--project-name', '--profile', '--env-file')
    )
    const sub = words[i]?.text
    if (sub !== 'exec' && sub !== 'run') return null
    const start = afterFlags(words, i + 1, WRAPPER_FLAGS.dockerExec)
    return start + 1 < words.length ? words.slice(start + 1) : null
  }
  if (name === 'kubectl' || name === 'oc') {
    const dashes = words.findIndex((w) => w.text === '--')
    if (!words.some((w) => w.text === 'exec') || dashes < 0) return null
    return words.slice(dashes + 1)
  }
  return null
}

const RUN_FLAGS = set(
  '-e',
  '--env',
  '-u',
  '--user',
  '-w',
  '--workdir',
  '--env-file',
  '-v',
  '--volume',
  '-p',
  '--publish',
  '--name',
  '--network',
  '--net',
  '--entrypoint',
  '-m',
  '--memory',
  '--mount',
  '--platform',
  '-l',
  '--label',
  '--hostname',
  '-h',
  '--cpus',
  '--restart',
  '--add-host'
)

/** `npx foo`, `pnpm exec foo`, `pnpm dlx foo`, `bun x foo`, `pnpm prisma ...`. */
function packageRunner(name: string, words: Word[]): Word[] | null {
  if (NPX_LIKE.has(name)) {
    const rest = words.slice(afterFlags(words, 1, WRAPPER_FLAGS.npx))
    return rest.length ? [withoutVersion(rest[0]), ...rest.slice(1)] : null
  }
  if (!PACKAGE_MANAGERS.has(name)) return null
  const i = afterFlags(words, 1, PM_FLAGS)
  const sub = words[i]?.text
  if (sub === 'exec' || sub === 'dlx' || (name === 'bun' && sub === 'x')) {
    const rest = words.slice(afterFlags(words, i + 1, WRAPPER_FLAGS.npx))
    return rest.length ? [withoutVersion(rest[0]), ...rest.slice(1)] : null
  }
  if (sub && PM_BINARIES.has(cmdName(sub))) return words.slice(i)
  return null
}

function withoutVersion(w: Word): Word {
  const at = w.text.lastIndexOf('@')
  return at > 0 ? { ...w, text: w.text.slice(0, at) } : w
}

/** `python -m module args` → module args. */
function pythonModule(words: Word[]): Word[] | null {
  for (let i = 1; i < words.length; i++) {
    const text = words[i].text
    if (text === '-m') return words.slice(i + 1)
    if (text === '-c' || !text.startsWith('-')) return null
  }
  return null
}

/** The `-exec cmd ... ;` parts of a find command. */
function findExecs(words: Word[]): Word[][] {
  const out: Word[][] = []
  for (let i = 1; i < words.length; i++) {
    if (!/^-(exec|execdir|ok|okdir)$/.test(words[i].text)) continue
    const start = i + 1
    let end = start
    while (end < words.length && words[end].text !== ';' && words[end].text !== '+') end++
    out.push(words.slice(start, end))
    i = end
  }
  return out
}

const FIND_FILTERS =
  /^-(i?name|i?path|i?wholename|i?regex|type|newer\w*|[amc](time|min)|size|empty|user|group|perm|links|inum|samefile)$/

/** Start folders of a find command and whether it filters what it finds. */
export function findInfo(args: Arg[]): { roots: Arg[]; filtered: boolean } {
  const roots: Arg[] = []
  let i = 0
  while (i < args.length && /^-[HLP]$/.test(args[i].text)) i++
  for (; i < args.length; i++) {
    const t = args[i].text
    if (t.startsWith('-') || t === '(' || t === '!') break
    roots.push(args[i])
  }
  return { roots, filtered: args.some((a) => FIND_FILTERS.test(a.text)) }
}

/* Parsing ------------------------------------------------------------------------------------- */

/** Parses a POSIX shell command line into `state.cmds`. */
export function parsePosix(input: string, state: ParseState): void {
  const segments = lex(input)
  let pipeline = state.nextPipeline++
  let feeder: Cmd | null = null
  for (const segment of segments) {
    addSegment(segment, state, pipeline, feeder)
    const last = state.cmds[state.cmds.length - 1]
    if (segment.op === '|' || segment.op === '|&') {
      feeder = last ?? null
    } else {
      feeder = null
      pipeline = state.nextPipeline++
    }
  }
}

function addSegment(
  segment: Segment,
  state: ParseState,
  pipeline: number,
  feeder: Cmd | null
): void {
  const redirects = segment.redirects.map((r) => ({ op: r.op, target: arg(r.target) }))
  let words = segment.words
  let i = 0
  while (i < words.length && words[i].assignable) followSubstitutions(words[i++], state)
  words = words.slice(i)
  if (!words.length) {
    if (redirects.length) {
      push(state, { name: '', args: [], redirects, raw: segment.raw, pipeline, shell: 'posix' })
    }
    return
  }
  const fromFind = feeder?.name === 'find' ? findInfo(feeder.args) : null
  addWords(words, state, { raw: segment.raw, pipeline, redirects, fromFind })
  // `cd` changes the folder for the commands after it on the same line.
  const name = cmdName(words[0].text)
  if (name === 'cd' || name === 'pushd') {
    const target = words.slice(1).find((w) => !w.text.startsWith('-'))
    if (!target) state.cwd = state.ctx.home
    else if (target.opaque || target.text === '-') state.cwd = null
    else state.cwd = resolvePath(target.text, { ...state.ctx, cwd: state.cwd })
  }
}

interface SegmentInfo {
  raw: string
  pipeline: number
  redirects: Cmd['redirects']
  fromFind: { roots: Arg[]; filtered: boolean } | null
}

/** Adds the command, then whatever it wraps, then its substitutions. */
function addWords(words: Word[], state: ParseState, info: SegmentInfo): void {
  const head = words[0]
  const name = head.opaque ? head.text.toLowerCase() : cmdName(head.text)
  const args = words.slice(1).map(arg)
  const viaXargs = state.via[state.via.length - 1] === 'xargs'
  push(state, {
    name,
    args,
    redirects: info.redirects,
    raw: info.raw,
    pipeline: info.pipeline,
    shell: 'posix',
    ...(info.fromFind && (viaXargs || name === 'xargs')
      ? { findRoots: info.fromFind.roots, findFiltered: info.fromFind.filtered }
      : {})
  })
  for (const w of words) followSubstitutions(w, state)
  for (const r of info.redirects) if (r.target.opaque) followText(r.target.text, state)

  const inner = (via: string, next: Word[] | null, keepFind = false): boolean => {
    if (!next) return false
    if (!next.length) return true
    let k = 0
    while (k < next.length && next[k].assignable) k++
    if (k >= next.length) return true
    nested(state, via, () =>
      addWords(next.slice(k), state, {
        ...info,
        redirects: [],
        fromFind: keepFind ? info.fromFind : null
      })
    )
    return true
  }

  if (SIMPLE_WRAPPERS.has(name)) {
    inner(name, innerWords(name, words), name === 'xargs' || viaXargs)
    return
  }
  if (name === 'eval' || name === 'source' || name === '.') {
    if (name === 'eval')
      nested(state, 'shell', () => parsePosix(args.map((a) => a.text).join(' '), state))
    return
  }
  if (SHELLS.has(name)) {
    const script = shellScript(words)
    if (script) nested(state, 'shell', () => parsePosix(script.text, state))
    return
  }
  if (POWERSHELLS.has(name)) {
    const script = powershellScript(args.map((a) => a.text))
    const ps = state.ctx.powershell
    if (script && ps) nested(state, 'powershell', () => ps(script, state))
    return
  }
  if (name === 'cmd') {
    const script = cmdScript(args.map((a) => a.text))
    const cmd = state.ctx.cmd
    if (script && cmd) nested(state, 'cmd', () => cmd(script, state))
    return
  }
  if (name === 'find') {
    const { roots, filtered } = findInfo(args)
    for (const exec of findExecs(words)) {
      if (!exec.length) continue
      nested(state, 'find', () =>
        addWords(exec, state, { ...info, redirects: [], fromFind: { roots, filtered } })
      )
      const added = state.cmds[state.cmds.length - 1]
      if (added && added.via[added.via.length - 1] === 'find') {
        added.findRoots = roots
        added.findFiltered = filtered
      }
    }
    return
  }
  if (name === 'bundle' && words[1]?.text === 'exec') {
    inner('runner', words.slice(2))
    return
  }
  if (/^python[\d.]*$/.test(name)) {
    inner('python', pythonModule(words))
    return
  }
  if (inner('container', containerInner(name, words))) return
  inner('runner', packageRunner(name, words))
}

/** Parses the commands inside the substitutions of an opaque word. */
function followSubstitutions(w: Word, state: ParseState): void {
  if (w.opaque) followText(w.text, state)
}

function followText(text: string, state: ParseState): void {
  for (const body of substitutionBodies(text)) {
    nested(state, 'substitution', () => parsePosix(body, state))
  }
}

/** Every command of a POSIX command line (Bash, Monitor). */
export function parseCommandLine(input: string, ctx: ParseContext): ParseState {
  const state = newState(ctx)
  parsePosix(input, state)
  return state
}
