import { describe, expect, it } from 'vitest'
import { context, decide } from '../../test/guard'
import { defaultGuardSettings } from '../state/guardSettings'
import { MAX_ARGS, MAX_COMMANDS, MAX_DEPTH } from './commands'
import { evaluateGuard, MAX_GUARD_INPUT } from './evaluate'
import { MAX_REGEX_INPUT } from './custom'

// Command STRINGS for the pure evaluator only; nothing here is ever executed.

const ms = (fn: () => unknown): number => {
  const start = performance.now()
  fn()
  return performance.now() - start
}

describe('guard: inputs too large or nested to check (K1)', () => {
  it('denies inputs over the size limit and checks the ones at it', () => {
    const at = `echo ${'a'.repeat(MAX_GUARD_INPUT - 5)}`
    expect(at).toHaveLength(MAX_GUARD_INPUT)
    expect(decide(at).action).toBe('allow')
    expect(decide(`${at}a`)).toMatchObject({ action: 'deny', ruleId: 'disk.uncheckable' })
    const padded = `: '${'a'.repeat(MAX_GUARD_INPUT)}'; echo GUARD-SENTINEL`
    expect(decide(padded).ruleId).toBe('disk.uncheckable')
  })

  it('checks 1000 commands and denies 1001', () => {
    expect(MAX_COMMANDS).toBe(1000)
    expect(decide(`${'true; '.repeat(999)}true`).action).toBe('allow')
    expect(decide(`${'true; '.repeat(999)}rm -rf ~`).ruleId).toBe('disk.systemDelete')
    expect(decide(`${'true; '.repeat(1000)}true`)).toMatchObject({
      action: 'deny',
      ruleId: 'disk.uncheckable'
    })
  })

  it('denies more arguments than it can check in time', () => {
    expect(decide(`rm ${'a '.repeat(MAX_ARGS + 1)}`).ruleId).toBe('disk.uncheckable')
    expect(decide(`Remove-Item ${'a,'.repeat(MAX_ARGS)}b`, 'win', 'PowerShell').ruleId).toBe(
      'disk.uncheckable'
    )
    expect(decide(`rm ${'a '.repeat(1000)}`).action).toBe('allow')
  })

  it('follows 6 levels of nesting and denies 7', () => {
    expect(MAX_DEPTH).toBe(6)
    const nest = (n: number, inner: string): string => `${'$('.repeat(n)}${inner}${')'.repeat(n)}`
    expect(decide(nest(6, 'rm -rf ~')).ruleId).toBe('disk.systemDelete')
    expect(decide(nest(6, 'echo hi')).action).toBe('allow')
    expect(decide(nest(7, 'echo hi')).ruleId).toBe('disk.uncheckable')
    expect(decide(`echo ${'$('.repeat(40)}`).ruleId).toBe('disk.uncheckable')
    expect(decide('sudo '.repeat(7) + 'echo hi').ruleId).toBe('disk.uncheckable')
    let script = 'echo hi'
    for (let i = 0; i < 7; i++) script = `bash -c ${JSON.stringify(script)}`
    expect(decide(script).ruleId).toBe('disk.uncheckable')
  })

  it('respects a disk category set to allow for uncheckable input', () => {
    const settings = { ...defaultGuardSettings() }
    settings.categories = { ...settings.categories, disk: 'allow' }
    expect(decide(`${'true; '.repeat(1001)}true`, 'mac', 'Bash', { settings }).action).toBe('allow')
  })
})

describe('guard: cost stays linear (K2)', () => {
  const n = MAX_GUARD_INPUT
  const ps: [string, string][] = [
    ['quoted subexpressions', `echo "${'$('.repeat(n / 2 - 4)}"`],
    ['parentheses', '('.repeat(n)],
    ['braces', '{'.repeat(n)],
    ['method calls', 'a('.repeat(n / 2)],
    ['subexpressions', '$('.repeat(n / 2)],
    ['closed quoted subexpressions', `echo ${'"$(a)" '.repeat(n / 7 - 1)}`],
    ['strings in blocks', `${'("$('.repeat(n / 8)}`],
    ['redirections', 'echo x '.concat('> a '.repeat(n / 4 - 2))],
    ['iex strings', 'iex "iex \\"iex x\\"" ; '.repeat(n / 24)],
    ['arrays', `Remove-Item ${'a,'.repeat(n / 2 - 8)}b`]
  ]
  it.each(ps)('PowerShell: %s (128 KB) in under 200 ms', (_name, input) => {
    expect(input.length).toBeLessThanOrEqual(MAX_GUARD_INPUT)
    expect(ms(() => decide(input, 'win', 'PowerShell'))).toBeLessThan(200)
  })

  it('cmd.exe and POSIX adversarial input stays fast too', () => {
    expect(ms(() => decide(`cmd /c ${'^&'.repeat(n / 2 - 8)}`, 'win'))).toBeLessThan(200)
    expect(ms(() => decide(`echo ${'$('.repeat(n / 2 - 4)}`))).toBeLessThan(200)
    expect(ms(() => decide(`echo "${'$('.repeat(n / 2 - 4)}`))).toBeLessThan(200)
    expect(ms(() => decide(`echo ${'`'.repeat(n - 8)}`))).toBeLessThan(200)
    expect(ms(() => decide('a;'.repeat(n / 2)))).toBeLessThan(500)
  })

  const ALLOWED = [
    'rm\\s+-rf\\s+/',
    '^git\\s+push\\b.*--force',
    '\\bcurl\\b[^|]*\\|\\s*sh',
    'terraform (apply|destroy)',
    '\\w+\\s+\\w+',
    'DROP\\s+TABLE\\s+\\w+',
    '[a-z]+=[0-9]+'
  ]
  const adversarial = [
    'a'.repeat(MAX_REGEX_INPUT),
    'rm -rf -rf '.repeat(MAX_REGEX_INPUT / 11),
    ' '.repeat(MAX_REGEX_INPUT),
    'git push '.repeat(MAX_REGEX_INPUT / 9),
    'curl x '.repeat(MAX_REGEX_INPUT / 7),
    'aa '.repeat(MAX_REGEX_INPUT / 3)
  ]

  it.each(ALLOWED)('custom rule %s runs in under 50 ms on 2 KB', (pattern) => {
    const settings = {
      ...defaultGuardSettings(),
      customRules: [
        {
          id: 'r1',
          kind: 'regex' as const,
          target: 'raw' as const,
          pattern,
          action: 'ask' as const
        },
        {
          id: 'r2',
          kind: 'regex' as const,
          target: 'canonical' as const,
          pattern,
          action: 'ask' as const
        }
      ]
    }
    const ctx = context('mac', { settings })
    for (const text of adversarial) {
      expect(ms(() => evaluateGuard('Bash', { command: text }, ctx))).toBeLessThan(50)
    }
  })
})
