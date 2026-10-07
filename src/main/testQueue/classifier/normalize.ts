import { lex, type Segment, type Word } from './shellLexer'

/**
 * Turns a simple command into its canonical form: assignments, wrappers, package manager flags
 * and monorepo runner syntax are stripped so that `CI=1 pnpm -C web exec vitest run` and
 * `vitest run` look the same to the pattern matcher.
 */

export interface Canonical {
  words: Word[]
  /** Source text of the segment the words came from. */
  raw: string
}

/** `bash -c '...'` levels followed; deeper scripts are ignored. */
export const MAX_SHELL_DEPTH = 2
/** Wrapper rounds per segment (protects against pathological input). */
const MAX_ROUNDS = 32

const set = (...items: string[]): ReadonlySet<string> => new Set(items)

/** Shell keywords that may precede a command in the same segment. */
const KEYWORDS = set('!', '{', '}', 'then', 'do', 'else', 'elif', 'if', 'while', 'until')
/** Commands that never run tests themselves; the segment is ignored. */
const SKIPPED = set(
  'cd',
  'pushd',
  'popd',
  'export',
  'set',
  'unset',
  'source',
  '.',
  'alias',
  'true',
  'false',
  ':',
  'local',
  'declare',
  'readonly',
  'shopt',
  'trap',
  'wait',
  'exit',
  'return'
)
const SHELLS = set('bash', 'sh', 'zsh', 'dash', 'ksh')
const PACKAGE_MANAGERS = set('npm', 'pnpm', 'yarn', 'bun')
const PYTHON_TOOLS = set('uv', 'poetry', 'pipenv', 'hatch', 'pdm', 'rye')
const MONOREPO_RUNNERS = set('turbo', 'nx', 'lerna')
const NPX_LIKE = set('npx', 'pnpx', 'bunx', 'uvx')

/** Binaries run through a package manager (`pnpm vitest`) or an interpreter (`node jest.js`). */
const RUNNER_BINARIES = set(
  'vitest',
  'jest',
  'mocha',
  'ava',
  'tap',
  'tape',
  'playwright',
  'cypress',
  'turbo',
  'nx',
  'lerna',
  'c8',
  'nyc',
  'cross-env',
  'dotenv',
  'phpunit',
  'pest',
  'rspec',
  'rails',
  'rake',
  'pytest'
)

/** Option flags that take the next word as their value, per command. */
const VALUE_FLAGS: Record<string, ReadonlySet<string>> = {
  env: set('-u', '--unset', '-C', '--chdir', '-S', '--split-string'),
  time: set('-f', '--format', '-o', '--output'),
  nice: set('-n', '--adjustment'),
  timeout: set('-s', '--signal', '-k', '--kill-after'),
  exec: set('-a'),
  'xvfb-run': set(
    '-n',
    '--server-num',
    '-s',
    '--server-args',
    '-e',
    '--error-file',
    '-f',
    '--auth-file',
    '-p',
    '--xauth-protocol',
    '-w',
    '--wait'
  ),
  dotenv: set('-e', '-v', '-p'),
  npx: set('-p', '--package', '-c', '--call', '--node-options', '--from', '--with', '--python'),
  c8: set(
    '-r',
    '--reporter',
    '-o',
    '--reports-dir',
    '--include',
    '-n',
    '--exclude',
    '-x',
    '--src',
    '--temp-directory',
    '--extension',
    '-e'
  ),
  nyc: set(
    '-r',
    '--reporter',
    '--include',
    '-n',
    '--exclude',
    '-x',
    '--extension',
    '-e',
    '--require',
    '-i',
    '--temp-dir',
    '-t',
    '--report-dir',
    '--cwd'
  ),
  coverage: set(
    '--rcfile',
    '--source',
    '--include',
    '--omit',
    '--data-file',
    '--concurrency',
    '--context'
  ),
  pythonRun: set(
    '--with',
    '-w',
    '--python',
    '-p',
    '--package',
    '--extra',
    '--group',
    '--directory',
    '--project',
    '--env-file',
    '--index',
    '-C',
    '-P',
    '-e',
    '--env'
  ),
  python: set('-X', '-W', '-Q'),
  node: set(
    '-r',
    '--require',
    '--import',
    '--loader',
    '--experimental-loader',
    '-C',
    '--conditions',
    '--env-file',
    '--inspect-port',
    '--test-reporter',
    '--test-reporter-destination'
  ),
  shell: set('-o', '-O', '+o', '+O'),
  npm: set('--prefix', '-w', '--workspace', '--loglevel'),
  pnpm: set(
    '-C',
    '--dir',
    '--filter',
    '-F',
    '--filter-prod',
    '--workspace-concurrency',
    '--reporter',
    '--loglevel'
  ),
  yarn: set('--cwd'),
  bun: set('--cwd', '--filter', '-F', '--config', '-c'),
  'yarn-foreach': set('--from', '--include', '--exclude', '-j', '--jobs', '--since'),
  composer: set('-d', '--working-dir'),
  turbo: set(
    '--filter',
    '-F',
    '--concurrency',
    '--cache-dir',
    '--output-logs',
    '--log-order',
    '--cache',
    '--env-mode',
    '--ui',
    '--profile',
    '--log-prefix',
    '--global-deps',
    '--cwd',
    '--token',
    '--team',
    '--api',
    '--scope'
  ),
  nx: set(
    '-p',
    '--projects',
    '--exclude',
    '--base',
    '--head',
    '-c',
    '--configuration',
    '--parallel',
    '--output-style',
    '--nxBail'
  ),
  lerna: set('--scope', '--ignore', '--concurrency', '--since')
}
const NO_FLAGS: ReadonlySet<string> = new Set()

