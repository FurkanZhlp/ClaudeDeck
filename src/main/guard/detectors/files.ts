import { hasFlag, MAX_CODE, positionals, type Arg, type Cmd } from '../commands'
import { expandBraces, globRules, hasGlob } from '../globs'
import { CHANGE_API, codePaths, inlineCode, READ_API } from '../inlineCode'
import {
  globCandidates,
  isGuardKey,
  isCriticalDir,
  isSecretFile,
  protectedInside,
  readsSecretDir,
  writeRule
} from '../locations'
import { globBase, isRoot, canon, resolveCollapsed, resolvePath, segments } from '../paths'
import { deleteTargets, moveSources, readTargets, recursiveReads, writeTargets } from '../targets'
import { hit, type CmdDetector, type DetectContext, type Hit } from './types'

/**
 * Deletes, writes, moves, permission changes and secret reads, for the disk category (critical
 * folders) and the sensitive category (protected files). The working folder of each command is
 * its own (after `cd`); "the project folder and its parents" is always the session's folder.
 */

/** Text before the first variable or substitution: what is known of an opaque path. */
const literalPrefix = (text: string): string => text.split(/[$%`]|^~[+-]/)[0]

function resolveIn(text: string, cmd: Cmd, ctx: DetectContext): string | null {
  return resolvePath(text, { ...ctx, cwd: cmd.cwd })
}

/** A target after brace expansion (POSIX shells only); null when it expands to too many. */
function expanded(target: Arg, cmd: Cmd): Arg[] | null {
  if (cmd.shell !== 'posix' || target.opaque || !target.text.includes('{')) return [target]
  const words = expandBraces(target.text)
  return words && words.map((text) => ({ ...target, text }))
}

const UNKNOWN_DETAIL = 'the target could not be told'

/** Hits for deleting `target`; `recursive` when folders go with everything inside them. */
function deleteHits(
  target: Arg,
  recursive: boolean,
  cmd: Cmd,
  index: number,
  ctx: DetectContext
): Hit[] {
  const unknown = (): Hit[] => {
    if (!recursive) return []
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
  if (!variants)
    return [hit('disk.systemDelete', cmd, index, { cap: 'ask', detail: UNKNOWN_DETAIL })]
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

/** Rules of a written path, globs and braces included. */
function writeHits(target: Arg, cmd: Cmd, index: number, ctx: DetectContext): Hit[] {
  if (target.opaque) return []
  const variants = expanded(target, cmd) ?? []
  const hits: Hit[] = []
  for (const v of variants) {
    const path = resolveIn(v.text, cmd, ctx)
    if (!path) continue
    const rules = hasGlob(v.text) ? globRules(path, false, globCandidates(ctx), ctx.os) : []
    const rule = writeRule(path, ctx)
    for (const r of rule ? [rule, ...rules] : rules) hits.push(hit(r, cmd, index))
  }
  return hits
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
  const detail = 'in inline code'
  const hits: Hit[] = []
  for (const full of inlineCode({ name: cmd.name, args: cmd.args, stdin })) {
    const code = full.slice(0, MAX_CODE)
    const changes = CHANGE_API.test(code)
    const reads = READ_API.test(code)
    if (!changes && !reads) continue
    for (const text of codePaths(code)) {
      const path = resolvePath(text, { ...ctx, cwd: null })
      if (!path) continue
      if (reads && isSecretFile(path, ctx)) {
        hits.push(hit('sensitive.keyRead', cmd, index, { cap: 'ask', detail }))
      }
      if (!changes) continue
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
    for (const target of writeTargets(cmd)) hits.push(...writeHits(target, cmd, index, ctx))
  }
  for (const source of readTargets(cmd)) {
    if (source.opaque) continue
    for (const v of expanded(source, cmd) ?? []) {
      const path = resolveIn(v.text, cmd, ctx)
      if (path && isGuardKey(path, ctx)) {
        hits.push(hit('sensitive.claudedeck', cmd, index))
        break
      }
      if (path && isSecretFile(path, ctx)) {
        hits.push(hit('sensitive.keyRead', cmd, index))
        break
      }
    }
  }
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
