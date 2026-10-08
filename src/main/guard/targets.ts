import { hasFlag, isFlag, positionals, type Arg, type Cmd } from './commands'

/**
 * What a command deletes, writes and reads, by command name. Covers the usual POSIX tools,
 * PowerShell cmdlets and cmd.exe built-ins; anything else has no targets.
 */

const set = (...items: string[]): ReadonlySet<string> => new Set(items)

export interface DeleteTargets {
  targets: Arg[]
  recursive: boolean
}

/** PowerShell parameter `-Name` given in any unambiguous prefix (`-r`, `-rec`, `-Recurse`). */
export function psParam(args: Arg[], full: string, min = 1): boolean {
  const lower = full.toLowerCase()
  return args.some((a) => {
    if (a.quoted || !a.text.startsWith('-')) return false
    const name = a.text.slice(1).split(':')[0].toLowerCase()
    return name.length >= min && lower.startsWith(name)
  })
}

/** Value of a PowerShell parameter (`-Path x`, `-Path:x`). */
export function psValue(args: Arg[], full: string, min = 1): Arg | null {
  const lower = full.toLowerCase()
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.quoted || !a.text.startsWith('-')) continue
    const [name, value] = a.text.slice(1).split(/:(.*)/s)
    if (name.length < min || !lower.startsWith(name.toLowerCase())) continue
    if (value !== undefined && value !== '') return { ...a, text: value }
    return args[i + 1] ?? null
  }
  return null
}

const PS_SWITCHES = set(
  'recurse',
  'force',
  'whatif',
  'confirm',
  'verbose',
  'debug',
  'passthru',
  'nonewline',
  'append',
  'noclobber'
)

/** PowerShell positional arguments: parameters and their values dropped. */
export function psPositionals(args: Arg[], valueParams: readonly string[]): Arg[] {
  const out: Arg[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (!a.quoted && /^-[A-Za-z]/.test(a.text)) {
      const name = a.text.slice(1).split(':')[0].toLowerCase()
      if (a.text.includes(':')) continue
      const takesValue =
        valueParams.some((p) => p.startsWith(name)) && ![...PS_SWITCHES].some((s) => s === name)
      if (takesValue) i++
      continue
    }
    out.push(a)
  }
  return out
}

const PS_PATH_PARAMS = [
  'path',
  'literalpath',
  'destination',
  'value',
  'filepath',
  'include',
  'exclude',
  'filter',
  'encoding',
  'itemtype',
  'name',
  'newname',
  'stream'
]

/** A PowerShell array argument (`a,b`) as its items. */
const psItems = (a: Arg): Arg[] =>
  a.opaque || !a.text.includes(',')
    ? [a]
    : a.text
        .split(',')
        .filter((t) => t.trim())
        .map((text) => ({ ...a, text: text.trim() }))

function psPaths(args: Arg[], ...params: string[]): Arg[] {
  const named = params.map((p) => psValue(args, p, 2)).filter((a): a is Arg => !!a)
  return (named.length ? named : psPositionals(args, PS_PATH_PARAMS).slice(0, 1)).flatMap(psItems)
}

/** Files and folders a command deletes. */
export function deleteTargets(cmd: Cmd): DeleteTargets | null {
  const { name, args } = cmd
  switch (name) {
    case 'rm':
    case 'srm':
      if (cmd.shell === 'powershell') break
      return { targets: positionals(args), recursive: hasFlag(args, 'rR', '--recursive') }
    case 'rmdir':
    case 'unlink':
      if (cmd.shell === 'powershell') break
      return { targets: positionals(args), recursive: name === 'rmdir' }
    case 'shred':
      return {
        targets: positionals(args, set('-n', '--iterations', '-s', '--size')),
        recursive: false
      }
    case 'rimraf':
      return { targets: positionals(args), recursive: true }
    case 'rd':
      return {
        targets: args.filter((a) => !a.text.startsWith('/')),
        recursive: args.some((a) => /^\/s$/i.test(a.text))
      }
    case 'del':
      return {
        targets: args.filter((a) => !a.text.startsWith('/')),
        recursive: args.some((a) => /^\/s$/i.test(a.text))
      }
  }
  if (
    name === 'remove-item' ||
    (cmd.shell === 'powershell' && ['rm', 'rmdir', 'unlink'].includes(name))
  ) {
    const named = [psValue(args, 'path', 1), psValue(args, 'literalpath', 1)].filter(
      (a): a is Arg => !!a
    )
    const targets = (named.length ? named : psPositionals(args, PS_PATH_PARAMS)).flatMap(psItems)
    return { targets, recursive: psParam(args, 'recurse', 1) }
  }
  return null
}

const OUTPUT_REDIRECT = /^(>|>>|>\||&>|&>>|<>|>&|\d?>>?)$/

