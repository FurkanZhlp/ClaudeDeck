import { describe, expect, it } from 'vitest'
import { processStartTime } from './processIdentity'

describe('processStartTime', () => {
  it('reads ps lstart in the C locale with blanks collapsed', () => {
    const calls: string[][] = []
    const run = (file: string, args: string[]): string => {
      calls.push([file, ...args])
      return ' Fri Oct  9 02:53:46 2026\n'
    }
    expect(processStartTime(4242, 'darwin', run)).toBe('Fri Oct 9 02:53:46 2026')
    expect(calls).toEqual([['/bin/ps', '-o', 'lstart=', '-p', '4242']])
  })

  it('is null on Windows, for odd pids and when ps fails', () => {
    const fail = (): string => {
      throw new Error('no ps')
    }
    expect(processStartTime(4242, 'win32', () => 'x')).toBeNull()
    expect(processStartTime(0, 'darwin', () => 'x')).toBeNull()
    expect(processStartTime(4242, 'darwin', fail)).toBeNull()
    expect(processStartTime(4242, 'darwin', () => '  \n')).toBeNull()
  })
})
