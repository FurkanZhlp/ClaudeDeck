/**
 * Built-in test command patterns, matched against canonical words (see normalize.ts).
 * Ids are stable: they are stored in `disabledBuiltins` and shown as `ruleId`.
 */

export type BuiltinGroupId =
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'jvm'
  | 'dotnet'
  | 'ruby'
  | 'php'
  | 'beam'
  | 'mobile'
  | 'native'
  | 'haskell'
  | 'taskRunners'
  | 'exclusions'

export interface BuiltinGroup {
  id: BuiltinGroupId
  label: string
}

export interface BuiltinPattern {
  id: string
  group: Exclude<BuiltinGroupId, 'exclusions'>
  label: string
  example: string
  /** `-v` means verbose here, so a lone `-v` is not treated as a version check. */
  verboseV?: boolean
  /** Runner tokens (the process fingerprint) when the words match, otherwise null. */
  match: (words: string[]) => string[] | null
}

export interface Exclusion {
  id: string
  label: string
  example: string
  /** Returns the offending argument, or null. `args` are the unquoted words after the command. */
  test: (args: string[], words: string[], rule: { verboseV?: boolean }) => string | null
}

/** Settings UI metadata (no matcher functions). */
export interface BuiltinInfo {
  id: string
  group: BuiltinGroupId
  label: string
  example: string
}

export const BUILTIN_GROUPS: readonly BuiltinGroup[] = [
  { id: 'javascript', label: 'JavaScript and TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'jvm', label: 'Java, Kotlin, Scala and Clojure' },
  { id: 'dotnet', label: '.NET' },
  { id: 'ruby', label: 'Ruby' },
  { id: 'php', label: 'PHP' },
  { id: 'beam', label: 'Elixir and Erlang' },
  { id: 'mobile', label: 'Swift, Xcode, Flutter and Dart' },
  { id: 'native', label: 'C, C++, Zig and Bazel' },
  { id: 'haskell', label: 'Haskell' },
  { id: 'taskRunners', label: 'Task runners (make, just, task)' },
  { id: 'exclusions', label: 'Exclusions (version, help and list flags)' }
]

/* Matcher helpers -------------------------------------------------------------------------- */

/** `a|b` alternatives; a trailing `*` makes an alternative a prefix. */
function tokenTest(spec: string): (text: string | undefined) => boolean {
  const alts = spec.split('|')
  return (text) =>
    text !== undefined &&
    alts.some((alt) => (alt.endsWith('*') ? text.startsWith(alt.slice(0, -1)) : text === alt))
}

/** Words start with the given token specs, e.g. `seq('npm|pnpm', 'test*')`. */
function seq(...specs: string[]): BuiltinPattern['match'] {
  const tests = specs.map(tokenTest)
  return (words) => (tests.every((t, i) => t(words[i])) ? words.slice(0, specs.length) : null)
}

const isOption = (text: string): boolean => text.startsWith('-') && text !== '-'

/** Positionals after the command, skipping options and the values of `valueFlags`. */
function positionalsOf(words: string[], valueFlags: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 1; i < words.length; i++) {
    const text = words[i]
    if (text === '--') break
    if (isOption(text)) {
      if (!text.includes('=') && valueFlags.includes(text)) i++
      continue
    }
    out.push(text)
  }
  return out
}

/** Command `name` with any positional (goal, task, target) accepted by `isTask`. */
function anyTask(
  names: string,
  valueFlags: readonly string[],
  isTask: (task: string) => boolean
): BuiltinPattern['match'] {
  const nameTest = tokenTest(names)
  return (words) => {
    if (!nameTest(words[0])) return null
    const task = positionalsOf(words, valueFlags).find(isTask)
    return task === undefined ? null : [words[0], task]
  }
}

/** Command `name` whose first positional is accepted by `isSub`. */
function firstTask(
  names: string,
  valueFlags: readonly string[],
  isSub: (task: string) => boolean
): BuiltinPattern['match'] {
  const nameTest = tokenTest(names)
  return (words) => {
    if (!nameTest(words[0])) return null
    const sub = positionalsOf(words, valueFlags)[0]
    return sub !== undefined && isSub(sub) ? [words[0], sub] : null
  }
}

/** A bare runner, unless its first positional is a non-running subcommand. */
function runner(name: string, notSubcommands: readonly string[] = []): BuiltinPattern['match'] {
  return (words) => {
    if (words[0] !== name) return null
    const sub = words[1]
    return sub !== undefined && notSubcommands.includes(sub) ? null : [name]
  }
}

const TASK_TARGET = /^(tests?|check)([-_:.].*)?$/

