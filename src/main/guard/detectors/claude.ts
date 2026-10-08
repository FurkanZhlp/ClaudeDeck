import type { Cmd } from '../commands'
import { hit, type CmdDetector } from './types'

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
  /\b(unset|export|declare|typeset|env\s+-u)\b[^;&|\n]{0,200}\b(CLAUDEDECK_\w+|CLAUDE_CONFIG_DIR)\b|\b(CLAUDEDECK_\w+|CLAUDE_CONFIG_DIR)\+?=/
/** Flags that replace the settings (and so the hooks) Claude loads. */
const SETTINGS_FLAGS = new Set(['--settings', '--setting-sources', '--bare'])
const BYPASS_FLAGS = new Set([
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions'
])

/** What makes this call escape the guard, or null. */
function escape(cmd: Cmd, input: string): string | null {
  const texts = cmd.args.map((a) => a.text)
  for (let i = 0; i < texts.length; i++) {
    const [flag, glued] = texts[i].split(/=(.*)/s)
    if (BYPASS_FLAGS.has(flag) || SETTINGS_FLAGS.has(flag)) return flag
    if (flag === '--permission-mode') {
      const mode = glued ?? texts[i + 1] ?? ''
      if (/^bypasspermissions$/i.test(mode) || cmd.args[i + 1]?.opaque) return `${flag} ${mode}`
    }
  }
  const env = cmd.env
  const changed = [...(env?.set ?? []), ...(env?.unset ?? [])].find((n) => PROTECTED_ENV.test(n))
  if (changed) return changed === '*' ? 'an emptied environment' : changed
  if (LINE_ENV.test(input)) return 'ClaudeDeck variables changed on the same line'
  return null
}

export const claudeRules: CmdDetector = (cmd, index, ctx) => {
  if (!CLAUDE.has(cmd.name)) return []
  const reason = escape(cmd, ctx.input)
  return reason ? [hit('system.nestedClaudeEscape', cmd, index, { detail: reason })] : []
}
