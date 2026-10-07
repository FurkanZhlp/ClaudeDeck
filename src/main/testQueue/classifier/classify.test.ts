import { describe, expect, it } from 'vitest'
import type { ProjectTestQueue, TestPattern } from '../../../shared/types'
import { TEST_RULE_ID } from '../../../shared/testQueueLimits'
import { BUILTIN_GROUPS, BUILTIN_PATTERNS, EXCLUSIONS, builtinPatternList } from './builtinPatterns'
import { classify, fingerprint, MAX_CLASSIFY_INPUT, type ClassifyOptions } from './classify'

const defaults: ClassifyOptions = { disabledBuiltins: [], customPatterns: [] }
const run = (command: string, opts: Partial<ClassifyOptions> = {}): ReturnType<typeof classify> =>
  classify(command, { ...defaults, ...opts })

/** [command, expected built-in rule id or null for "not a test"] */
const CASES: [string, string | null][] = [
  // JavaScript package manager scripts
  ['npm test', 'js.script'],
  ['npm t', 'js.script'],
  ['npm tst', 'js.script'],
  ['npm run test', 'js.script'],
  ['npm run-script test:unit', 'js.script'],
  ['npm run test -- --watch=false', 'js.script'],
  ['npm test --workspace=web', 'js.script'],
  ['npm --prefix web test', 'js.script'],
  ['npm -w web run test', 'js.script'],
  ['pnpm test', 'js.script'],
  ['pnpm run test:e2e', 'js.script'],
  ['pnpm -C web test', 'js.script'],
  ['pnpm --dir web test', 'js.script'],
  ['pnpm --filter web test', 'js.script'],
  ['pnpm --filter=web run test', 'js.script'],
  ['pnpm -F @app/web test:unit', 'js.script'],
  ['pnpm -r test', 'js.script'],
  ['pnpm -w run test', 'js.script'],
  ['yarn test', 'js.script'],
  ['yarn run test', 'js.script'],
  ['yarn --cwd packages/a test', 'js.script'],
  ['yarn workspace @app/web test', 'js.script'],
  ['yarn workspaces foreach -A --exclude root run test', 'js.script'],
  ['bun test', 'js.script'],
  ['bun run test', 'js.script'],
  ['bun --cwd api test', 'js.script'],
  // JavaScript runners
  ['vitest', 'js.vitest'],
  ['vitest run src/foo.test.ts', 'js.vitest'],
  ['npx vitest run', 'js.vitest'],
  ['npx --yes vitest@latest run', 'js.vitest'],
  ['npx -p vitest vitest', 'js.vitest'],
  ['pnpm vitest', 'js.vitest'],
  ['pnpm exec vitest run', 'js.vitest'],
  ['pnpm --filter web exec vitest', 'js.vitest'],
  ['pnpm dlx vitest', 'js.vitest'],
  ['npm exec -- vitest', 'js.vitest'],
  ['yarn dlx vitest', 'js.vitest'],
  ['bunx vitest', 'js.vitest'],
  ['bun x vitest', 'js.vitest'],
  ['./node_modules/.bin/vitest run', 'js.vitest'],
  ['node node_modules/vitest/vitest.mjs run', 'js.vitest'],
  ['jest', 'js.jest'],
  ['npx jest --coverage', 'js.jest'],
  ['node --experimental-vm-modules node_modules/jest/bin/jest.js', 'js.jest'],
  ['yarn jest -t "adds numbers"', 'js.jest'],
  ['mocha test/**/*.spec.js', 'js.mocha'],
  ['nyc --reporter lcov mocha', 'js.mocha'],
  ['c8 -r html vitest run', 'js.vitest'],
  ['ava', 'js.ava'],
  ['tap test/*.js', 'js.tap'],
  ['npx playwright test', 'js.playwright'],
  ['pnpm exec playwright test --project=chromium', 'js.playwright'],
  ['xvfb-run -a npx playwright test', 'js.playwright'],
  ['npx cypress run', 'js.cypress'],
  ['node --test', 'js.node-test'],
  ['node --test test/', 'js.node-test'],
  ['deno test -A', 'js.deno'],
  ['deno task test', 'js.deno'],
  // Monorepo runners
  ['turbo run test', 'js.monorepo'],
  ['turbo test --filter=web', 'js.monorepo'],
  ['turbo run build test', 'js.monorepo'],
  ['pnpm turbo test', 'js.monorepo'],
  ['npx turbo run test:unit --filter web', 'js.monorepo'],
  ['nx test web', 'js.monorepo'],
  ['nx run web:test', 'js.monorepo'],
  ['nx run web:test:ci', 'js.monorepo'],
  ['npx nx run-many -t test lint', 'js.monorepo'],
  ['nx run-many --target=test', 'js.monorepo'],
  ['nx affected -t test', 'js.monorepo'],
  ['nx affected:test', 'js.monorepo'],
  ['lerna run test --scope pkg', 'js.monorepo'],
  // Env prefixes and wrappers
  ['CI=1 pnpm test', 'js.script'],
  ['CI=true NODE_ENV=test npx vitest run', 'js.vitest'],
  ['env CI=1 pnpm test', 'js.script'],
  ['env -u HOME -i PATH=/bin pytest', 'py.pytest'],
  ['time pnpm test', 'js.script'],
  ['time -p go test ./...', 'go.test'],
  ['nice -n 10 cargo test', 'rust.cargo'],
  ['timeout 600 pnpm test', 'js.script'],
  ['timeout -s KILL 5m pytest -x', 'py.pytest'],
  ['command pnpm test', 'js.script'],
  ['exec pytest', 'py.pytest'],
  ['nohup pnpm test', 'js.script'],
  ['cross-env CI=1 jest', 'js.jest'],
  ['dotenv -e .env.test -- vitest run', 'js.vitest'],
  ['dotenv -- pnpm test', 'js.script'],
  ['! pnpm test', 'js.script'],
  // Compound commands
  ['cd web && pnpm test', 'js.script'],
  ['cd web; pnpm test', 'js.script'],
  ['pushd api && go test ./... && popd', 'go.test'],
  ['export CI=1 && pytest', 'py.pytest'],
  ['set -e; cargo test', 'rust.cargo'],
  ['pnpm build && pnpm test', 'js.script'],
  ['pnpm test 2>&1 | tail -n 50', 'js.script'],
  ['(cd web && pnpm test)', 'js.script'],
  ['{ pnpm test; }', 'js.script'],
  ['pnpm lint\npnpm test', 'js.script'],
  ['if pnpm test; then echo ok; fi', 'js.script'],
  ['for d in a b; do (cd $d && go test ./...); done', 'go.test'],
  ['pnpm test &', 'js.script'],
  ['pnpm install || pnpm test', 'js.script'],
  // Shell -c recursion
  ["bash -c 'pnpm test'", 'js.script'],
  ['sh -c "cd web && pnpm test"', 'js.script'],
  ["bash -lc 'pytest -q'", 'py.pytest'],
  ["zsh -o pipefail -c 'go test ./... | tee log'", 'go.test'],
  [`bash -c "sh -c 'pnpm test'"`, 'js.script'],
  // Heredocs and substitutions
  ['cat <<EOF > run.sh\npnpm test\nEOF\nchmod +x run.sh', null],
  ['cat <<EOF\npytest\nEOF\npytest', 'py.pytest'],
  [`git commit -m "$(cat <<'EOF'\nRun pnpm test (user's)\nEOF\n)"`, null],
  [`git commit -m "$(cat <<'EOF'\nFix it\nEOF\n)" && pnpm test`, 'js.script'],
  ['echo $(pnpm test)', null],
  ['echo `pytest`', null],
  // Python
  ['pytest', 'py.pytest'],
  ['pytest -v', 'py.pytest'],
  ['pytest tests/test_api.py -k "slow and not db"', 'py.pytest'],
  ['python -m pytest', 'py.pytest'],
  ['python3 -m pytest -x', 'py.pytest'],
  ['python3.12 -u -m pytest', 'py.pytest'],
  ['py -3 -m pytest', 'py.pytest'],
  ['python -m unittest discover', 'py.unittest'],
  ['python -m unittest -v', 'py.unittest'],
  ['uv run pytest', 'py.pytest'],
  ['uv run --with pytest-xdist pytest -n 4', 'py.pytest'],
  ['uv run python -m pytest', 'py.pytest'],
  ['uvx pytest', 'py.pytest'],
  ['poetry run pytest', 'py.pytest'],
  ['pipenv run python -m pytest', 'py.pytest'],
  ['pdm run pytest', 'py.pytest'],
  ['hatch test', 'py.hatch'],
  ['coverage run -m pytest', 'py.pytest'],
  ['tox -e py312', 'py.tox'],
  ['nox -s tests', 'py.nox'],
  ['python manage.py test', 'py.django'],
  // Go, Rust
  ['go test ./...', 'go.test'],
  ['go test -v -run TestFoo ./pkg/...', 'go.test'],
  ['gotestsum --format testname', 'go.gotestsum'],
  ['cargo test', 'rust.cargo'],
  ['cargo t', 'rust.cargo'],
  ['cargo +nightly test --workspace', 'rust.cargo'],
  ['cargo nextest run', 'rust.nextest'],
  // JVM
  ['mvn test', 'jvm.maven'],
  ['mvn -q clean verify', 'jvm.maven'],
  ['mvn -pl core -am test', 'jvm.maven'],
  ['./mvnw verify', 'jvm.maven'],
  ['mvnw.cmd verify', 'jvm.maven'],
  ['./gradlew test', 'jvm.gradle'],
  ['./gradlew :app:test --tests "com.example.*"', 'jvm.gradle'],
  ['gradle check', 'jvm.gradle'],
  ['./gradlew testDebugUnitTest', 'jvm.gradle'],
  ['./gradlew connectedAndroidTest', 'jvm.gradle'],
  ['gradlew.bat test', 'jvm.gradle'],
  ['.\\\\gradlew.bat test', 'jvm.gradle'],
  ['sbt test', 'jvm.sbt'],
  ['sbt "testOnly com.example.FooSpec"', 'jvm.sbt'],
  ['lein test', 'jvm.lein'],
  // .NET, Ruby, PHP
  ['dotnet test', 'dotnet.test'],
  ['dotnet test --filter Category=Unit', 'dotnet.test'],
  ['rspec', 'ruby.rspec'],
  ['bundle exec rspec spec/models', 'ruby.rspec'],
  ['bin/rails test', 'ruby.rails'],
  ['rails test:system', 'ruby.rails'],
  ['bundle exec rake test', 'ruby.rake'],
  ['rake spec', 'ruby.rake'],
  ['vendor/bin/phpunit', 'php.phpunit'],
  ['php vendor/bin/phpunit --filter UserTest', 'php.phpunit'],
  ['./vendor/bin/pest', 'php.pest'],
  ['php artisan test', 'php.artisan'],
  ['php artisan test --parallel', 'php.artisan'],
  ['composer test', 'php.composer'],
  ['composer run-script test', 'php.composer'],
  // Elixir, Erlang, Swift, Flutter, Dart, native, Haskell
  ['mix test', 'beam.mix'],
  ['MIX_ENV=test mix test --cover', 'beam.mix'],
  ['rebar3 eunit', 'beam.rebar3'],
  ['swift test', 'mobile.swift'],
  [
    'xcodebuild -scheme App -destination "platform=iOS Simulator,name=iPhone 16" test',
    'mobile.xcodebuild'
  ],
  ['flutter test', 'mobile.flutter'],
  ['dart test', 'mobile.dart'],
  ['ctest --output-on-failure', 'native.ctest'],
  ['zig build test', 'native.zig'],
  ['bazel test //...', 'native.bazel'],
  ['bazelisk test //pkg:all', 'native.bazel'],
  ['cabal test', 'haskell.test'],
  ['stack test', 'haskell.test'],
  // Task runners
  ['make test', 'task.make'],
  ['make -j8 test', 'task.make'],
  ['make -C backend check', 'task.make'],
  ['make test-unit', 'task.make'],
  ['just test', 'task.just'],
  ['task test', 'task.task'],
  // Windows forms
  ['npm.cmd test', 'js.script'],
  ['pnpm.cmd test', 'js.script'],
  ['npx.cmd vitest', 'js.vitest'],
  ['"C:\\Program Files\\nodejs\\npm.cmd" test', 'js.script'],
  ['C:/tools/go.exe test ./...', 'go.test'],
  ['python.exe -m pytest', 'py.pytest'],
  ['dotnet.exe test', 'dotnet.test'],
  // Negatives
  ['git commit -m "pnpm test"', null],
  ["git commit -m 'run pytest before merge'", null],
  ['echo pnpm test', null],
  ['echo "pnpm test"', null],
  ['printf "%s\\n" "go test"', null],
  ['grep test src/foo.ts', null],
  ['grep -r "pnpm test" .', null],
  ['rg pytest', null],
  ['cat test.txt', null],
  ['ls test/', null],
  ['test -f package.json', null],
  ['[ -d test ] && echo yes', null],
  ['npm install', null],
  ['npm install --save-dev vitest', null],
  ['pnpm add -D jest', null],
  ['pnpm build', null],
  ['pnpm run build', null],
  ['pnpm lint', null],
  ['pnpm typecheck', null],
  ['yarn', null],
  ['npm run', null],
  ['npm view jest version', null],
  ['pip install pytest', null],
  ['uv pip install pytest', null],
  ['go build ./...', null],
  ['go vet ./...', null],
  ['cargo build', null],
  ['mvn clean install -DskipTests', null],
  ['./gradlew build -x test', null],
  ['./gradlew compileTestKotlin', null],
  ['make build', null],
  ['make', null],
  ['docker compose up -d', null],
  ['git status', null],
  ['cd test', null],
  ['vim test/foo.test.ts', null],
  ['node scripts/build.js', null],
  ['python manage.py migrate', null],
  ['python -c "import pytest"', null],
  ['command -v pytest', null],
  ['which vitest', null],
  ['turbo run build', null],
  ['nx build web', null],
  ['nx graph', null],
  ['vitest list', null],
  ['bash script.sh', null],
  ['sh -c "echo pnpm test"', null],
  ['"pnpm test"', null],
  ['$(which pytest)', null],
  ['', null],
  ['   ', null],
  ['# pnpm test', null]
]

