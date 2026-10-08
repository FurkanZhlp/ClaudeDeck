import { hasFlag, positionals, type Arg, type Cmd } from '../commands'
import { hit, type CmdDetector, type DetectContext, type Hit } from './types'

/** Git commands that lose work or rewrite shared history. */

const GLOBAL_VALUE_FLAGS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
  '--exec-path'
])
/** Branches others usually build on. */
const SHARED_BRANCH =
  /^(main|master|develop|development|dev|trunk|stable|production|prod|staging|release([/-].*)?)$/
const PUSH_VALUE_FLAGS = new Set([
  '--repo',
  '--receive-pack',
  '--exec',
  '-o',
  '--push-option',
  '--recurse-submodules'
])

/** Subcommand and its arguments after git's global options. */
export function gitSub(args: Arg[]): { sub: string; rest: Arg[] } | null {
  let i = 0
  while (i < args.length && args[i].text.startsWith('-')) {
    const text = args[i].text
    i++
    if (!text.includes('=') && GLOBAL_VALUE_FLAGS.has(text)) i++
  }
  const sub = args[i]
  return sub ? { sub: sub.text, rest: args.slice(i + 1) } : null
}

const branchOf = (ref: string): string =>
  ref
    .replace(/^\+/, '')
    .split(':')
    .pop()
    ?.replace(/^refs\/heads\//, '') ?? ref

function defaultBranchDetail(branches: string[]): string | undefined {
  const shared = branches.find((b) => SHARED_BRANCH.test(b))
  return shared ? `to the shared branch ${shared}` : undefined
}

function push(cmd: Cmd, index: number, rest: Arg[], ctx: DetectContext): Hit[] {
  const refs = positionals(rest, PUSH_VALUE_FLAGS)
    .slice(1)
    .map((a) => a.text)
  const force =
    hasFlag(rest, 'f', '--force', '--force-with-lease', '--mirror') ||
    refs.some((r) => r.startsWith('+'))
  const del = hasFlag(rest, 'd', '--delete', '--prune') || refs.some((r) => r.startsWith(':'))
  const hits: Hit[] = []
  if (force) {
    const branches = refs.length ? refs.map(branchOf) : ctx.gitBranch ? [ctx.gitBranch] : []
    const detail = defaultBranchDetail(branches)
    hits.push(hit('git.forcePush', cmd, index, detail ? { detail } : {}))
  }
  if (del) hits.push(hit('git.pushDelete', cmd, index))
  return hits
}

const REBASE_CONTROL = /^--(continue|abort|skip|quit|edit-todo|show-current-patch)$/

function rebase(cmd: Cmd, index: number, rest: Arg[], ctx: DetectContext): Hit[] {
  if (rest.some((a) => REBASE_CONTROL.test(a.text))) return []
  const pos = positionals(
    rest,
    new Set(['--onto', '-s', '--strategy', '-X', '--strategy-option', '-x', '--exec'])
  )
  // `git rebase upstream branch` rebases `branch`; otherwise the current one.
  const branch = pos[1]?.text ?? ctx.gitBranch
  if (branch === null) return []
  if (branch === undefined)
    return [
      hit('git.rebaseShared', cmd, index, {
        cap: 'ask',
        detail: 'the current branch could not be checked'
      })
    ]
  return SHARED_BRANCH.test(branch)
    ? [hit('git.rebaseShared', cmd, index, { detail: `branch ${branch}` })]
    : []
}

export const gitRules: CmdDetector = (cmd, index, ctx) => {
  if (cmd.name === 'gh') {
    const [a, b] = cmd.args.map((x) => x.text)
    if (a === 'repo' && b === 'delete') return [hit('git.repoDelete', cmd, index)]
    return []
  }
  if (cmd.name !== 'git') return []
  const parsed = gitSub(cmd.args)
  if (!parsed) return []
  const { sub, rest } = parsed
  const texts = rest.map((a) => a.text)
  const one = (id: string): Hit[] => [hit(id, cmd, index)]
  switch (sub) {
    case 'push':
      return push(cmd, index, rest, ctx)
    case 'reset':
      return texts.includes('--hard') || texts.includes('--merge') ? one('git.resetHard') : []
    case 'clean':
      return hasFlag(rest, 'f', '--force') && !hasFlag(rest, 'n', '--dry-run')
        ? one('git.clean')
        : []
    case 'branch': {
      const del = hasFlag(rest, 'dD', '--delete')
      const force = hasFlag(rest, 'Df', '--force')
      return del && force ? one('git.branchDelete') : []
    }
    case 'checkout': {
      if (hasFlag(rest, 'bB', '--orphan')) return []
      const dashes = texts.indexOf('--')
      const paths = dashes >= 0 ? texts.slice(dashes + 1) : positionals(rest).map((a) => a.text)
      const discards =
        hasFlag(rest, 'f', '--force') ||
        (dashes >= 0 && paths.length > 0) ||
        paths.some((p) => p === '.' || p === ':/' || p === '*')
      return discards ? one('git.discardChanges') : []
    }
    case 'restore': {
      const staged = hasFlag(rest, 'S', '--staged')
      const worktree = hasFlag(rest, 'W', '--worktree')
      if (staged && !worktree) return []
      return positionals(rest, new Set(['-s', '--source'])).length ? one('git.discardChanges') : []
    }
    case 'switch':
      return hasFlag(rest, 'f', '--discard-changes', '--force') ? one('git.discardChanges') : []
    case 'stash':
      return texts[0] === 'drop' || texts[0] === 'clear' ? one('git.stashDrop') : []
    case 'rebase':
      return rebase(cmd, index, rest, ctx)
    case 'filter-branch':
    case 'filter-repo':
    case 'prune':
      return one('git.historyRewrite')
    case 'reflog':
      return texts[0] === 'expire' || texts[0] === 'delete' ? one('git.historyRewrite') : []
    case 'gc':
      return texts.some((t) => /^--prune=(now|all)$/.test(t)) ? one('git.historyRewrite') : []
    case 'update-ref':
      return texts.includes('-d') ? one('git.historyRewrite') : []
  }
  return []
}