const TURBO_COMMANDS = set(
  'prune',
  'login',
  'logout',
  'link',
  'unlink',
  'gen',
  'generate',
  'daemon',
  'ls',
  'query',
  'info',
  'telemetry',
  'bin',
  'scan',
  'devtools',
  'boundaries'
)
const NX_COMMANDS = set(
  'graph',
  'show',
  'list',
  'migrate',
  'generate',
  'g',
  'init',
  'reset',
  'report',
  'add',
  'release',
  'daemon',
  'format',
  'format:check',
  'format:write',
  'sync',
  'sync:check',
  'watch',
  'connect',
  'view-logs',
  'exec',
  'repair',
  'import',
  'login',
  'logout'
)

const word = (text: string): Word => ({ text, quoted: false, opaque: false, assignable: false })

/** Basename without Windows launcher suffixes, with wrapper scripts mapped to their tool. */
export function commandName(text: string): string {
  const base = (text.split(/[\\/]/).pop() ?? text).replace(/\.(cmd|exe|bat|ps1)$/i, '')
  if (/^gradlew$/i.test(base)) return 'gradle'
  if (/^mvnw$/i.test(base)) return 'mvn'
  if (/^python\d*(\.\d+)*$/.test(base) || base === 'py') return 'python'
  if (base === 'bazelisk') return 'bazel'
  return base
}

const scriptName = (text: string): string =>
  commandName(text).replace(/\.(m?js|cjs|ts|php|rb|py)$/, '')

const isFlag = (w: Word | undefined): boolean => !!w && w.text.startsWith('-') && w.text !== '-'

/** Index of the first word after the leading options; consumes a `--` separator. */
function skipFlags(words: Word[], from: number, valueFlags: ReadonlySet<string>): number {
  let i = from
  while (i < words.length && isFlag(words[i])) {
    const text = words[i].text
    i++
    if (text === '--') break
    if (!text.includes('=') && valueFlags.has(text)) i++
  }
  return i
}

/** Non-option words, skipping the values of `valueFlags`. */
export function positionals(words: Word[], from: number, valueFlags: ReadonlySet<string>): Word[] {
  const out: Word[] = []
  for (let i = from; i < words.length; i++) {
    const text = words[i].text
    if (isFlag(words[i])) {
      if (!text.includes('=') && valueFlags.has(text)) i++
      continue
    }
    out.push(words[i])
  }
  return out
}

/** `vitest@1.2.3` and `@scope/pkg@latest` lose their version. */
function withoutVersion(w: Word): Word {
  const at = w.text.lastIndexOf('@')
  return at > 0 ? { ...w, text: w.text.slice(0, at) } : w
}

function skipAssignments(words: Word[], from: number): number {
  let i = from
  while (i < words.length && words[i].assignable) i++
  return i
}