describe('classify: built-in table', () => {
  it.each(CASES)('%j → %s', (command, ruleId) => {
    const result = run(command)
    expect(result.ruleId).toBe(ruleId)
    expect(result.isTest).toBe(ruleId !== null)
    if (ruleId) expect(result.source).toBe('builtin')
  })

  it('has a large table', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(150)
  })
})

describe('classify: exclusions', () => {
  const EXCLUDED: [string, string, string][] = [
    ['vitest --version', 'js.vitest', '--version'],
    ['jest -v', 'js.jest', '-v'],
    ['pnpm test --help', 'js.script', '--help'],
    ['cargo test -- --list', 'rust.cargo', '--list'],
    ['jest --listTests', 'js.jest', '--listTests'],
    ['pytest --collect-only', 'py.pytest', '--collect-only'],
    ['pytest --co -q', 'py.pytest', '--co'],
    ['go test -list .', 'go.test', '-list'],
    ['go test -list=Foo ./...', 'go.test', '-list=Foo']
  ]

  it.each(EXCLUDED)('%j is excluded', (command, ruleId, flag) => {
    expect(run(command)).toMatchObject({ isTest: false, ruleId, excludedBy: flag })
  })

  it('treats -v as verbose for runners that use it that way', () => {
    expect(run('pytest -v').isTest).toBe(true)
    expect(run('go test -v').isTest).toBe(true)
  })

  it('ignores flags inside quoted arguments', () => {
    expect(run('pytest -k "--help"').isTest).toBe(true)
  })

  it('can be switched off by id', () => {
    expect(run('vitest --version', { disabledBuiltins: ['exclude.version'] }).isTest).toBe(true)
    expect(run('jest -v', { disabledBuiltins: ['exclude.lone-v'] }).isTest).toBe(true)
  })

  it('keeps looking at later segments after an excluded one', () => {
    expect(run('vitest --version && vitest run')).toMatchObject({ isTest: true, excludedBy: null })
  })
})

