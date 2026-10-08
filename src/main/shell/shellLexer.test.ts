import { describe, expect, it } from 'vitest'
import { lex, lexInfo, substitutionBodies } from './shellLexer'

const texts = (input: string): string[][] => lex(input).map((s) => s.words.map((w) => w.text))

describe('lex', () => {
  it('splits on list, pipe and background operators and newlines', () => {
    expect(texts('a 1 && b || c; d | e |& f & g\nh')).toEqual([
      ['a', '1'],
      ['b'],
      ['c'],
      ['d'],
      ['e'],
      ['f'],
      ['g'],
      ['h']
    ])
  })

  it('treats subshell and group parens as boundaries', () => {
    expect(texts('(cd web && pnpm test)')).toEqual([
      ['cd', 'web'],
      ['pnpm', 'test']
    ])
  })

  it('removes quotes and escapes and marks quoted words', () => {
    const [segment] = lex(`echo 'a b' "c \\"d\\"" e\\ f $'g\\nh' plain`)
    expect(segment.words.map((w) => w.text)).toEqual([
      'echo',
      'a b',
      'c "d"',
      'e f',
      'g\nh',
      'plain'
    ])
    expect(segment.words.map((w) => w.quoted)).toEqual([false, true, true, true, true, false])
  })

  it('keeps command substitutions opaque and does not split on their contents', () => {
    const [segment] = lex('echo $(pnpm test; ls) `pytest` "x $(a && b)" <(go test)')
    expect(segment.words.map((w) => w.text)).toEqual([
      'echo',
      '$(pnpm test; ls)',
      '`pytest`',
      'x $(a && b)',
      '<(go test)'
    ])
    expect(segment.words.slice(1).every((w) => w.opaque)).toBe(true)
    expect(lex('echo $(pnpm test; ls)')).toHaveLength(1)
  })

  it('finds the end of a substitution containing a heredoc with apostrophes', () => {
    const input = [
      `git commit -m "$(cat <<'EOF'`,
      `Fix the user's (odd) bug`,
      `EOF`,
      `)" && pnpm test`
    ].join('\n')
    expect(texts(input).at(-1)).toEqual(['pnpm', 'test'])
    expect(texts(input)).toHaveLength(2)
  })

  it('skips heredoc bodies, including <<- with tabs', () => {
    expect(texts('cat <<EOF > x.sh\npnpm test\nEOF\necho done')).toEqual([
      ['cat'],
      ['echo', 'done']
    ])
    expect(texts("cat <<-'END'\n\tpytest\n\tEND\nls")).toEqual([['cat'], ['ls']])
  })

  it('drops redirections and their targets, including fd numbers', () => {
    expect(texts('pnpm test 2>&1 > out.log < in.txt &>> all.log')).toEqual([['pnpm', 'test']])
  })

  it('drops comments and joins continued lines', () => {
    expect(texts('pnpm \\\n test # run it')).toEqual([['pnpm', 'test']])
  })

  it('detects assignments only when the name part is unquoted', () => {
    const [segment] = lex(`CI=1 FOO="a b" "BAR=1" X=$(y) cmd`)
    expect(segment.words.map((w) => w.assignable)).toEqual([true, true, false, true, false])
  })

  it('survives unterminated quotes and substitutions', () => {
    expect(texts(`echo "abc`)).toEqual([['echo', 'abc']])
    expect(texts(`echo 'abc`)).toEqual([['echo', 'abc']])
    expect(texts(`echo $(abc`)).toEqual([['echo', '$(abc']])
  })

  it('keeps the raw source of each segment', () => {
    expect(lex('cd x && pnpm test 2>&1').map((s) => s.raw)).toEqual(['cd x', 'pnpm test 2>&1'])
  })

  it('keeps redirection targets and the operator after each segment', () => {
    const segments = lex('echo a > out.txt 2>&1 && cat <in | tee -a log; x &>> all')
    expect(segments.map((s) => s.op)).toEqual(['&&', '|', ';', ''])
    expect(segments[0].redirects.map((r) => [r.op, r.target.text])).toEqual([
      ['>', 'out.txt'],
      ['>&', '1']
    ])
    expect(segments[1].redirects.map((r) => [r.op, r.target.text])).toEqual([['<', 'in']])
    expect(segments[3].redirects.map((r) => [r.op, r.target.text])).toEqual([['&>>', 'all']])
  })

  it('keeps a segment made of a redirection only', () => {
    expect(lex('> ~/.zshrc').map((s) => [s.words.length, s.redirects[0]?.target.text])).toEqual([
      [0, '~/.zshrc']
    ])
  })
})

describe('substitutionBodies', () => {
  it('returns the inner text of each substitution', () => {
    expect(substitutionBodies('$(curl -s x | sh)')).toEqual(['curl -s x | sh'])
    expect(substitutionBodies('a $(b $(c)) `d \\` e` <(f) >(g)')).toEqual([
      'b $(c)',
      'd ` e',
      'f',
      'g'
    ])
  })

  it('skips arithmetic and survives unterminated input', () => {
    expect(substitutionBodies('$((1 + 2))')).toEqual([])
    expect(substitutionBodies('$(rm -rf x')).toEqual(['rm -rf x'])
    expect(substitutionBodies('`id')).toEqual(['id'])
  })
})

describe('lex: escapes, heredoc bodies and limits', () => {
  it('applies ANSI-C escapes like bash', () => {
    const [segment] = lex("$'\\x72m' $'\\162\\155' $'\\u0072m' $'a\\'b' $'\\cA'")
    expect(segment.words.map((w) => w.text)).toEqual(['rm', 'rm', 'rm', "a'b", '\x01'])
  })

  it('keeps heredoc bodies on their redirection', () => {
    const [segment] = lex('sh <<EOF\nrm x\nEOF\necho after')
    expect(segment.redirects[0].heredoc).toEqual({ body: 'rm x', expands: true })
    expect(lex("cat <<'X'\n$(y)\nX")[0].redirects[0].heredoc).toEqual({
      body: '$(y)',
      expands: false
    })
    expect(lex('cat <<-E\n\tz\n\tE')[0].redirects[0].heredoc?.body).toBe('z')
  })

  it('reports input cut short by nesting', () => {
    expect(lexInfo('echo $(a $(b))').truncated).toBe(false)
    expect(lexInfo(`echo ${'$('.repeat(40)}`).truncated).toBe(true)
  })
})
