import { type Cmd, UNKNOWN_VAR } from '../commands'
import { hit, type CmdDetector, type Hit } from './types'

/**
 * Claude started from a tab in a way that escapes ClaudeDeck's guard: the hook's variables
 * removed or changed, another config folder, other settings sources, or permission checks
 * turned off. A plain nested `claude -p ...` keeps the environment and stays guarded.
 */

const CLAUDE = new Set(['claude', 'claude-code'])
/** Variables the hook needs (token, hook URL, guard settings) and Claude's config folder. */
const PROTECTED_ENV = /^(CLAUDEDECK_\w*|CLAUDE_CONFIG_DIR|\*)$/
/** The same, changed anywhere on the line (`unset CLAUDEDECK_MCP_TOKEN; claude ...`). */
const LINE_ENV =
  /\b(unset|export|declare|typeset|env\s+-u)\b[^;&|\n]{0,200}\b(CLAUDEDECK_\w+|CLAUDE_CONFIG_DIR)\b|\b(CLAUDEDECK_\w+|CLAUDE_CONFIG_DIR)\+?=|\benv:[\\/]?(CLAUDEDECK_\w*|CLAUDE_CONFIG_DIR)\b|SetEnvironmentVariable\s*\(\s*["'](CLAUDEDECK_\w*|CLAUDE_CONFIG_DIR)["']/i
/**
 * Environment changes on the line the guard cannot read: a sourced file, `eval` of unknown
 * text, a variable name held in a variable, a startup file for the shell that runs claude.
 */
const LINE_UNKNOWN_ENV =
  /(^|[;&|\n({]\s*|\b(then|do|else)\s+)(source|\.)\s+\S|\beval\s+[^;&|\n]*[$`]|\b(export|declare|typeset|readonly|local)\s+(-\w+\s+)*["']?\$|\b(BASH_ENV|ENV|ZDOTDIR)=|\b(set-item|si|new-item|ni|remove-item|ri|clear-item|cli|set-content|sc)\b[^;\n]*["']?env:[\\/]?["']?\$|SetEnvironmentVariable\s*\(\s*\$|\.ps1\b/i
/** Flags that replace the settings (and so the hooks) Claude loads. */
const SETTINGS_FLAGS = new Set(['--settings', '--setting-sources', '--bare'])
const BYPASS_FLAGS = new Set([
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions'
])
/** `claude config set|add|remove`: changes the account's settings. */
const CONFIG_CHANGE = /^(set|add|remove|rm|unset)$/

/** A flag that turns permission checks off or replaces the settings, with its value. */
function escapeFlag(cmd: Cmd): string | null {
  const texts = cmd.args.map((a) => a.text)
  for (let i = 0; i < texts.length; i++) {
    const [flag, glued] = texts[i].split(/=(.*)/s)
    if (BYPASS_FLAGS.has(flag) || SETTINGS_FLAGS.has(flag)) return flag
    if (flag === '--permission-mode') {
      const mode = glued ?? texts[i + 1] ?? ''
      if (/^bypasspermissions$/i.test(mode) || cmd.args[i + 1]?.opaque) return `${flag} ${mode}`
    }
  }
  return null
}

/** What makes this call escape the guard, or null. */
function escape(cmd: Cmd, input: string): string | null {
  const flag = escapeFlag(cmd)
  if (flag) return flag
  const env = cmd.env
  const changed = [...(env?.set ?? []), ...(env?.unset ?? [])].find((n) => PROTECTED_ENV.test(n))
  if (changed) return changed === '*' ? 'an emptied environment' : changed
  if (LINE_ENV.test(input)) return 'ClaudeDeck variables changed on the same line'
  return null
}

/** What may change Claude's environment unseen (asked about, not blocked), or null. */
function unknownEnvironment(cmd: Cmd, input: string): string | null {
  if (cmd.env?.set.includes(UNKNOWN_VAR)) return 'variables the guard cannot read'
  if (cmd.unknownArgs) return 'arguments the guard cannot read'
  if (LINE_UNKNOWN_ENV.test(input)) return 'an environment change the guard cannot read'
  return null
}

function claudeHits(cmd: Cmd, index: number, input: string): Hit[] {
  const sub = cmd.args[0]?.text
  if (sub === 'config' && CONFIG_CHANGE.test(cmd.args[1]?.text ?? ''))
    return [hit('sensitive.claudeSettings', cmd, index, { detail: 'claude config' })]
  const reason = escape(cmd, input)
  if (reason) return [hit('system.nestedClaudeEscape', cmd, index, { detail: reason })]
  const unknown = unknownEnvironment(cmd, input)
  return unknown
    ? [hit('system.nestedClaudeEscape', cmd, index, { cap: 'ask', detail: unknown })]
    : []
}

export const claudeRules: CmdDetector = (cmd, index, ctx) => {
  if (CLAUDE.has(cmd.name)) return claudeHits(cmd, index, ctx.input)
  // `$c --bare -p ...`: a command the guard cannot tell, given Claude's escape flags.
  if (/[$`]/.test(cmd.name)) {
    const flag = escapeFlag(cmd)
    return flag ? [hit('system.nestedClaudeEscape', cmd, index, { cap: 'ask', detail: flag })] : []
  }
  return []
}
