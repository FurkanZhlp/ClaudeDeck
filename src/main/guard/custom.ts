import { isSafeRegex } from '../../shared/safeRegex'
import type { GuardCustomRule } from '../../shared/types'
import { lex } from '../shell/shellLexer'
import { cmdName, type Cmd } from './commands'

/** User rules: prefix rules on the unwrapped command, regex rules on it or on the raw input. */

/** Text a regex is tested on is cut to this (bounds the cost of any user pattern). */
export const MAX_REGEX_INPUT = 2048
const MAX_CACHED = 500

const regexCache = new Map<string, RegExp | null>()
const prefixCache = new Map<string, string[] | null>()

function cached<T>(cache: Map<string, T>, key: string, make: () => T): T {
  if (cache.has(key)) return cache.get(key) as T
  if (cache.size >= MAX_CACHED) cache.clear()
  const value = make()
  cache.set(key, value)
  return value
}

/** Unsafe or broken patterns (hand-edited config) never compile. */
const compileRegex = (pattern: string): RegExp | null =>
  cached(regexCache, pattern, () => {
    if (!isSafeRegex(pattern)) return null
    try {
      return new RegExp(pattern)
    } catch {
      return null
    }
  })

const compilePrefix = (pattern: string): string[] | null =>
  cached(prefixCache, pattern, () => {
    const words = lex(pattern)[0]?.words.map((w) => w.text)
    if (!words?.length) return null
    return [cmdName(words[0]), ...words.slice(1)]
  })

function prefixMatches(tokens: string[], words: string[]): boolean {
  return tokens.every((token, i) => {
    const isLast = i === tokens.length - 1
    if (isLast && token === '*') return true
    const text = words[i]
    if (text === undefined) return false
    return isLast && token.endsWith('*') ? text.startsWith(token.slice(0, -1)) : text === token
  })
}

/** The command as rules see it: name, then arguments (substitutions shown as `$(...)`). */
export const canonicalText = (cmd: Cmd): string =>
  [cmd.name, ...cmd.args.map((a) => (a.opaque ? '$(...)' : a.text))].join(' ')

/** The rule matches this command. */
export function matchesCommand(rule: GuardCustomRule, cmd: Cmd): boolean {
  if (!cmd.name) return false
  if (rule.kind === 'prefix') {
    const tokens = compilePrefix(rule.pattern)
    return !!tokens && prefixMatches(tokens, [cmd.name, ...cmd.args.map((a) => a.text)])
  }
  if (rule.target === 'raw') return false
  const regex = compileRegex(rule.pattern)
  return !!regex && regex.test(canonicalText(cmd).slice(0, MAX_REGEX_INPUT))
}

/** A raw regex rule matches the input as written. */
export function matchesRaw(rule: GuardCustomRule, input: string): boolean {
  if (rule.kind !== 'regex' || rule.target !== 'raw') return false
  const regex = compileRegex(rule.pattern)
  return !!regex && regex.test(input.slice(0, MAX_REGEX_INPUT))
}
