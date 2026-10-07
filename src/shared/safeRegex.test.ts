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
    'go test ./\\.\\.\\.'
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
    '((a+))+'
  ])('refuses %s', (pattern) => {
    expect(isSafeRegex(pattern)).toBe(false)
  })
})