describe('classify: options', () => {
  const custom = (
    p: Partial<TestPattern> & Pick<TestPattern, 'kind' | 'pattern'>
  ): TestPattern => ({
    id: 'c1',
    ...p
  })

  it('disables built-ins globally and per project', () => {
    expect(run('pytest', { disabledBuiltins: ['py.pytest'] }).isTest).toBe(false)
    const project: ProjectTestQueue = {
      mode: 'inherit',
      disabledBuiltins: ['go.test'],
      customPatterns: []
    }
    expect(run('go test ./...', { projectOverrides: project }).isTest).toBe(false)
    expect(run('pytest', { projectOverrides: project }).isTest).toBe(true)
  })

  it('never matches when the project is off', () => {
    const project: ProjectTestQueue = { mode: 'off', disabledBuiltins: [], customPatterns: [] }
    expect(run('pnpm test', { projectOverrides: project })).toMatchObject({
      isTest: false,
      ruleId: null
    })
  })

  it('matches token prefix rules after normalisation', () => {
    const patterns = [custom({ kind: 'prefix', pattern: 'npm run e2e*' })]
    expect(run('npm run e2e:chrome', { customPatterns: patterns })).toMatchObject({
      isTest: true,
      ruleId: 'c1',
      source: 'custom'
    })
    expect(run('CI=1 npm e2e', { customPatterns: patterns }).isTest).toBe(true)
    expect(run('npm run lint', { customPatterns: patterns }).isTest).toBe(false)
    expect(run('echo npm run e2e', { customPatterns: patterns }).isTest).toBe(false)
  })

  it('compares prefix tokens exactly unless they end with *', () => {
    const patterns = [custom({ kind: 'prefix', pattern: './scripts/e2e.sh' })]
    expect(run('./scripts/e2e.sh --ci', { customPatterns: patterns }).isTest).toBe(true)
    expect(run('./scripts/e2e.shx', { customPatterns: patterns }).isTest).toBe(false)
    const any = [custom({ kind: 'prefix', pattern: 'make e2e *' })]
    expect(run('make e2e', { customPatterns: any }).isTest).toBe(true)
  })

  it('matches canonical regex rules without seeing quoted arguments', () => {
    const patterns = [custom({ kind: 'regex', pattern: 'pnpm e2e' })]
    expect(run('cd web && pnpm run e2e', { customPatterns: patterns }).isTest).toBe(true)
    expect(run('git commit -m "pnpm e2e"', { customPatterns: patterns }).isTest).toBe(false)
  })

  it('matches raw regex rules on segments and on the whole input', () => {
    const segment = [custom({ kind: 'regex', pattern: '^\\./run-e2e', target: 'raw' })]
    expect(run('ls && ./run-e2e --ci', { customPatterns: segment })).toMatchObject({
      isTest: true,
      segment: 'run-e2e --ci'
    })
    const whole = [custom({ kind: 'regex', pattern: 'cd e2e && ', target: 'raw' })]
    expect(run('cd e2e && ./go.sh', { customPatterns: whole })).toMatchObject({
      isTest: true,
      ruleId: 'c1',
      segment: null
    })
  })

  it('reports project rules with their source and ignores invalid regexes', () => {
    const project: ProjectTestQueue = {
      mode: 'inherit',
      disabledBuiltins: [],
      customPatterns: [
        { id: 'bad', kind: 'regex', pattern: '(' },
        { id: 'p1', kind: 'prefix', pattern: 'just e2e' }
      ]
    }
    expect(run('just e2e', { projectOverrides: project })).toMatchObject({
      ruleId: 'p1',
      source: 'project'
    })
  })

  it('prefers built-ins over custom rules', () => {
    const patterns = [custom({ kind: 'prefix', pattern: 'pnpm test' })]
    expect(run('pnpm test', { customPatterns: patterns }).ruleId).toBe('js.script')
  })

  it('truncates long input', () => {
    const long = 'pnpm test ' + 'x'.repeat(MAX_CLASSIFY_INPUT)
    expect(run(long)).toMatchObject({ isTest: true, truncated: true })
    expect(run('x'.repeat(MAX_CLASSIFY_INPUT) + ' && pnpm test')).toMatchObject({
      isTest: false,
      truncated: true
    })
  })

  it('stops following nested shells after two levels', () => {
    expect(run(`bash -c "bash -c 'pnpm test'"`).isTest).toBe(true)
    expect(run(`bash -c "bash -c \\"bash -c 'pnpm test'\\""`).isTest).toBe(false)
  })

  it('reports the canonical segment', () => {
    expect(run('CI=1 pnpm --filter web run test -- -t "a b"').segment).toBe("pnpm test -- -t 'a b'")
  })
})

