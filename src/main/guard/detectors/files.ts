import { hasFlag, positionals, type Arg, type Cmd } from '../commands'
import { isCriticalDir, isSecretFile, protectedInside, writeRule } from '../locations'
import { globBase, resolvePath, segments } from '../paths'
import { deleteTargets, moveSources, readTargets, writeTargets } from '../targets'
import { hit, type CmdDetector, type DetectContext, type Hit } from './types'

/**
 * Deletes, writes, moves, permission changes and secret reads, for the disk category (critical
 * folders) and the sensitive category (protected files). The working folder of each command is
 * its own (after `cd`); "the project folder and its parents" is always the session's folder.
 */

/** Text before the first variable or substitution: what is known of an opaque path. */
const literalPrefix = (text: string): string => text.split(/[$%`]/)[0]

function resolveIn(text: string, cmd: Cmd, ctx: DetectContext): string | null {
  return resolvePath(text, { ...ctx, cwd: cmd.cwd })
}

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
    const prefix = literalPrefix(target.text)
    const base = prefix ? resolveIn(prefix.replace(/[^\\/]*$/, '') || '.', cmd, ctx) : null
    if (prefix && base && !isCriticalDir(base, ctx)) return []
    return [
      hit('disk.systemDelete', cmd, index, { cap: 'ask', detail: 'the target could not be told' })
    ]
  }
  if (target.opaque) return unknown()

  const glob = globBase(target.text)
  if (glob) {
    const base = resolveIn(glob.base, cmd, ctx)
    if (base === null) return unknown()
    if (glob.all && isCriticalDir(base, ctx)) {
      return [hit('disk.systemDelete', cmd, index, recursive ? {} : { cap: 'ask' })]
    }
    const rule = writeRule(base, ctx)
    return rule ? [hit(rule, cmd, index)] : []
  }

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

export const fileOps: CmdDetector = (cmd, index, ctx) => {
  const hits: Hit[] = []
  const del = deleteTargets(cmd)
  if (del) {
    if (cmd.findRoots && cmd.via.some((v) => v === 'xargs' || v === 'find')) {
      hits.push(...findDeleteHits(cmd.findRoots, !!cmd.findFiltered, cmd, index, ctx))
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
    for (const target of writeTargets(cmd)) {
      if (target.opaque) continue
      const path = resolveIn(target.text, cmd, ctx)
      const rule = path && writeRule(path, ctx)
      if (rule) hits.push(hit(rule, cmd, index))
    }
  }
  for (const source of readTargets(cmd)) {
    if (source.opaque) continue
    const path = resolveIn(source.text, cmd, ctx)
    if (path && isSecretFile(path, ctx)) hits.push(hit('sensitive.keyRead', cmd, index))
  }
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
