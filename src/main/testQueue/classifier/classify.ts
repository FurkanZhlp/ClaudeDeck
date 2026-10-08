import { isSafeRegex } from '../../../shared/safeRegex'
import type { ClassifyResult, ProjectTestQueue, TestPattern } from '../../../shared/types'
import { EXCLUSIONS, BUILTIN_PATTERNS, findBuiltin } from './builtinPatterns'
import { normalizeSegment, type Canonical } from '../../shell/normalize'
import { lex, type Word } from '../../shell/shellLexer'

/** Longer commands are cut before lexing (the hook sends at most this much anyway). */
export const MAX_CLASSIFY_INPUT = 16 * 1024
/** Text a custom regex is tested on is cut to this (bounds the cost of any user pattern). */
export const MAX_REGEX_INPUT = 2048
/** Compiled custom rules kept in memory; the cache is cleared when it grows past this. */
const MAX_CACHED_RULES = 500

export interface ClassifyOptions {
  /** Global built-in ids (patterns or exclusions) that are switched off. */
  disabledBuiltins: string[]
  /** Global custom rules. */
  customPatterns: TestPattern[]
  /** The tab's project settings; `mode: 'off'` never matches. */
  projectOverrides?: ProjectTestQueue
}

type Source = NonNullable<ClassifyResult['source']>

interface Rule {
  id: string
  source: Source
  verboseV?: boolean
  /** Canonical matcher (built-ins, prefix and canonical regex rules). */
  canonical?: (c: Canonical, texts: string[]) => boolean
  /** Raw regex rules: tested on each segment's source text, then on the whole input. */
  raw?: RegExp
}

/* Rendering --------------------------------------------------------------------------------- */

const SAFE_WORD = /^[A-Za-z0-9_\-./:=@%+,^~*]+$/