describe('fingerprint', () => {
  const FINGERPRINTS: [string, string[]][] = [
    ['npx vitest run', ['vitest']],
    ['pnpm --filter web test', ['pnpm', 'test']],
    ['npm run test:unit', ['npm', 'test:unit']],
    ['./gradlew :app:test', ['gradle', ':app:test']],
    ['mvn -q clean verify', ['mvn', 'verify']],
    ['python -m pytest -x', ['pytest']],
    ['nx run-many -t lint test', ['nx', 'test']],
    ['go test ./...', ['go', 'test']]
  ]

  it.each(FINGERPRINTS)('%j → %j', (command, tokens) => {
    expect(fingerprint(run(command))).toEqual(tokens)
  })

  it('uses the first words for custom rules and nothing for non-tests', () => {
    const patterns: TestPattern[] = [{ id: 'c1', kind: 'prefix', pattern: 'make e2e' }]
    expect(fingerprint(run('make e2e CI=1', { customPatterns: patterns }))).toEqual(['make', 'e2e'])
    expect(fingerprint(run('git status'))).toEqual([])
    expect(fingerprint(run('vitest --version'))).toEqual([])
  })
})

describe('built-in list', () => {
  it('has unique, valid ids in known groups', () => {
    const list = builtinPatternList()
    const ids = list.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => TEST_RULE_ID.test(id))).toBe(true)
    const groups = new Set(BUILTIN_GROUPS.map((g) => g.id))
    expect(list.every((p) => groups.has(p.group))).toBe(true)
    expect(list).toHaveLength(BUILTIN_PATTERNS.length + EXCLUSIONS.length)
  })

  it('classifies every example as its own pattern or exclusion', () => {
    for (const pattern of BUILTIN_PATTERNS) {
      expect(run(pattern.example).ruleId, pattern.example).toBe(pattern.id)
    }
    for (const exclusion of EXCLUSIONS) {
      expect(run(exclusion.example).excludedBy, exclusion.example).not.toBeNull()
    }
  })
})
