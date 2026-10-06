import { describe, expect, it } from 'vitest'
import { createTranslator } from '@shared/translate'
import { findingLines, friendlyFile, plainText, thinkingLine } from './friendly'

const en = createTranslator('en')
const at = 1

describe('friendlyFile', () => {
  it('names profile files without paths', () => {
    const profile = '/Users/me/Library/ClaudeDeck/profiles/a1'
    expect(friendlyFile(`${profile}/agents/frontend.md`, en)).toBe('frontend agent')
    expect(friendlyFile('skills/review/SKILL.md', en)).toBe('review skill')
    expect(friendlyFile(`${profile}/CLAUDE.md`, en)).toBe('instructions')
    expect(friendlyFile('settings.json', en)).toBe('settings')
    expect(friendlyFile('commands/ship.md', en)).toBe('ship command')
    expect(friendlyFile('claudedeck/guidelines.md', en)).toBe('ClaudeDeck guidelines')
    expect(friendlyFile('notes/todo.txt', en)).toBe('todo.txt')
  })
})

describe('thinkingLine', () => {
  it('prefers Claude status messages', () => {
    expect(thinkingLine({ type: 'status', message: 'Looking at agents', at }, false, en)).toBe(
      'Looking at agents'
    )
  })

  it('never shows search patterns or tool names', () => {
    const line = thinkingLine(
      { type: 'activity', tool: 'Grep', target: '^foo.*bar$', at },
      false,
      en
    )
    expect(line).toBe('Searching your profile')
    expect(
      thinkingLine({ type: 'activity', tool: 'Bash', target: 'rm -rf x', at }, false, en)
    ).not.toMatch(/rm|Bash/)
  })

  it('describes reads and edits with friendly names', () => {
    expect(
      thinkingLine({ type: 'activity', tool: 'Read', target: 'agents/qa.md', at }, false, en)
    ).toBe('Reading your qa agent')
    expect(
      thinkingLine({ type: 'activity', tool: 'MultiEdit', target: 'CLAUDE.md', at }, false, en)
    ).toBe('Applying the change to your instructions')
  })
})

describe('plainText', () => {
  it('flattens Markdown to one line', () => {
    expect(plainText('**Two** sections in `CLAUDE.md`\nsay [the same](https://x.y).')).toBe(
      'Two sections in CLAUDE.md say the same.'
    )
    expect(plainText('Keep my_var_name\n```diff\n-a\n```')).toBe('Keep my_var_name')
  })
})

describe('findingLines', () => {
  it('lists the summary, each issue and one line for the strengths', () => {
    const t = (key: string, vars?: Record<string, string | number>): string =>
      `${key}:${vars?.count ?? ''}`
    const lines = findingLines(
      { summary: '**Tidy** profile', strengths: ['a', 'b'], issues: ['Duplicate rules', ' '] },
      t
    )
    expect(lines).toEqual([
      { tone: 'summary', text: 'Tidy profile' },
      { tone: 'issue', text: 'Duplicate rules' },
      { tone: 'good', text: 'optimize.findings.good:2' }
    ])
    expect(findingLines({ summary: '', strengths: [], issues: [] }, t)).toEqual([])
  })
})
