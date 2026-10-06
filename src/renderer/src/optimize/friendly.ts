import type { Translate } from '@shared/translate'
import type { LiveEvent } from './runEvents'

const MARKDOWN_EXT = /\.(md|markdown)$/i

/** Splits a path (absolute or profile-relative, either slash) into its non-empty segments. */
const segmentsOf = (path: string): string[] => path.split(/[\\/]+/).filter(Boolean)

const lastIndexOf = (segments: string[], name: string): number =>
  segments.map((s) => s.toLowerCase()).lastIndexOf(name)

/**
 * A human name for a profile file: "frontend agent", "review skill", "instructions".
 * Never returns a path; unknown files fall back to their file name.
 */
export function friendlyFile(path: string, t: Translate): string {
  const segments = segmentsOf(path.trim())
  const base = segments.at(-1) ?? ''
  const lower = base.toLowerCase()
  const name = base.replace(MARKDOWN_EXT, '')
  const parent = (segments.at(-2) ?? '').toLowerCase()

  const skills = lastIndexOf(segments, 'skills')
  if (skills !== -1 && skills < segments.length - 1) {
    return t('optimize.names.skill', { name: segments[skills + 1].replace(MARKDOWN_EXT, '') })
  }
  if (lower === 'claude.md') return t('optimize.names.instructions')
  if (lower === 'guidelines.md' && parent === 'claudedeck') return t('optimize.names.guidelines')
  if (lower.startsWith('settings') && lower.endsWith('.json')) return t('optimize.names.settings')
  if (parent === 'agents') return t('optimize.names.agent', { name })
  if (parent === 'commands') return t('optimize.names.command', { name })
  if (parent === 'output-styles') return t('optimize.names.outputStyle', { name })
  if (parent === 'instructions') return t('optimize.names.instruction', { name })
  return name ? t('optimize.names.file', { name: base }) : t('optimize.names.profile')
}

const READ_TOOLS = new Set(['read', 'notebookread'])
const SEARCH_TOOLS = new Set(['grep', 'glob', 'ls', 'search'])
const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'notebookedit'])

/**
 * One short, non-technical line for the latest thing Claude did: its own status message, or
 * a phrase derived from the tool call. Search patterns and paths are never shown.
 */
export function thinkingLine(latest: LiveEvent | null, starting: boolean, t: Translate): string {
  if (!latest) return t(starting ? 'optimize.thinking.starting' : 'optimize.thinking.working')
  if (latest.type === 'status') return latest.message
  const tool = latest.tool.toLowerCase()
  const target = latest.target?.trim()
  if (READ_TOOLS.has(tool)) {
    return target
      ? t('optimize.thinking.read', { name: friendlyFile(target, t) })
      : t('optimize.thinking.working')
  }
  if (SEARCH_TOOLS.has(tool)) return t('optimize.thinking.search')
  if (EDIT_TOOLS.has(tool)) {
    return target
      ? t('optimize.thinking.edit', { name: friendlyFile(target, t) })
      : t('optimize.thinking.editGeneric')
  }
  return t('optimize.thinking.working')
}

/**
 * Markdown reduced to one line of plain text for glanceable rows: code blocks, link targets,
 * emphasis markers, headings and list bullets are dropped, whitespace is collapsed.
 */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~|\*)(\S(?:.*?\S)?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
}

export type FindingTone = 'summary' | 'issue' | 'good'

export interface FindingLine {
  tone: FindingTone
  text: string
}

/**
 * Findings as single lines shown one after another: the summary, each issue, then one line
 * that counts the strengths. Empty parts are left out.
 */
export function findingLines(
  findings: { summary: string; strengths: string[]; issues: string[] },
  t: Translate
): FindingLine[] {
  const lines: FindingLine[] = []
  const summary = plainText(findings.summary)
  if (summary) lines.push({ tone: 'summary', text: summary })
  for (const issue of findings.issues) {
    const text = plainText(issue)
    if (text) lines.push({ tone: 'issue', text })
  }
  const good = findings.strengths.length
  if (good > 0) lines.push({ tone: 'good', text: t('optimize.findings.good', { count: good }) })
  return lines
}
