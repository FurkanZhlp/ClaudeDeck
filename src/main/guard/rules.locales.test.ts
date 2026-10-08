import { describe, expect, it } from 'vitest'
import en from '../../shared/locales/en.json'
import tr from '../../shared/locales/tr.json'
import { guardRuleList } from './rules'

/** Value at a dotted locale key, or undefined. */
const lookup = (locale: object, key: string): unknown =>
  key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      locale
    )

const leafKeys = (node: object, prefix: string): string[] =>
  Object.entries(node).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null ? leafKeys(v, `${prefix}${k}.`) : [`${prefix}${k}`]
  )

describe('guard rule labels', () => {
  const labels = guardRuleList().map((r) => r.label)

  it.each([
    ['en', en],
    ['tr', tr]
  ])('every built-in rule has a %s label', (_, locale) => {
    const missing = labels.filter((key) => typeof lookup(locale, key) !== 'string')
    expect(missing).toEqual([])
  })

  it('has no labels for rules that do not exist', () => {
    const known = new Set(labels)
    const stale = leafKeys(en.guard.rules, 'guard.rules.').filter((key) => !known.has(key))
    expect(stale).toEqual([])
  })
})