/** Output redirection targets (fd duplications such as `2>&1` and `/dev/null` excluded). */
function redirectWrites(cmd: Cmd): Arg[] {
  return cmd.redirects
    .filter((r) => OUTPUT_REDIRECT.test(r.op) && !/^(\d+|-)$/.test(r.target.text))
    .map((r) => r.target)
}

/** Files and folders a command writes, moves away, or changes the permissions of. */
export function writeTargets(cmd: Cmd): Arg[] {
  const { name, args } = cmd
  const out = redirectWrites(cmd)
  const last = (list: Arg[]): Arg[] => (list.length ? [list[list.length - 1]] : [])
  if (cmd.shell === 'powershell') {
    switch (name) {
      case 'set-content':
      case 'add-content':
      case 'clear-content':
      case 'out-file':
      case 'new-item':
      case 'set-item':
      case 'set-itemproperty':
      case 'rename-item':
      case 'set-acl':
        return [...out, ...psPaths(args, 'path', 'literalpath', 'filepath')]
      case 'copy-item':
      case 'move-item': {
        const listed = psPositionals(args, PS_PATH_PARAMS)
        const dest = psValue(args, 'destination', 1) ?? listed[1]
        const sources = name === 'move-item' ? psPaths(args, 'path', 'literalpath') : []
        return [...out, ...sources, ...(dest ? [dest] : [])]
      }
    }
  }
  switch (name) {
    case 'tee':
      return [...out, ...positionals(args)]
    case 'cp':
    case 'install':
    case 'ln':
    case 'rsync':
    case 'scp':
    case 'ditto': {
      const t = args.findIndex((a) => a.text === '-t' || a.text === '--target-directory')
      if (t >= 0 && args[t + 1]) return [...out, args[t + 1]]
      const values =
        name === 'install'
          ? set('-m', '-o', '-g', '--mode', '--owner', '--group')
          : name === 'rsync'
            ? set('-e', '--rsh', '--exclude', '--include', '--filter', '-f')
            : set('-S', '--suffix')
      return [...out, ...last(positionals(args, values))]
    }
    case 'mv':
      return [...out, ...positionals(args, set('-S', '--suffix', '-t'))]
    case 'touch':
    case 'mkdir':
    case 'truncate':
      return [
        ...out,
        ...positionals(args, set('-s', '--size', '-r', '--reference', '-m', '--mode', '-d', '-t'))
      ]
    case 'chmod':
    case 'chown':
    case 'chgrp':
    case 'chflags':
    case 'setfacl':
    case 'xattr':
      return [
        ...out,
        ...positionals(args, set('--reference', '-m', '-x', '-w', '-d', '-M')).slice(
          name === 'xattr' ? 0 : 1
        )
      ]
    case 'sed':
    case 'perl':
    case 'ruby':
      if (!args.some((a) => /^-[A-Za-z]*i/.test(a.text) || a.text.startsWith('--in-place')))
        return out
      // The script is the first positional unless given with -e / -f.
      return [
        ...out,
        ...positionals(args, set('-e', '-f', '--expression', '--file', '-E')).slice(
          args.some((a) => a.text === '-e' || a.text === '-f') ? 0 : 1
        )
      ]
    case 'dd': {
      const of = args.find((a) => a.text.startsWith('of='))
      return of ? [...out, { ...of, text: of.text.slice(3) }] : out
    }
    case 'ssh-keygen': {
      const f = args.findIndex((a) => a.text === '-f')
      return f >= 0 && args[f + 1] && !args.some((a) => /^-[lyBeiF]$/.test(a.text))
        ? [...out, args[f + 1]]
        : out
    }
    case 'copy':
    case 'move':
      return [...out, ...last(args.filter((a) => !a.text.startsWith('/')))]
    case 'curl':
      return [...out, ...flagValues(args, ['-o', '--output'], ['--output'])]
    case 'wget':
      return [...out, ...flagValues(args, ['-O', '--output-document'], ['--output-document'])]
    case 'tar':
    case 'bsdtar':
    case 'gtar': {
      // Extracting into a folder writes there.
      const extract = args.some((a) => a.text === '--extract' || /^-?[A-Za-z]*x/.test(a.text))
      return extract ? [...out, ...flagValues(args, ['-C', '--directory'], ['--directory'])] : out
    }
    case 'unzip':
      return [...out, ...flagValues(args, ['-d'], [])]
  }
  return out
}

/** Values of `-o x`, `--output x`, `--output=x` (and `-ox`) style options. */
function flagValues(args: Arg[], flags: string[], longEq: string[]): Arg[] {
  const out: Arg[] = []
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text
    if (flags.includes(t) && args[i + 1]) out.push(args[++i])
    else {
      const long = longEq.find((f) => t.startsWith(`${f}=`))
      if (long) out.push({ ...args[i], text: t.slice(long.length + 1) })
      else if (
        /^-[A-Za-z]$/.test(flags[0]) &&
        t.startsWith(flags[0]) &&
        t.length > 2 &&
        !t.startsWith('--')
      )
        out.push({ ...args[i], text: t.slice(2) })
    }
  }
  return out
}

