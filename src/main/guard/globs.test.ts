import { describe, expect, it } from 'vitest'
import { expandBraces, MAX_BRACE_WORDS } from './globs'

describe('expandBraces', () => {
  it('expands lists, ranges and nested groups like bash', () => {
    expect(expandBraces('~/{.ssh,x}')).toEqual(['~/.ssh', '~/x'])
    expect(expandBraces('/etc{,}')).toEqual(['/etc'])
    expect(expandBraces('a{1..3}')).toEqual(['a1', 'a2', 'a3'])
    expect(expandBraces('{a..c}')).toEqual(['a', 'b', 'c'])
    expect(expandBraces('x{a,{b,c}}y')).toEqual(['xay', 'xby', 'xcy'])
    expect(expandBraces('${HOME}/x')).toEqual(['${HOME}/x'])
    expect(expandBraces('{solo}')).toEqual(['{solo}'])
  })

  it('gives up on too many words', () => {
    expect(expandBraces(`{1..${MAX_BRACE_WORDS + 1}}`)).toBeNull()
    expect(expandBraces('{a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}')).toBeNull()
  })
})
