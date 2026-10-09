import { findInfo, hasFlag, MAX_CODE, positionals, type Arg, type Cmd } from '../commands'
import { expandBraces, globRules, hasGlob, segmentMatches } from '../globs'
import { CHANGE_API, codeClaudePaths, codePaths, inlineCode, READ_API } from '../inlineCode'
import {
  globCandidates,
  claudeDeckFolder,
  inClaudeControlDir,
  inSecretDir,
  isGuardKey,
  isCriticalDir,
  isSecretFile,
  projectClaudeDir,
  protectedInside,
  protectedTail,
  readsSecretDir,
  writeRule
} from '../locations'
import { globBase, isRoot, canon, resolveCollapsed, resolvePath, segments } from '../paths'
import {
  copyDestinations,
  deleteTargets,
  moveSources,
  readTargets,
  recursiveReads,
  writeTargets
} from '../targets'
import { hit, type CmdDetector, type DetectContext, type Hit } from './types'

/**
 * Deletes, writes, moves, permission changes and secret reads, for the disk category (critical
 * folders) and the sensitive category (protected files). The working folder of each command is
 * its own (after `cd`); "the project folder and its parents" is always the session's folder.
 */

/** Text before the first variable or substitution: what is known of an opaque path. */
const literalPrefix = (text: string): string => text.split(/[$%`]|^~[+-]/)[0]

function resolveIn(text: string, cmd: Cmd, ctx: DetectContext): string | null {
  return resolvePath(text, { ...ctx, cwd: cmd.cwd, values: cmd.vars })
}

/** A target after brace expansion (POSIX shells only); null when it expands to too many. */
function expanded(target: Arg, cmd: Cmd): Arg[] | null {
  if (cmd.shell !== 'posix' || target.opaque || !target.text.includes('{')) return [target]
  const words = expandBraces(target.text)
  return words && words.map((text) => ({ ...target, text }))
}

const UNKNOWN_DETAIL = 'the target could not be told'
const BRACE_DETAIL = 'it expands to too many paths to check'

/**
 * A changed path that cannot be told (`> "$X/.ssh/authorized_keys"`): what follows the unknown
 * part is compared with protected names (denied when it names one); otherwise the call is
 * asked about when `askUnknown`.
 */
function unknownTargetHits(text: string, cmd: Cmd, index: number, askUnknown: boolean): Hit[] {
  const rule = protectedTail(text)
  if (rule) return [hit(rule, cmd, index, { detail: UNKNOWN_DETAIL })]
  return askUnknown
    ? [hit('disk.uncheckable', cmd, index, { cap: 'ask', detail: UNKNOWN_DETAIL })]
    : []
}

const PS_NON_FILE_DRIVE = /^["']?(env|variable|function|alias|cert|hk(lm|cu)|wsman):/i

/** Unknown because of a variable or substitution (not only an unknown working folder). */
const hasVariable = (a: Arg): boolean => a.opaque || /[$%`]|^~[+-]/.test(a.text)

/** Hits for deleting `target`; `recursive` when folders go with everything inside them. */
function deleteHits(
  target: Arg,
  recursive: boolean,
  cmd: Cmd,
  index: number,
  ctx: DetectContext
): Hit[] {
  const unknown = (): Hit[] => {
    if (!recursive) return unknownTargetHits(target.text, cmd, index, false)
    // `"${DIR:-}/"` or `"$EMPTY/"` may well be `/`.
    const collapsed = target.opaque ? null : resolveCollapsed(target.text, { ...ctx, cwd: cmd.cwd })
    if (collapsed && isCriticalDir(collapsed, ctx)) {
      return [
        hit('disk.systemDelete', cmd, index, {
          detail: 'an empty variable would make it a system path'
        })
      ]
    }
    const prefix = literalPrefix(target.text)
    const base = prefix ? resolveIn(prefix.replace(/[^\\/]*$/, '') || '.', cmd, ctx) : null
    if (prefix && base && !isCriticalDir(base, ctx)) return []
    return [hit('disk.systemDelete', cmd, index, { cap: 'ask', detail: UNKNOWN_DETAIL })]
  }
  if (target.opaque) return unknown()
  const variants = expanded(target, cmd)
  if (!variants) return [hit('disk.uncheckable', cmd, index, { detail: BRACE_DETAIL })]
  if (variants.length > 1 || variants[0].text !== target.text) {
    return variants.flatMap((v) => deleteHits(v, recursive, cmd, index, ctx))
  }

  // A variable that cannot be told makes the whole target unknown, glob or not (`rm -rf $*`).
  if (/[$%`]|^~[+-]/.test(target.text) && resolveIn(target.text, cmd, ctx) === null) {
    return unknown()
  }
  const glob = globBase(target.text)
  if (glob) return globDeleteHits(target, glob, recursive, cmd, index, ctx, unknown)

  const path = resolveIn(target.text, cmd, ctx)
  if (path === null) return unknown()
  if (recursive && isCriticalDir(path, ctx)) return [hit('disk.systemDelete', cmd, index)]
  if (recursive && projectClaudeDir(path, ctx)) return [hit('sensitive.claudeSettings', cmd, index)]
  const rule = writeRule(path, ctx)
  if (rule) return [hit(rule, cmd, index)]
  if (recursive) {
    const inside = protectedInside(path, ctx)
    if (inside) return [hit(inside, cmd, index)]
  }
  return []
}

/** `rm -rf ~/D*`, `rm -rf /U*\/dev`, `rm ~/.ss?/id_rsa`: what the glob can reach. */
function globDeleteHits(
  target: Arg,
  glob: { base: string; all: boolean },
  recursive: boolean,
  cmd: Cmd,
  index: number,
  ctx: DetectContext,
  unknown: () => Hit[]
): Hit[] {
  const base = resolveIn(glob.base, cmd, ctx)
  if (base === null) return unknown()
  if (glob.all && isCriticalDir(base, ctx)) {
    return [hit('disk.systemDelete', cmd, index, recursive ? {} : { cap: 'ask' })]
  }
  const path = resolveIn(target.text, cmd, ctx)
  const rules = path ? globRules(path, recursive, globCandidates(ctx), ctx.os) : []
  if (rules.length) return rules.map((rule) => hit(rule, cmd, index))
  const rule = writeRule(base, ctx)
  if (rule) return [hit(rule, cmd, index)]
  // A recursive glob right in the root or the home folder could reach anything there.
  if (recursive && (isRoot(base, ctx.os) || canon(base, ctx.os) === canon(ctx.home, ctx.os))) {
    return [
      hit('disk.systemDelete', cmd, index, { cap: 'ask', detail: 'a pattern in a system folder' })
    ]
  }
  return []
}

/**
 * Rules of a written path, globs and braces included. `copy`: the command copies, moves or
 * extracts files there (a project's `.claude` folder as the destination is denied).
 */
function writeHits(target: Arg, cmd: Cmd, index: number, ctx: DetectContext, copy = false): Hit[] {
  // PowerShell drives that are not files (`Set-Item env:X`, `variable:`, `function:`).
  if (cmd.shell === 'powershell' && PS_NON_FILE_DRIVE.test(target.text)) return []
  if (target.opaque) return unknownTargetHits(target.text, cmd, index, true)
  const variants = expanded(target, cmd)
  if (!variants) return [hit('disk.uncheckable', cmd, index, { detail: BRACE_DETAIL })]
  const hits: Hit[] = []
  for (const v of variants) {
    const path = resolveIn(v.text, cmd, ctx)
    if (!path) {
      hits.push(...unknownTargetHits(v.text, cmd, index, hasVariable(v)))
      continue
    }
    const rules = hasGlob(v.text) ? globRules(path, false, globCandidates(ctx), ctx.os) : []
    const rule = writeRule(path, ctx)
    for (const r of rule ? [rule, ...rules] : rules) hits.push(hit(r, cmd, index))
    if (copy && projectClaudeDir(path, ctx)) hits.push(hit('sensitive.claudeSettings', cmd, index))
  }
  return hits
}

/** The guard key of an account, named directly or by a glob (`claudedeck/guard.k*`, `*`). */
function namesGuardKey(path: string, glob: boolean, ctx: DetectContext): boolean {
  if (isGuardKey(path, ctx)) return true
  if (!glob) return false
  const parts = segments(path, ctx.os)
  const name = parts[parts.length - 1] ?? ''
  const parent = parts[parts.length - 2] ?? ''
  if (name === '**') return parts.some((p) => segmentMatches(p, 'claudedeck'))
  return segmentMatches(name, 'guard.key') && segmentMatches(parent, 'claudedeck')
}

/**
 * Brace expansion only rearranges the characters of a word: without a glob or a variable, it
 * can only name the key when every letter of `guard.key` is in it (keeps long inputs fast).
 */
const mayNameKey = (text: string): boolean => {
  if (/[*?[$%`]/.test(text)) return true
  const lower = text.toLowerCase()
  return [...'guardkey'].every((c) => lower.includes(c))
}

/** Texts of an argument that may be a path: as given, after `opt=` and after `@`. */
function pathTexts(a: Arg): string[] {
  const out = [a.text]
  const eq = a.text.indexOf('=')
  if (eq > 0) out.push(a.text.slice(eq + 1))
  const at = a.text.indexOf('@')
  if (at >= 0 && a.text[at + 1] !== '@') out.push(a.text.slice(at + 1))
  return out
}

/**
 * Any argument of any command that names an account's guard key: nothing but the hook needs
 * it, so reading, copying or changing it is blocked whatever the command.
 */
function guardKeyHits(cmd: Cmd, index: number, ctx: DetectContext): Hit[] {
  const words = [...cmd.args, ...cmd.redirects.map((r) => r.target)]
  for (const a of words) {
    if (a.opaque) continue
    for (const text of pathTexts(a)) {
      if (!mayNameKey(text)) continue
      for (const v of expandBraces(text) ?? [text]) {
        const path = resolveIn(v, cmd, ctx)
        if (path && namesGuardKey(path, hasGlob(v), ctx))
          return [hit('sensitive.claudedeck', cmd, index)]
      }
    }
  }
  return []
}

/** Quoted strings scanned for the guard key per input (PowerShell `[IO.File]::ReadAllText("...")`). */
const MAX_LITERALS = 256

/**
 * Quoted strings anywhere in the input that name the guard key: covers forms no parser
 * follows (.NET calls, inline code of any language).
 */
export function literalGuardKeyHits(input: string, ctx: DetectContext): Hit[] {
  if (!/guard\.|claudedeck/i.test(input)) return []
  let n = 0
  for (const m of input.matchAll(/(["'])([^"'\n]{1,4096})\1/g)) {
    if (++n > MAX_LITERALS) break
    const text = m[2]
    if (!/guard|claudedeck|\*|\?/i.test(text)) continue
    const path = resolvePath(text, ctx)
    if (path && namesGuardKey(path, hasGlob(text), ctx))
      return [{ ruleId: 'sensitive.claudedeck', excerpt: input }]
  }
  return []
}

const READ_COMMANDS = new Set([
  'cp',
  'scp',
  'rsync',
  'cat',
  'less',
  'more',
  'head',
  'tail',
  'base64',
  'xxd',
  'od',
  'hexdump',
  'strings',
  'grep',
  'awk',
  'sed',
  'diff',
  'curl',
  'nc',
  'tar',
  'zip',
  'openssl',
  'gpg',
  'pbcopy',
  'tee',
  'dd',
  'python',
  'python3',
  'node',
  'perl',
  'ruby'
])

/** `find ~ -name id_rsa -exec cat {} \;`: a reader run on the secret files a find selects. */
function findReadHits(cmd: Cmd, index: number, ctx: DetectContext): Hit[] {
  if (cmd.name !== 'find') return []
  const execs: string[] = []
  for (let i = 0; i < cmd.args.length; i++) {
    if (/^-(exec|execdir|ok|okdir)$/.test(cmd.args[i].text) && cmd.args[i + 1])
      execs.push(cmd.args[i + 1].text)
  }
  if (!execs.some((e) => READ_COMMANDS.has(e.replace(/^.*[\\/]/, '').toLowerCase()))) return []
  const names: string[] = []
  for (let i = 0; i < cmd.args.length; i++) {
    if (/^-i?(name|path|wholename)$/.test(cmd.args[i].text) && cmd.args[i + 1])
      names.push(cmd.args[i + 1].text.replace(/^.*\//, ''))
  }
  const { roots } = findInfo(cmd.args)
  for (const root of roots.length ? roots : [{ text: '.', quoted: false, opaque: false }]) {
    const path = root.opaque ? null : resolveIn(root.text, cmd, ctx)
    if (path === null) continue
    if (names.some((n) => segmentMatches(n, 'guard.key')))
      return [hit('sensitive.claudedeck', cmd, index)]
    const secretName = names.some((n) =>
      ['id_rsa', 'id_ed25519', 'id_ecdsa', 'credentials', '.credentials.json', '.netrc'].some((s) =>
        segmentMatches(n, s)
      )
    )
    if (secretName || (!names.length && readsSecretDir(path, ctx, true)))
      return [hit('sensitive.keyRead', cmd, index)]
  }
  return []
}

/** `find ROOT ... -delete` or `find ROOT | xargs rm`: deletes under the roots. */
function findDeleteHits(
  roots: Arg[],
  filtered: boolean,
  cmd: Cmd,
  index: number,
  ctx: DetectContext
): Hit[] {
  const out: Hit[] = []
  for (const root of roots.length ? roots : [{ text: '.', quoted: false, opaque: false }]) {
    if (!filtered) {
      out.push(...deleteHits(root, true, cmd, index, ctx))
      continue
    }
    const path = root.opaque ? null : resolveIn(root.text, cmd, ctx)
    if (path === null) continue
    // A filtered search from the root or a top-level system folder still reaches everything.
    if (segments(path, ctx.os).length <= (ctx.os === 'win32' ? 2 : 1)) {
      out.push(hit('disk.systemDelete', cmd, index, { cap: 'ask' }))
      continue
    }
    const rule = writeRule(path, ctx)
    if (rule) out.push(hit(rule, cmd, index))
  }
  return out
}

const DELETERS = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'srm',
  'rimraf',
  'remove-item',
  'del',
  'rd'
])

function permissionHits(cmd: Cmd, index: number, ctx: DetectContext): Hit[] {
  const { name, args } = cmd
  let recursive = false
  let targets: Arg[] = []
  if (name === 'chmod' || name === 'chown' || name === 'chgrp' || name === 'chflags') {
    recursive = hasFlag(args, 'R', '--recursive')
    targets = positionals(args, new Set(['--reference'])).slice(1)
  } else if (name === 'icacls') {
    recursive = args.some((a) => /^\/t$/i.test(a.text))
    targets = args.slice(0, 1)
  } else if (name === 'takeown') {
    recursive = args.some((a) => /^\/r$/i.test(a.text))
    const f = args.findIndex((a) => /^\/f$/i.test(a.text))
    targets = f >= 0 && args[f + 1] ? [args[f + 1]] : []
  }
  if (!recursive) return []
  for (const t of targets) {
    if (t.opaque) continue
    const path = resolveIn(t.text, cmd, ctx)
    if (path && (isCriticalDir(path, ctx) || writeRule(path, ctx) === 'sensitive.system')) {
      return [hit('disk.recursivePermissions', cmd, index)]
    }
  }
  return []
}

/** macOS keychain dumps and password reads. */
function keychainRead(cmd: Cmd): boolean {
  if (cmd.name !== 'security') return false
  const sub = cmd.args[0]?.text ?? ''
  if (sub === 'dump-keychain' || sub === 'export') return true
  return (
    /^find-(generic|internet)-password$/.test(sub) &&
    cmd.args.some((a) => a.text === '-w' || a.text === '-g')
  )
}

/** `ln -s ~/.zshrc notes.txt`: a later edit of the link changes the protected file. */
function linkHits(cmd: Cmd, index: number, ctx: DetectContext): Hit[] {
  if (cmd.name !== 'ln' || cmd.shell !== 'posix') return []
  const list = positionals(cmd.args, new Set(['-S', '--suffix', '-t', '--target-directory']))
  const sources = list.length > 1 ? list.slice(0, -1) : list
  const hits: Hit[] = []
  for (const source of sources) {
    if (source.opaque) continue
    const path = resolveIn(source.text, cmd, ctx)
    if (!path) continue
    const rule = writeRule(path, ctx) ?? protectedInside(path, ctx)
    if (rule) hits.push(hit(rule, cmd, index, { cap: 'ask', detail: 'a link to it' }))
  }
  return hits
}

/** `cp -r ~/.ssh x`, `tar czf k.tgz ~/.ssh`, `grep -r . ~/.ssh`: secrets copied in bulk. */
function secretDirHits(cmd: Cmd, index: number, ctx: DetectContext): Hit[] {
  const reads = recursiveReads(cmd)
  if (!reads) return []
  for (const source of reads.sources) {
    if (source.opaque) continue
    const path = resolveIn(source.text, cmd, ctx)
    if (path && readsSecretDir(path, ctx, reads.parents)) {
      return [hit('sensitive.keyRead', cmd, index)]
    }
  }
  return []
}

/** `$cmd -rf ~`, `$(echo rm) -rf ~`: an unknown command given a critical or protected path. */
function unknownCommandHits(cmd: Cmd, index: number, ctx: DetectContext): Hit[] {
  if (cmd.shell === 'cmd' || !/[$`]/.test(cmd.name)) return []
  for (const a of cmd.args) {
    if (a.opaque || a.text.startsWith('-')) continue
    const path = resolveIn(a.text, cmd, ctx)
    if (!path) continue
    if (isCriticalDir(path, ctx)) {
      return [
        hit('disk.systemDelete', cmd, index, {
          cap: 'ask',
          detail: 'the command could not be told'
        })
      ]
    }
    const rule = writeRule(path, ctx) ?? protectedInside(path, ctx)
    if (rule)
      return [hit(rule, cmd, index, { cap: 'ask', detail: 'the command could not be told' })]
  }
  return []
}

/** `python3 -c 'shutil.rmtree("/Users/dev")'`: inline code naming protected paths. */
function inlineCodeHits(cmd: Cmd, index: number, ctx: DetectContext): Hit[] {
  const stdin = cmd.redirects.flatMap((r) =>
    r.heredoc ? [r.heredoc.body] : r.op === '<<<' && !r.target.opaque ? [r.target.text] : []
  )
  if (cmd.stdin !== undefined) stdin.push(cmd.stdin)
  const detail = 'in inline code'
  const hits: Hit[] = []
  for (const full of inlineCode({ name: cmd.name, args: cmd.args, stdin })) {
    const code = full.slice(0, MAX_CODE)
    const changes = CHANGE_API.test(code)
    const reads = READ_API.test(code)
    if (!changes && !reads) continue
    if (changes) {
      // `open(".claude/settings.local.json", "w")`: the project's Claude settings and hooks.
      for (const text of codeClaudePaths(code)) {
        const path = resolveIn(text, cmd, ctx)
        if (!path) continue
        const rule = writeRule(path, ctx)
        // Code has no reason to write a project's Claude folder: denied, not asked about.
        if (projectClaudeDir(path, ctx) && (!rule || rule === 'sensitive.projectAgentConfig'))
          hits.push(hit('sensitive.claudeSettings', cmd, index, { detail }))
        else if (rule) hits.push(hit(rule, cmd, index, { detail }))
      }
    }
    for (const text of codePaths(code)) {
      const path = resolvePath(text, { ...ctx, cwd: null })
      if (!path) continue
      if (isGuardKey(path, ctx)) {
        hits.push(hit('sensitive.claudedeck', cmd, index, { detail }))
        continue
      }
      if (reads && isSecretFile(path, ctx)) {
        hits.push(hit('sensitive.keyRead', cmd, index, { cap: 'ask', detail }))
      }
      if (!changes) continue
      // ClaudeDeck's hook files and Claude's settings: no reason for code to change them.
      if (inClaudeControlDir(path, ctx)) {
        hits.push(hit(writeRule(path, ctx) ?? 'sensitive.claudedeck', cmd, index, { detail }))
        continue
      }
      if (isCriticalDir(path, ctx)) {
        hits.push(hit('disk.systemDelete', cmd, index, { cap: 'ask', detail }))
        continue
      }
      const rule = writeRule(path, ctx) ?? protectedInside(path, ctx)
      if (rule) hits.push(hit(rule, cmd, index, { cap: 'ask', detail }))
    }
  }
  return hits
}

export const fileOps: CmdDetector = (cmd, index, ctx) => {
  const hits: Hit[] = []
  const del = deleteTargets(cmd)
  if (del) {
    if (cmd.findRoots && cmd.via.some((v) => v === 'xargs' || v === 'find')) {
      hits.push(...findDeleteHits(cmd.findRoots, !!cmd.findFiltered, cmd, index, ctx))
    } else if (cmd.unknownArgs && del.recursive) {
      hits.push(
        hit('disk.systemDelete', cmd, index, {
          cap: 'ask',
          detail: 'the targets come from standard input'
        })
      )
    }
    for (const target of del.targets)
      hits.push(...deleteHits(target, del.recursive, cmd, index, ctx))
  }
  if (cmd.name === 'find' && cmd.args.some((a) => a.text === '-delete')) {
    const roots: Arg[] = []
    for (const a of cmd.args) {
      if (a.text.startsWith('-') || a.text === '(' || a.text === '!') break
      roots.push(a)
    }
    const filtered = cmd.args.some((a) =>
      /^-(i?name|i?path|i?regex|type|newer\w*|[amc](time|min)|size|empty|user)$/.test(a.text)
    )
    hits.push(...findDeleteHits(roots, filtered, cmd, index, ctx))
  }
  if (cmd.name === 'rsync' && cmd.args.some((a) => /^--del(ete)?(-\w+)?$/.test(a.text))) {
    const dest = positionals(
      cmd.args,
      new Set(['-e', '--rsh', '--exclude', '--include', '--filter', '-f'])
    ).slice(-1)
    for (const d of dest) hits.push(...deleteHits(d, true, cmd, index, ctx))
  }
  for (const source of moveSources(cmd)) hits.push(...deleteHits(source, true, cmd, index, ctx))
  hits.push(...permissionHits(cmd, index, ctx))

  if (!DELETERS.has(cmd.name)) {
    const copies = new Set(copyDestinations(cmd).map((a) => a.text))
    for (const target of writeTargets(cmd))
      hits.push(...writeHits(target, cmd, index, ctx, copies.has(target.text)))
    for (const dest of copyDestinations(cmd)) {
      if (!dest.opaque && !writeTargets(cmd).some((t) => t.text === dest.text))
        hits.push(...writeHits(dest, cmd, index, ctx, true))
    }
  }
  for (const source of readTargets(cmd)) {
    if (source.opaque) continue
    const variants = expanded(source, cmd)
    if (!variants) {
      hits.push(hit('disk.uncheckable', cmd, index, { cap: 'ask', detail: BRACE_DETAIL }))
      continue
    }
    for (const v of variants) {
      const path = resolveIn(v.text, cmd, ctx)
      if (path && isSecretFile(path, ctx) && !isGuardKey(path, ctx)) {
        hits.push(hit('sensitive.keyRead', cmd, index))
        break
      }
    }
  }
  hits.push(...guardKeyHits(cmd, index, ctx))
  hits.push(...findReadHits(cmd, index, ctx))
  hits.push(...secretDirHits(cmd, index, ctx))
  hits.push(...linkHits(cmd, index, ctx))
  hits.push(...unknownCommandHits(cmd, index, ctx))
  hits.push(...inlineCodeHits(cmd, index, ctx))
  if (keychainRead(cmd)) hits.push(hit('sensitive.keyRead', cmd, index))
  return hits
}

/** Write, Edit, MultiEdit and NotebookEdit: the file they change. */
export function fileToolHits(filePath: string, ctx: DetectContext): Hit[] {
  const path = resolvePath(filePath, ctx)
  if (path === null) return []
  const rule = writeRule(path, ctx)
  return rule ? [{ ruleId: rule, excerpt: filePath }] : []
}

/**
 * Read and Grep: only secrets are checked (private keys, credential files and folders, the
 * guard key and ClaudeDeck's own folders); every other read is allowed. `folder`: Grep, which
 * reads everything below its path.
 */
export function readToolHits(filePath: string, ctx: DetectContext, folder: boolean): Hit[] {
  const path = resolvePath(filePath, ctx)
  if (path === null) return []
  const excerpt = filePath
  if (namesGuardKey(path, hasGlob(filePath), ctx) || claudeDeckFolder(path, ctx, folder))
    return [{ ruleId: 'sensitive.claudedeck', excerpt }]
  if (isSecretFile(path, ctx)) return [{ ruleId: 'sensitive.keyRead', excerpt }]
  if (folder && inSecretDir(path, ctx)) return [{ ruleId: 'sensitive.keyRead', excerpt }]
  return []
}