/** `npm`, `pnpm`, `yarn`, `bun`: returns the words to continue with, or the final form. */
function packageManager(name: string, words: Word[]): { next: Word[] } | { done: Word[] } {
  const flags = VALUE_FLAGS[name] ?? NO_FLAGS
  let i = skipFlags(words, 1, flags)
  if (name === 'yarn' && words[i]?.text === 'workspace') i = skipFlags(words, i + 2, flags)
  if (name === 'yarn' && words[i]?.text === 'workspaces' && words[i + 1]?.text === 'foreach') {
    i = skipFlags(words, i + 2, VALUE_FLAGS['yarn-foreach'])
  }
  let sub = words[i]?.text
  if (sub === undefined) return { done: [word(name)] }

  const isExec = sub === 'exec' || sub === 'dlx' || (name === 'bun' && sub === 'x')
  if (isExec) {
    const start = skipFlags(words, i + 1, VALUE_FLAGS.npx)
    const rest = words.slice(start)
    return { next: rest.length ? [withoutVersion(rest[0]), ...rest.slice(1)] : [] }
  }
  if ((name === 'npm' || name === 'pnpm') && (sub === 't' || sub === 'tst')) sub = 'test'
  else if (sub === 'run' || sub === 'run-script') {
    i = skipFlags(words, i + 1, flags)
    if (i >= words.length) return { done: [word(name), word(sub)] }
    sub = words[i].text
  } else if (RUNNER_BINARIES.has(sub)) {
    return { next: words.slice(i) }
  }
  return { done: [word(name), { ...words[i], text: sub }, ...words.slice(i + 1)] }
}

/** Targets passed with `-t a b`, `--target=a`, `--targets a,b` (nx run-many / affected). */
function nxTargets(words: Word[], from: number): string[] {
  const targets: string[] = []
  for (let i = from; i < words.length; i++) {
    const text = words[i].text
    const eq = text.indexOf('=')
    const flag = eq > 0 ? text.slice(0, eq) : text
    if (flag !== '-t' && flag !== '--target' && flag !== '--targets') continue
    if (eq > 0) {
      targets.push(...text.slice(eq + 1).split(','))
      continue
    }
    while (i + 1 < words.length && !isFlag(words[i + 1])) {
      targets.push(...words[++i].text.split(','))
    }
  }
  return targets.filter(Boolean)
}

/** `turbo`, `nx`, `lerna` become `<runner> run <task...>` when they run tasks. */
function monorepo(name: string, words: Word[]): Word[] {
  const flags = VALUE_FLAGS[name]
  const i = skipFlags(words, 1, flags)
  const sub = words[i]?.text
  const run = (tasks: string[]): Word[] => [word(name), word('run'), ...tasks.map(word)]
  if (sub === undefined) return words
  if (name === 'turbo') {
    if (TURBO_COMMANDS.has(sub)) return words
    const from = sub === 'run' || sub === 'watch' ? i + 1 : i
    return run(positionals(words, from, flags).map((w) => w.text))
  }
  if (name === 'nx') {
    if (sub === 'run') {
      // `nx run web:test:ci` → test; the canonical `nx run a b` stays as it is.
      const targets = positionals(words, i + 1, flags).map((w) => w.text.split(':'))
      return run(targets.map((parts) => parts[1] ?? parts[0]))
    }
    if (sub === 'run-many' || sub === 'affected') return run(nxTargets(words, i + 1))
    if (sub.startsWith('affected:')) return run([sub.slice('affected:'.length)])
    if (NX_COMMANDS.has(sub)) return words
    return run([sub])
  }
  if (sub !== 'run') return words
  return run(
    positionals(words, i + 1, flags)
      .slice(0, 1)
      .map((w) => w.text)
  )
}

/** `node path/to/jest.js` → `jest`; anything else is left alone. */
function interpreterScript(name: string, words: Word[]): Word[] | null {
  const i = skipFlags(words, 1, VALUE_FLAGS[name] ?? NO_FLAGS)
  const script = words[i]
  if (!script || !/[\\/]/.test(script.text)) return null
  const bin = scriptName(script.text)
  return RUNNER_BINARIES.has(bin) ? [{ ...script, text: bin }, ...words.slice(i + 1)] : null
}

/** `python [flags] -m module ...` → `module ...`; `-c` code is left alone. */
function python(words: Word[]): Word[] | null {
  for (let i = 1; i < words.length; i++) {
    const text = words[i].text
    if (text === '-m') return words.slice(i + 1)
    if (text === '-c') return null
    if (!isFlag(words[i])) break
    if (VALUE_FLAGS.python.has(text)) i++
  }
  return interpreterScript('python', words)
}

/** `bash -lc 'script'`: the script word, or null when there is no `-c`. */
function shellScript(words: Word[]): Word | null {
  let hasC = false
  let i = 1
  for (; i < words.length && /^[-+]/.test(words[i].text) && words[i].text !== '--'; i++) {
    const text = words[i].text
    if (VALUE_FLAGS.shell.has(text)) i++
    else if (/^-[a-zA-Z]+$/.test(text) && text.includes('c')) hasC = true
  }
  if (words[i]?.text === '--') i++
  return hasC ? (words[i] ?? null) : null
}