const MAVEN_VALUE_FLAGS = [
  '-pl',
  '--projects',
  '-f',
  '--file',
  '-P',
  '--activate-profiles',
  '-D',
  '--define',
  '-T',
  '--threads',
  '-s',
  '--settings',
  '-gs',
  '--global-settings',
  '-rf',
  '--resume-from',
  '-l',
  '--log-file',
  '-b',
  '--builder'
]
const MAVEN_GOALS = [
  'test',
  'verify',
  'integration-test',
  'surefire:test',
  'failsafe:integration-test'
]

const GRADLE_VALUE_FLAGS = [
  '-p',
  '--project-dir',
  '-b',
  '--build-file',
  '-c',
  '--settings-file',
  '-x',
  '--exclude-task',
  '-D',
  '--system-prop',
  '-P',
  '--project-prop',
  '-I',
  '--init-script',
  '-g',
  '--gradle-user-home',
  '--console',
  '--max-workers',
  '--tests',
  '--priority',
  '--warning-mode'
]
function isGradleTestTask(task: string): boolean {
  const name = task.split(':').pop() ?? task
  if (name === 'test' || name === 'check') return true
  if (/^test[A-Z]/.test(name)) return name !== 'testClasses'
  return /[a-z]Test$/.test(name) && !name.startsWith('compile')
}

const MAKE_VALUE_FLAGS = ['-C', '--directory', '-f', '--file', '--makefile', '-I', '-l', '-o', '-W']
const JUST_VALUE_FLAGS = [
  '-f',
  '--justfile',
  '-d',
  '--working-directory',
  '--shell',
  '--dotenv-path',
  '--dotenv-filename',
  '--color',
  '--set'
]
const TASK_VALUE_FLAGS = [
  '-d',
  '--dir',
  '-t',
  '--taskfile',
  '-o',
  '--output',
  '-C',
  '--concurrency'
]

/** `xcodebuild ... test`: an action word not used as an option value. */
const xcodebuild: BuiltinPattern['match'] = (words) => {
  if (words[0] !== 'xcodebuild') return null
  const at = words.findIndex(
    (w, i) => i > 0 && (w === 'test' || w === 'test-without-building') && !isOption(words[i - 1])
  )
  return at < 0 ? null : ['xcodebuild', words[at]]
}

/* Patterns ---------------------------------------------------------------------------------- */