const shellQuote = (text: string): string =>
  SAFE_WORD.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`

/** Canonical words as a shell-safe string (lexes back to the same words). */
export const renderWords = (words: Word[]): string => words.map((w) => shellQuote(w.text)).join(' ')

/**
 * Text that canonical regex rules see. Quoted arguments with spaces and substitutions are
 * replaced by placeholders so `git commit -m "pnpm test"` cannot satisfy `pnpm test`.
 */
function regexTarget(words: Word[]): string {
  return words
    .map((w, i) => {
      if (w.opaque) return '$(...)'
      if (i > 0 && w.quoted && /\s/.test(w.text)) return "'...'"
      return shellQuote(w.text)
    })
    .join(' ')
}

/* Custom rule compilation (cached by pattern string) --------------------------------------- */

const regexCache = new Map<string, RegExp | null>()
const prefixCache = new Map<string, string[] | null>()

function cached<T>(cache: Map<string, T>, key: string, make: () => T): T {
  if (cache.has(key)) return cache.get(key) as T
  if (cache.size >= MAX_CACHED_RULES) cache.clear()
  const value = make()
  cache.set(key, value)
  return value
}

/** Unsafe patterns (saved before the check existed, or edited by hand) never compile. */
const compileRegex = (pattern: string): RegExp | null =>
  cached(regexCache, pattern, () => {
    if (!isSafeRegex(pattern)) return null
    try {
      return new RegExp(pattern)
    } catch {
      return null
    }
  })

/** A prefix rule is normalised like a command, so `npm run e2e*` equals `npm e2e*`. */
const compilePrefix = (pattern: string): string[] | null =>
  cached(prefixCache, pattern, () => {
    const segment = lex(pattern)[0]
    const canonical = segment ? normalizeSegment(segment)[0] : undefined
    return canonical ? canonical.words.map((w) => w.text) : null
  })

function prefixMatches(tokens: string[], words: Word[]): boolean {
  return tokens.every((token, i) => {
    const isLast = i === tokens.length - 1
    if (isLast && token === '*') return true
    const text = words[i]?.text
    if (text === undefined) return false
    return isLast && token.endsWith('*') ? text.startsWith(token.slice(0, -1)) : text === token
  })
}

function customRule(pattern: TestPattern, source: Source): Rule | null {
  if (pattern.kind === 'prefix') {
    const tokens = compilePrefix(pattern.pattern)
    if (!tokens?.length) return null
    return { id: pattern.id, source, canonical: (c) => prefixMatches(tokens, c.words) }
  }
  const regex = compileRegex(pattern.pattern)
  if (!regex) return null
  if (pattern.target === 'raw') return { id: pattern.id, source, raw: regex }
  return {
    id: pattern.id,
    source,
    canonical: (c) => regex.test(regexTarget(c.words).slice(0, MAX_REGEX_INPUT))
  }
}

function buildRules(opts: ClassifyOptions, disabled: ReadonlySet<string>): Rule[] {
  const rules: Rule[] = BUILTIN_PATTERNS.filter((p) => !disabled.has(p.id)).map((p) => ({
    id: p.id,
    source: 'builtin',
    verboseV: p.verboseV,
    canonical: (_c, texts) => p.match(texts) !== null
  }))
  const add = (patterns: TestPattern[], source: Source): void => {
    for (const pattern of patterns) {
      const rule = customRule(pattern, source)
      if (rule) rules.push(rule)
    }
  }
  add(opts.customPatterns, 'custom')
  add(opts.projectOverrides?.customPatterns ?? [], 'project')
  return rules
}

function exclusionFor(c: Canonical, rule: Rule, disabled: ReadonlySet<string>): string | null {
  const words = c.words.map((w) => w.text)
  const args = c.words
    .slice(1)
    .filter((w) => !w.quoted)
    .map((w) => w.text)
  for (const exclusion of EXCLUSIONS) {
    if (disabled.has(exclusion.id)) continue
    const hit = exclusion.test(args, words, rule)
    if (hit) return hit
  }
  return null
}

/* Classification ---------------------------------------------------------------------------- */

/**
 * Decides whether a Bash command runs tests. Every pipeline / list element is checked (in
 * order: built-ins, global rules, project rules); the first non-excluded match wins. When only
 * excluded matches exist, `isTest` is false and the first one is reported with `excludedBy`.
 */
export function classify(command: string, opts: ClassifyOptions): ClassifyResult {
  const truncated = command.length > MAX_CLASSIFY_INPUT
  const input = truncated ? command.slice(0, MAX_CLASSIFY_INPUT) : command
  const none: ClassifyResult = {
    isTest: false,
    ruleId: null,
    source: null,
    segment: null,
    excludedBy: null,
    truncated
  }
  const project = opts.projectOverrides
  if (project?.mode === 'off') return none

  const disabled = new Set([...opts.disabledBuiltins, ...(project?.disabledBuiltins ?? [])])
  const rules = buildRules(opts, disabled)
  const canonicals = lex(input).flatMap((segment) => normalizeSegment(segment))

  let excluded: ClassifyResult | null = null
  for (const c of canonicals) {
    const texts = c.words.map((w) => w.text)
    const rule = rules.find((r) =>
      r.canonical ? r.canonical(c, texts) : !!r.raw?.test(c.raw.slice(0, MAX_REGEX_INPUT))
    )
    if (!rule) continue
    const excludedBy = exclusionFor(c, rule, disabled)
    const result: ClassifyResult = {
      isTest: excludedBy === null,
      ruleId: rule.id,
      source: rule.source,
      segment: renderWords(c.words),
      excludedBy,
      truncated
    }
    if (!excludedBy) return result
    excluded ??= result
  }

  // Raw rules may span several commands (`cd e2e && ./run.sh`).
  const head = input.slice(0, MAX_REGEX_INPUT)
  const rawRule = rules.find((r) => r.raw?.test(head))
  if (rawRule) return { ...none, isTest: true, ruleId: rawRule.id, source: rawRule.source }
  return excluded ?? none
}

const isPlainToken = (text: string | undefined): text is string =>
  !!text && !text.startsWith('-') && !/[\\/]/.test(text)

/**
 * Runner tokens of a test match, used to find its process later: `['vitest']`,
 * `['pnpm', 'test']`, `['gradle', 'test']`. Empty when there is no matched segment.
 */
export function fingerprint(result: ClassifyResult): string[] {
  if (!result.isTest || !result.segment) return []
  const segment = lex(result.segment)[0]
  if (!segment) return []
  const words = (normalizeSegment(segment)[0]?.words ?? segment.words).map((w) => w.text)
  const tokens = result.source === 'builtin' ? findBuiltin(result.ruleId)?.match(words) : null
  if (tokens) return tokens
  return isPlainToken(words[1]) ? words.slice(0, 2) : words.slice(0, 1)
}