/** One step of normalisation: new words to look at again, or the final canonical words. */
type Step = { next: Word[] } | { done: Word[] } | { script: Word }

function step(words: Word[]): Step {
  const head = words[0]
  const name = head.opaque ? head.text : commandName(head.text)
  const words1 = (): Word[] => words.slice(1)
  const after = (flags: ReadonlySet<string>): Word[] => words.slice(skipFlags(words, 1, flags))

  if (
    KEYWORDS.has(name) ||
    name === 'nohup' ||
    name === 'cross-env' ||
    name === 'cross-env-shell'
  ) {
    return { next: words1() }
  }
  if (SKIPPED.has(name)) return { done: [] }
  switch (name) {
    case 'env':
    case 'time':
    case 'nice':
    case 'exec':
    case 'xvfb-run':
    case 'c8':
    case 'nyc':
      return { next: after(VALUE_FLAGS[name] ?? NO_FLAGS) }
    case 'timeout': {
      const rest = after(VALUE_FLAGS.timeout)
      return { next: rest.slice(1) }
    }
    case 'command': {
      const flag = words[1]?.text
      if (flag === '-v' || flag === '-V') return { done: [] }
      return { next: after(NO_FLAGS) }
    }
    case 'dotenv':
    case 'dotenvx': {
      const dashes = words.findIndex((w) => w.text === '--')
      if (dashes > 0) return { next: words.slice(dashes + 1) }
      if (name === 'dotenvx') return { done: words }
      return { next: after(VALUE_FLAGS.dotenv) }
    }
    case 'bundle':
      return words[1]?.text === 'exec' ? { next: words.slice(2) } : { done: words }
    case 'coverage': {
      if (words[1]?.text !== 'run') return { done: words }
      const i = skipFlags(words, 2, VALUE_FLAGS.coverage)
      if (words[i - 1]?.text === '-m') return { next: words.slice(i) }
      return { next: [word('python'), ...words.slice(i)] }
    }
    case 'python': {
      const module = python(words)
      return module ? { next: module } : { done: [{ ...head, text: name }, ...words1()] }
    }
    case 'node':
    case 'php':
    case 'ruby': {
      const script = interpreterScript(name, words)
      return script ? { next: script } : { done: [{ ...head, text: name }, ...words1()] }
    }
    case 'composer': {
      const i = skipFlags(words, 1, VALUE_FLAGS.composer)
      const sub = words[i]?.text
      const j = sub === 'run' || sub === 'run-script' ? i + 1 : i
      return { done: [word('composer'), ...words.slice(j)] }
    }
    case 'cargo': {
      const rest = words1().filter((w, i) => !(i === 0 && w.text.startsWith('+')))
      return { done: [word('cargo'), ...rest] }
    }
  }
  if (NPX_LIKE.has(name)) {
    const rest = after(VALUE_FLAGS.npx)
    return { next: rest.length ? [withoutVersion(rest[0]), ...rest.slice(1)] : [] }
  }
  if (PYTHON_TOOLS.has(name) && words[1]?.text === 'run') {
    return { next: words.slice(skipFlags(words, 2, VALUE_FLAGS.pythonRun)) }
  }
  if (PACKAGE_MANAGERS.has(name)) return packageManager(name, words)
  if (MONOREPO_RUNNERS.has(name)) {
    const out = monorepo(name, words)
    return { done: out === words ? [word(name), ...words1()] : out }
  }
  if (SHELLS.has(name)) {
    const script = shellScript(words)
    return script ? { script } : { done: [{ ...head, text: name }, ...words1()] }
  }
  return { done: head.opaque ? words : [{ ...head, text: name }, ...words1()] }
}

/**
 * Canonical forms of one simple command. Usually one entry; none for skipped commands
 * (`cd`, `export`, ...); several when a `bash -c` script holds more commands.
 */
export function normalizeSegment(segment: Segment, depth = 0): Canonical[] {
  let words = segment.words
  for (let round = 0; round < MAX_ROUNDS; round++) {
    words = words.slice(skipAssignments(words, 0))
    if (!words.length) return []
    const result = step(words)
    if ('script' in result) {
      if (depth >= MAX_SHELL_DEPTH) return []
      return lex(result.script.text).flatMap((inner) => normalizeSegment(inner, depth + 1))
    }
    if ('done' in result) {
      return result.done.length ? [{ words: result.done, raw: segment.raw }] : []
    }
    words = result.next
  }
  return []
}
