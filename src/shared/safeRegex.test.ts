import { describe, expect, it } from 'vitest'
import { isSafeRegex } from './safeRegex'

describe('isSafeRegex', () => {
  it.each([
    '^pnpm (run )?test',
    '\\bvitest\\b',
    '(npm|pnpm|yarn) test',
    '^(?:make|just) (unit|e2e)-tests?$',
    'e2e/[a-z]+\\.sh',
    'a+b*c{2,5}',
    '(ab)+',
    '(a+)?',
    '(?<name>x)y',
    '[(+*]+(x)',
    'go test ./\\.\\.\\.',
    'rm\\s+-rf\\s+/',
    '^git\\s+push\\b.*--force',
    '\\bcurl\\b[^|]*\\|\\s*sh',
    '\\w+\\s+\\w+',
    '[a-z]+=[0-9]+',
    'a.{0,10}b.{0,10}c'
  ])('accepts %s', (pattern) => {
    expect(isSafeRegex(pattern)).toBe(true)
  })

  it.each([
    '(a+)+',
    '(a*)*$',
    '(\\w+\\s?)*$',
    '((ab)*c){2,}',
    '(a|aa)+',
    '(x|y|z){1,10}',
    '(?:a+){3}',
    '(a)\\1',
    '(?<n>a)\\k<n>',
    '((a+))+',
    '.*.*',
    '.*.*.*.*x',
    '.+\\w*.*',
    'rm.*-rf.*/.*x',
    '\\s*\\s*\\s*x',
    '\\w+-?\\w+',
    '.*x(y)?.*',
    '[a-z]*[a-c]+',
    '.{0,100}.{0,100}',
    'a.*|b.*.*'
  ])('refuses %s', (pattern) => {
    expect(isSafeRegex(pattern)).toBe(false)
  })
})
