import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { windowsKillTree } from './processTree'

const child = (pid?: number): ChildProcess => ({ pid, kill: vi.fn() }) as unknown as ChildProcess

describe('windowsKillTree', () => {
  it('ends the whole tree with taskkill from System32', () => {
    const calls: [string, string[], SpawnOptions][] = []
    const kill = windowsKillTree((file, args, options) => {
      calls.push([file, args, options])
      return { on: () => undefined }
    }, 'D:\\Win')
    const target = child(42)
    kill(target, 'SIGTERM')
    expect(calls).toEqual([
      [
        'D:\\Win\\System32\\taskkill.exe',
        ['/PID', '42', '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' }
      ]
    ])
    expect(target.kill).not.toHaveBeenCalled()
  })

  it('falls back to the direct child when taskkill cannot start', () => {
    let onError: ((error: Error) => void) | undefined
    const kill = windowsKillTree(
      () => ({
        on: (_event, listener) => {
          onError = listener
        }
      }),
      'C:\\Windows'
    )
    const target = child(7)
    kill(target, 'SIGKILL')
    onError?.(new Error('ENOENT'))
    expect(target.kill).toHaveBeenCalledWith('SIGKILL')
  })

  it('kills the child itself without a pid', () => {
    const spawnFn = vi.fn()
    const target = child()
    windowsKillTree(spawnFn, 'C:\\Windows')(target, 'SIGTERM')
    expect(spawnFn).not.toHaveBeenCalled()
    expect(target.kill).toHaveBeenCalledWith('SIGTERM')
  })
})
