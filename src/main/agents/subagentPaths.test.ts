import { posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  agentFiles,
  agentIdOfFile,
  isSafeId,
  projectDirCandidates,
  sessionTranscriptFile,
  subagentsDir,
  subagentsDirIn
} from './subagentPaths'

const SID = '11111111-2222-4333-8444-555555555555'

describe('subagentPaths', () => {
  it('derives the same project key as transcriptPath on macOS', () => {
    expect(subagentsDir('/cfg', '/Users/me/My App', SID, posix)).toBe(
      `/cfg/projects/-Users-me-My-App/${SID}/subagents`
    )
    expect(sessionTranscriptFile('/cfg/projects/k', SID, posix)).toBe(
      `/cfg/projects/k/${SID}.jsonl`
    )
  })

  it('handles Windows paths', () => {
    expect(subagentsDir('C:\\cfg', 'C:\\Users\\me\\app', SID, win32)).toBe(
      `C:\\cfg\\projects\\C--Users-me-app\\${SID}\\subagents`
    )
  })

  it('adds the real path variant only when it differs', () => {
    expect(projectDirCandidates('/cfg', '/link/app', posix, () => '/real/app')).toEqual([
      '/cfg/projects/-link-app',
      '/cfg/projects/-real-app'
    ])
    expect(projectDirCandidates('/cfg', '/same', posix, (p) => p)).toEqual(['/cfg/projects/-same'])
    expect(
      projectDirCandidates('/cfg', '/gone', posix, () => {
        throw new Error('ENOENT')
      })
    ).toEqual(['/cfg/projects/-gone'])
  })

  it('refuses unsafe ids', () => {
    expect(isSafeId('a0b55e88c38f7e4e0')).toBe(true)
    expect(isSafeId('../x')).toBe(false)
    expect(isSafeId('a'.repeat(65))).toBe(false)
    expect(isSafeId(42)).toBe(false)
    expect(() => agentFiles('/d', '../../etc')).toThrow()
    expect(() => subagentsDirIn('/d', 'a/b')).toThrow()
    expect(() => sessionTranscriptFile('/d', '..')).toThrow()
    expect(agentFiles('/d', 'abc', posix)).toEqual({
      transcript: '/d/agent-abc.jsonl',
      meta: '/d/agent-abc.meta.json'
    })
  })

  it('reads agent ids from file names', () => {
    expect(agentIdOfFile('agent-a12.jsonl')).toBe('a12')
    expect(agentIdOfFile('agent-a12.meta.json')).toBe('a12')
    expect(agentIdOfFile('agent-a12.json')).toBeNull()
    expect(agentIdOfFile('agent-.jsonl')).toBeNull()
    expect(agentIdOfFile('agent-a.b.jsonl')).toBeNull()
    expect(agentIdOfFile('notes.jsonl')).toBeNull()
  })
})