export const BUILTIN_PATTERNS: readonly BuiltinPattern[] = [
  // JavaScript and TypeScript
  {
    id: 'js.script',
    group: 'javascript',
    label: 'npm, pnpm, yarn and bun test scripts',
    example: 'pnpm test',
    match: seq('npm|pnpm|yarn|bun', 'test*')
  },
  {
    id: 'js.vitest',
    group: 'javascript',
    label: 'Vitest',
    example: 'vitest run',
    match: runner('vitest', ['list', 'bench', 'init'])
  },
  { id: 'js.jest', group: 'javascript', label: 'Jest', example: 'jest', match: runner('jest') },
  { id: 'js.mocha', group: 'javascript', label: 'Mocha', example: 'mocha', match: runner('mocha') },
  { id: 'js.ava', group: 'javascript', label: 'AVA', example: 'ava', match: runner('ava') },
  {
    id: 'js.tap',
    group: 'javascript',
    label: 'node-tap and tape',
    example: 'tap',
    match: (words) => runner('tap')(words) ?? runner('tape')(words)
  },
  {
    id: 'js.playwright',
    group: 'javascript',
    label: 'Playwright Test',
    example: 'playwright test',
    match: seq('playwright', 'test')
  },
  {
    id: 'js.cypress',
    group: 'javascript',
    label: 'Cypress (run)',
    example: 'cypress run',
    match: seq('cypress', 'run')
  },
  {
    id: 'js.node-test',
    group: 'javascript',
    label: 'Node.js test runner',
    example: 'node --test',
    match: (words) => (words[0] === 'node' && words.includes('--test') ? ['node', '--test'] : null)
  },
  {
    id: 'js.monorepo',
    group: 'javascript',
    label: 'Monorepo test tasks (turbo, nx, lerna)',
    example: 'turbo run test',
    match: (words) => {
      if (!['turbo', 'nx', 'lerna'].includes(words[0]) || words[1] !== 'run') return null
      const task = words.slice(2).find((w) => w.startsWith('test'))
      return task === undefined ? null : [words[0], task]
    }
  },
  {
    id: 'js.deno',
    group: 'javascript',
    label: 'Deno test and test tasks',
    example: 'deno test',
    match: (words) => seq('deno', 'test')(words) ?? seq('deno', 'task', 'test*')(words)
  },
  // Python
  {
    id: 'py.pytest',
    group: 'python',
    label: 'pytest',
    example: 'pytest',
    verboseV: true,
    match: (words) => (words[0] === 'pytest' || words[0] === 'py.test' ? [words[0]] : null)
  },
  {
    id: 'py.unittest',
    group: 'python',
    label: 'unittest (python -m unittest)',
    example: 'python -m unittest',
    verboseV: true,
    match: runner('unittest')
  },
  {
    id: 'py.tox',
    group: 'python',
    label: 'tox',
    example: 'tox',
    verboseV: true,
    match: runner('tox')
  },
  {
    id: 'py.nox',
    group: 'python',
    label: 'nox',
    example: 'nox',
    verboseV: true,
    match: runner('nox')
  },
  {
    id: 'py.hatch',
    group: 'python',
    label: 'hatch test',
    example: 'hatch test',
    match: seq('hatch', 'test')
  },
  {
    id: 'py.django',
    group: 'python',
    label: 'Django (manage.py test)',
    example: 'python manage.py test',
    match: (words) =>
      words[0] === 'python' && /(^|[\\/])manage\.py$/.test(words[1] ?? '') && words[2] === 'test'
        ? ['python', 'manage.py', 'test']
        : null
  },
  // Go
  {
    id: 'go.test',
    group: 'go',
    label: 'go test',
    example: 'go test ./...',
    match: seq('go', 'test')
  },
  {
    id: 'go.gotestsum',
    group: 'go',
    label: 'gotestsum',
    example: 'gotestsum',
    match: runner('gotestsum')
  },
  // Rust
  {
    id: 'rust.cargo',
    group: 'rust',
    label: 'cargo test',
    example: 'cargo test',
    match: seq('cargo', 'test|t')
  },
  {
    id: 'rust.nextest',
    group: 'rust',
    label: 'cargo nextest run',
    example: 'cargo nextest run',
    match: seq('cargo', 'nextest', 'run')
  },
  // JVM
  {
    id: 'jvm.maven',
    group: 'jvm',
    label: 'Maven test and verify',
    example: 'mvn test',
    match: anyTask('mvn', MAVEN_VALUE_FLAGS, (goal) => MAVEN_GOALS.includes(goal))
  },
  {
    id: 'jvm.gradle',
    group: 'jvm',
    label: 'Gradle test and check',
    example: './gradlew test',
    match: anyTask('gradle', GRADLE_VALUE_FLAGS, isGradleTestTask)
  },
  {
    id: 'jvm.sbt',
    group: 'jvm',
    label: 'sbt test',
    example: 'sbt test',
    match: anyTask('sbt', [], (task) => /^(test|testOnly|testQuick)(\s|$)/.test(task))
  },
  {
    id: 'jvm.lein',
    group: 'jvm',
    label: 'Leiningen test',
    example: 'lein test',
    match: seq('lein', 'test')
  },
  // .NET
  {
    id: 'dotnet.test',
    group: 'dotnet',
    label: 'dotnet test',
    example: 'dotnet test',
    match: seq('dotnet', 'test')
  },
  // Ruby
  { id: 'ruby.rspec', group: 'ruby', label: 'RSpec', example: 'rspec', match: runner('rspec') },
  {
    id: 'ruby.rails',
    group: 'ruby',
    label: 'rails test',
    example: 'bin/rails test',
    match: seq('rails', 'test*')
  },
  {
    id: 'ruby.rake',
    group: 'ruby',
    label: 'rake test and spec',
    example: 'rake test',
    match: anyTask('rake', ['-f', '--rakefile', '-C', '--directory'], (task) =>
      /^(test|spec)([:_].*)?$/.test(task)
    )
  },
  // PHP
  {
    id: 'php.phpunit',
    group: 'php',
    label: 'PHPUnit',
    example: 'vendor/bin/phpunit',
    verboseV: true,
    match: runner('phpunit')
  },
  {
    id: 'php.pest',
    group: 'php',
    label: 'Pest',
    example: 'vendor/bin/pest',
    match: runner('pest')
  },
  {
    id: 'php.artisan',
    group: 'php',
    label: 'php artisan test',
    example: 'php artisan test',
    match: seq('php', 'artisan', 'test')
  },
  {
    id: 'php.composer',
    group: 'php',
    label: 'Composer test scripts',
    example: 'composer test',
    match: seq('composer', 'test*')
  },
  // Elixir and Erlang
  {
    id: 'beam.mix',
    group: 'beam',
    label: 'mix test',
    example: 'mix test',
    match: seq('mix', 'test*')
  },
  {
    id: 'beam.rebar3',
    group: 'beam',
    label: 'rebar3 eunit and ct',
    example: 'rebar3 eunit',
    match: seq('rebar3', 'eunit|ct')
  },
  // Swift, Xcode, Flutter, Dart
  {
    id: 'mobile.swift',
    group: 'mobile',
    label: 'swift test',
    example: 'swift test',
    match: seq('swift', 'test')
  },
  {
    id: 'mobile.xcodebuild',
    group: 'mobile',
    label: 'xcodebuild test',
    example: 'xcodebuild -scheme App test',
    match: xcodebuild
  },
  {
    id: 'mobile.flutter',
    group: 'mobile',
    label: 'flutter test',
    example: 'flutter test',
    match: seq('flutter', 'test')
  },
  {
    id: 'mobile.dart',
    group: 'mobile',
    label: 'dart test',
    example: 'dart test',
    match: (words) => seq('dart', 'test')(words) ?? seq('dart', 'run', 'test')(words)
  },
  // C, C++, Zig, Bazel
  {
    id: 'native.ctest',
    group: 'native',
    label: 'CTest',
    example: 'ctest',
    verboseV: true,
    match: runner('ctest')
  },
  {
    id: 'native.zig',
    group: 'native',
    label: 'zig build test',
    example: 'zig build test',
    match: (words) =>
      words[0] === 'zig' && words[1] === 'build' && words.slice(2).includes('test')
        ? ['zig', 'build', 'test']
        : null
  },
  {
    id: 'native.bazel',
    group: 'native',
    label: 'bazel test and coverage',
    example: 'bazel test //...',
    match: firstTask('bazel', [], (sub) => sub === 'test' || sub === 'coverage')
  },
  // Haskell
  {
    id: 'haskell.test',
    group: 'haskell',
    label: 'stack test and cabal test',
    example: 'cabal test',
    match: seq('stack|cabal', 'test')
  },
  // Task runners
  {
    id: 'task.make',
    group: 'taskRunners',
    label: 'make test and check',
    example: 'make test',
    match: anyTask('make|gmake', MAKE_VALUE_FLAGS, (t) => TASK_TARGET.test(t))
  },
  {
    id: 'task.just',
    group: 'taskRunners',
    label: 'just test and check',
    example: 'just test',
    match: firstTask('just', JUST_VALUE_FLAGS, (t) => TASK_TARGET.test(t))
  },
  {
    id: 'task.task',
    group: 'taskRunners',
    label: 'task test and check',
    example: 'task test',
    match: anyTask('task', TASK_VALUE_FLAGS, (t) => TASK_TARGET.test(t))
  }
]