/** Folders a command copies, archives or searches recursively (for secret folders). */
export function recursiveReads(cmd: Cmd): { sources: Arg[]; parents: boolean } | null {
  const { name, args } = cmd
  if (cmd.shell !== 'posix') return null
  switch (name) {
    case 'cp':
    case 'scp':
      if (!hasFlag(args, name === 'cp' ? 'rRa' : 'r', '--recursive', '--archive')) return null
      return {
        sources: positionals(args, set('-t', '-S', '-P', '-i', '-o', '-F')).slice(0, -1),
        parents: true
      }
    case 'rsync':
    case 'ditto':
      return {
        sources: positionals(
          args,
          set('-e', '--rsh', '--exclude', '--include', '--filter', '-f')
        ).slice(0, -1),
        parents: true
      }
    case 'tar':
    case 'bsdtar':
    case 'gtar': {
      const create = args.some((a) => a.text === '--create' || /^-?[A-Za-z]*c/.test(a.text))
      if (!create) return null
      // Old style option letters (`tar czf out.tgz dir`) come first; they are not folders.
      return {
        sources: positionals(args, set('-f', '--file', '-C', '--directory', '-T', '-X')),
        parents: true
      }
    }
    case 'zip':
    case '7z':
    case '7za':
      return {
        sources: positionals(args, set('-x', '-i', '-P')).slice(name === 'zip' ? 1 : 2),
        parents: true
      }
    case 'grep':
    case 'egrep':
    case 'rg':
    case 'ag':
      if (name !== 'rg' && name !== 'ag' && !hasFlag(args, 'rR', '--recursive')) return null
      return {
        sources: positionals(
          args,
          set('-e', '-f', '-A', '-B', '-C', '-m', '-g', '--glob', '-t')
        ).slice(1),
        parents: false
      }
  }
  return null
}

/** `mv` sources: moving a folder away removes it from where it was. */
export function moveSources(cmd: Cmd): Arg[] {
  if (cmd.name === 'mv' && cmd.shell !== 'powershell') {
    const list = positionals(cmd.args, set('-S', '--suffix', '-t'))
    return list.slice(0, -1)
  }
  if (cmd.name === 'move-item') return psPaths(cmd.args, 'path', 'literalpath')
  return []
}

const READERS = set(
  'cat',
  'less',
  'more',
  'head',
  'tail',
  'bat',
  'nl',
  'tac',
  'base64',
  'xxd',
  'od',
  'hexdump',
  'strings',
  'gpg',
  'pbcopy',
  'zip',
  'tar',
  '7z',
  'type',
  'get-content',
  'nc',
  'ncat'
)

/** Files a command reads or copies (for private keys and credential files). */
export function readTargets(cmd: Cmd): Arg[] {
  const { name, args } = cmd
  const inputs = cmd.redirects.filter((r) => r.op === '<').map((r) => r.target)
  const at = args
    .filter((a) => /^@[^@]/.test(a.text) || /=@[^@]/.test(a.text))
    .map((a) => ({ ...a, text: a.text.slice(a.text.indexOf('@') + 1) }))
  if (READERS.has(name)) {
    if (cmd.shell === 'powershell' || name === 'get-content')
      return [...inputs, ...psPaths(args, 'path', 'literalpath')]
    return [
      ...inputs,
      ...positionals(args, set('-n', '-c', '--lines', '--bytes', '-o', '-r', '-f', '-C', '-x'))
    ]
  }
  switch (name) {
    case 'cp':
    case 'scp':
    case 'rsync':
    case 'ditto':
    case 'copy-item':
    case 'copy': {
      const list =
        cmd.shell === 'powershell'
          ? psPaths(args, 'path', 'literalpath')
          : positionals(args).filter((a) => !a.text.startsWith('/') || cmd.shell !== 'cmd')
      return [...inputs, ...(cmd.shell === 'powershell' ? list : list.slice(0, -1))]
    }
    case 'grep':
    case 'rg':
    case 'awk':
    case 'sed':
      return [
        ...inputs,
        ...positionals(args, set('-e', '-f', '-F', '-v', '-A', '-B', '-C', '-m')).slice(1)
      ]
    case 'openssl': {
      const i = args.findIndex((a) => a.text === '-in')
      return [...inputs, ...at, ...(i >= 0 && args[i + 1] ? [args[i + 1]] : [])]
    }
    case 'curl':
    case 'wget':
    case 'http':
    case 'https': {
      const upload = args.findIndex(
        (a) => a.text === '-T' || a.text === '--upload-file' || a.text === '--post-file'
      )
      return [...inputs, ...at, ...(upload >= 0 && args[upload + 1] ? [args[upload + 1]] : [])]
    }
  }
  return [...inputs, ...at]
}

/** Flag args that are not paths (helps detectors skip `-` values). */
export const notFlag = (a: Arg): boolean => !isFlag(a)
