import { describe, expect, it } from 'vitest'
import { pathSegments } from './paths'

describe('pathSegments', () => {
  it('splits POSIX and Windows paths', () => {
    expect(pathSegments('/Users/a/code/app')).toEqual(['Users', 'a', 'code', 'app'])
    expect(pathSegments('C:\\Users\\a\\code\\app\\')).toEqual(['C:', 'Users', 'a', 'code', 'app'])
    expect(pathSegments('C:/Users/a')).toEqual(['C:', 'Users', 'a'])
  })
})