/** Matches `--flag` and `--flag=value`. */
const flagIn = (args: string[], ...flags: string[]): string | null =>
  args.find((a) => flags.some((f) => a === f || a.startsWith(`${f}=`))) ?? null

export const EXCLUSIONS: readonly Exclusion[] = [
  {
    id: 'exclude.version',
    label: '--version',
    example: 'vitest --version',
    test: (args) => flagIn(args, '--version')
  },
  {
    id: 'exclude.lone-v',
    label: 'A lone -v (version)',
    example: 'jest -v',
    test: (_args, words, rule) =>
      words.length === 2 && words[1] === '-v' && !rule.verboseV ? '-v' : null
  },
  {
    id: 'exclude.help',
    label: '--help',
    example: 'pytest --help',
    test: (args) => flagIn(args, '--help')
  },
  {
    id: 'exclude.list',
    label: '--list',
    example: 'cargo test -- --list',
    test: (args) => flagIn(args, '--list')
  },
  {
    id: 'exclude.list-tests',
    label: '--listTests',
    example: 'jest --listTests',
    test: (args) => flagIn(args, '--listTests')
  },
  {
    id: 'exclude.collect-only',
    label: '--collect-only',
    example: 'pytest --collect-only',
    test: (args) => flagIn(args, '--collect-only', '--co')
  },
  {
    id: 'exclude.go-list',
    label: '-list (go test)',
    example: 'go test -list .',
    test: (args) => flagIn(args, '-list')
  }
]

const byId = new Map(BUILTIN_PATTERNS.map((p) => [p.id, p]))

export const findBuiltin = (id: string | null): BuiltinPattern | undefined =>
  id === null ? undefined : byId.get(id)

/** Built-in patterns and exclusions for the settings UI, in display order. */
export function builtinPatternList(): BuiltinInfo[] {
  return [
    ...BUILTIN_PATTERNS.map(({ id, group, label, example }) => ({ id, group, label, example })),
    ...EXCLUSIONS.map(({ id, label, example }) => ({
      id,
      group: 'exclusions' as const,
      label,
      example
    }))
  ]
}
