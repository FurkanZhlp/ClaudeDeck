import type { OsName } from '../platform/types'
import { ANY, type Candidate, type CandidatePart, fixedParts, NON_DOT } from './globs'
import { canon, isRoot, pathApi, relativeParts, segments, within, type PathEnv } from './paths'

/**
 * Which protected location a path is in. Pure: everything is decided from the path text and
 * the context folders.
 */

export interface LocationEnv extends PathEnv {
  /** The tab's CLAUDE_CONFIG_DIR (protected like ~/.claude). */
  configDir?: string
  /** ClaudeDeck's own data folder (config.json and every account). */
  appDataDir?: string
}

/** Files of a Claude config folder that control Claude itself (permissions, hooks, login). */
const CLAUDE_CONTROL_FILES = new Set([
  'settings.json',
  'settings.local.json',
  '.credentials.json',
  '.claude.json',
  'managed-settings.json'
])
const CLAUDE_CONTROL_DIRS = new Set(['claudedeck', 'hooks'])
/** Folders of a project's `.claude` that run code or define agents. */
const PROJECT_AGENT_DIRS = new Set(['hooks', 'agents'])
/** Claude's own working data written through its tools (auto memory, plans, todos). */
const CLAUDE_WORK_DIRS = new Set(['projects', 'plans', 'todos', 'tasks'])

const SHELL_RC = new Set(
  [
    '.bashrc',
    '.bash_profile',
    '.bash_login',
    '.bash_logout',
    '.profile',
    '.zshrc',
    '.zshenv',
    '.zprofile',
    '.zlogin',
    '.zlogout',
    '.cshrc',
    '.tcshrc',
    '.kshrc',
    '.mkshrc',
    '.inputrc',
    '.config/fish/config.fish',
    '.config/fish/conf.d',
    '.config/powershell'
  ].map((p) => p.toLowerCase())
)
const POWERSHELL_PROFILE_DIRS = ['documents/powershell', 'documents/windowspowershell']

const CREDENTIAL_DIRS = ['.aws', '.gnupg', '.kube', '.azure', '.config/gcloud', '.docker']
const CREDENTIAL_FILES = new Set([
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.npmrc',
  '.pypirc',
  '.config/gh/hosts.yml',
  '.terraform.d/credentials.tfrc.json',
  'library/keychains'
])
const GITCONFIG = new Set(['.gitconfig', '.config/git/config', '.config/git/credentials'])

/** Folders below `/` that hold the OS (writes there change the system). */
const POSIX_SYSTEM = ['/etc', '/system', '/library', '/bin', '/sbin', '/usr', '/boot', '/lib']
const POSIX_SYSTEM_EXCEPT = ['/usr/local']

/** Block devices: writing to them destroys file systems. */
const RAW_DEVICE =
  /^\/dev\/(r?disk\d|sd[a-z]|hd[a-z]|nvme\d|mmcblk\d|vd[a-z]|xvd[a-z]|md\d|dm-\d|mapper\/|loop\d)/i
const WINDOWS_DEVICE = /^\\\\\.\\(physicaldrive\d+|[a-z]:)/i

/** Home folders whose recursive deletion loses a user's data (the dot folders are separate). */
const WINDOWS_SYSTEM_DIRS = [
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'users'
]

export function isRawDevice(path: string, os: OsName): boolean {
  if (os === 'win32') return WINDOWS_DEVICE.test(path)
  return RAW_DEVICE.test(path)
}

const homeRel = (path: string, e: LocationEnv): string | null => {
  const parts = relativeParts(path, e.home, e.os)
  return parts ? parts.join('/') : null
}

const startsWithDir = (rel: string, dir: string): boolean =>
  rel === dir || rel.startsWith(`${dir}/`)

const MEMO = new Map<string, unknown>()

/** Lists built from the context folders, kept per context (they are checked per target). */
function memo<T>(name: string, e: LocationEnv, make: () => T): T {
  const key = [name, e.os, e.home, e.cwd, e.configDir, e.appDataDir, e.env.SystemRoot, e.env.windir]
    .map(String)
    .join('\0')
  if (MEMO.has(key)) return MEMO.get(key) as T
  if (MEMO.size > 256) MEMO.clear()
  const value = make()
  MEMO.set(key, value)
  return value
}

function claudeDirs(e: LocationEnv): string[] {
  const p = pathApi(e.os)
  const dirs = [p.join(e.home, '.claude')]
  if (e.configDir) dirs.push(e.configDir)
  return dirs
}

/** Rule for a path inside a Claude config folder, or undefined when it is not inside one. */
function claudeRule(path: string, e: LocationEnv): string | null | undefined {
  for (const dir of claudeDirs(e)) {
    const parts = relativeParts(path, dir, e.os)
    if (!parts) continue
    if (parts.length === 0) return 'sensitive.claudeConfig'
    if (parts.length === 1 && CLAUDE_CONTROL_FILES.has(parts[0])) return 'sensitive.claudeSettings'
    if (CLAUDE_CONTROL_DIRS.has(parts[0])) return 'sensitive.claudeSettings'
    if (CLAUDE_WORK_DIRS.has(parts[0])) return null
    return 'sensitive.claudeConfig'
  }
  return undefined
}

function systemDirs(e: LocationEnv): string[] {
  if (e.os !== 'win32') return POSIX_SYSTEM
  const p = pathApi(e.os)
  const root = e.env.SystemRoot || e.env.SYSTEMROOT || e.env.windir || 'C:\\Windows'
  const drive = p.parse(root).root || 'C:\\'
  return [root, p.join(drive, 'Program Files'), p.join(drive, 'Program Files (x86)')]
}

function inSystem(path: string, e: LocationEnv): boolean {
  if (!systemDirs(e).some((dir) => within(path, dir, e.os))) return false
  if (e.os === 'win32') return true
  return !POSIX_SYSTEM_EXCEPT.some((dir) => within(path, dir, e.os))
}

/**
 * Rule a write, edit or delete of `path` falls under; null when the path is not protected.
 * Checked in order: devices, Claude's control files, ClaudeDeck data, the home dot files, git
 * internals, system folders.
 */
export function writeRule(path: string, e: LocationEnv): string | null {
  if (isRawDevice(path, e.os)) return 'disk.rawDevice'
  if (isGuardKey(path, e)) return 'sensitive.claudedeck'
  const claude = claudeRule(path, e)
  if (claude !== undefined) return claude
  const p = pathApi(e.os)
  const parts = segments(path, e.os)
  const name = parts[parts.length - 1] ?? ''
  const parent = parts[parts.length - 2] ?? ''
  if (parent === '.claude' && CLAUDE_CONTROL_FILES.has(name)) return 'sensitive.claudeSettings'
  if (name === '.claude.json' && within(p.dirname(path), e.home, e.os)) {
    return 'sensitive.claudeSettings'
  }
  if (e.appDataDir && within(path, e.appDataDir, e.os)) return 'sensitive.claudedeck'
  // A project's own Claude hooks, agents and MCP servers run code or steer Claude.
  const dotClaude = parts.lastIndexOf('.claude')
  if (dotClaude >= 0 && PROJECT_AGENT_DIRS.has(parts[dotClaude + 1] ?? '')) {
    return 'sensitive.projectAgentConfig'
  }
  if (name === '.mcp.json') return 'sensitive.projectAgentConfig'

  const rel = homeRel(path, e)
  if (rel !== null && rel !== '') {
    if (startsWithDir(rel, '.ssh')) return 'sensitive.ssh'
    if (CREDENTIAL_DIRS.some((dir) => startsWithDir(rel, dir))) return 'sensitive.credentials'
    if ([...CREDENTIAL_FILES].some((file) => startsWithDir(rel, file))) {
      return 'sensitive.credentials'
    }
    if ([...SHELL_RC].some((file) => startsWithDir(rel, file))) return 'sensitive.shellRc'
    if (
      POWERSHELL_PROFILE_DIRS.some((dir) => startsWithDir(rel, dir)) &&
      /profile\.ps1$/.test(rel)
    ) {
      return 'sensitive.shellRc'
    }
    if (GITCONFIG.has(rel)) return 'sensitive.gitconfig'
    if (startsWithDir(rel, 'library/launchagents')) return 'system.autostart'
  }
  if (parts.includes('.git')) return 'sensitive.gitInternals'
  if (inSystem(path, e)) return 'sensitive.system'
  return null
}

/** Protected locations below `dir`: a recursive delete of `dir` takes them along. */
export function protectedInside(dir: string, e: LocationEnv): string | null {
  const p = pathApi(e.os)
  const candidates = memo('inside', e, (): [string, string][] => [
    [p.join(e.home, '.ssh'), 'sensitive.ssh'],
    ...CREDENTIAL_DIRS.map((d): [string, string] => [p.join(e.home, d), 'sensitive.credentials']),
    ...claudeDirs(e).map((d): [string, string] => [d, 'sensitive.claudeSettings']),
    ...(e.appDataDir ? [[e.appDataDir, 'sensitive.claudedeck'] as [string, string]] : [])
  ])
  for (const [location, rule] of candidates) {
    if (within(location, dir, e.os) && canon(location, e.os) !== canon(dir, e.os)) return rule
  }
  return null
}

/**
 * Folders whose recursive deletion (or wiping with `*`) is catastrophic: the root and its top
 * level, drive roots and Windows system folders, any user's home, the folders directly in the
 * home (not dot folders), mounted volumes, and the working folder and its parents.
 */
export function isCriticalDir(path: string, e: LocationEnv): boolean {
  const { os } = e
  const parts = segments(path, os)
  if (isRoot(path, os)) return true
  if (os === 'win32') {
    if (parts.length === 2 && WINDOWS_SYSTEM_DIRS.includes(parts[1])) return true
    if (parts.length === 3 && parts[1] === 'users') return true
  } else {
    if (parts.length === 1) return true
    if (parts.length === 2 && ['users', 'home', 'volumes', 'mnt', 'media'].includes(parts[0])) {
      return true
    }
    if (parts.length === 3 && parts[0] === 'media') return true
  }
  if (canon(path, os) === canon(e.home, os)) return true
  const rel = relativeParts(path, e.home, os)
  if (rel && rel.length === 1 && !rel[0].startsWith('.')) return true
  if (e.cwd && within(e.cwd, path, os)) return true
  return false
}

/** An account's guard key (`<config>/claudedeck/guard.key`): reading it is as bad as writing. */
export function isGuardKey(path: string, e: LocationEnv): boolean {
  const parts = segments(path, e.os)
  return parts[parts.length - 1] === 'guard.key' && parts[parts.length - 2] === 'claudedeck'
}

/** Candidates for globs (`rm -rf ~/D*`, `~/.ss?`): critical folders and protected locations. */
export function globCandidates(e: LocationEnv): Candidate[] {
  return memo('glob', e, () => buildGlobCandidates(e))
}

function buildGlobCandidates(e: LocationEnv): Candidate[] {
  const { os } = e
  const p = pathApi(os)
  const fixed = (path: string): CandidatePart[] => fixedParts(path, os)
  const home = fixed(e.home)
  const critical = (parts: CandidatePart[]): Candidate => ({
    parts,
    rule: 'disk.systemDelete',
    critical: true
  })
  const out: Candidate[] = []
  if (os === 'win32') {
    for (const dir of WINDOWS_SYSTEM_DIRS) out.push(critical([ANY, dir]))
    out.push(critical([ANY, 'users', ANY]))
  } else {
    out.push(critical([ANY]))
    for (const dir of ['users', 'home', 'volumes', 'mnt', 'media']) out.push(critical([dir, ANY]))
    out.push(critical(['media', ANY, ANY]))
  }
  out.push(critical(home), critical([...home, NON_DOT]))
  if (e.cwd) {
    let dir = e.cwd
    for (let level = 0; level < 64; level++) {
      out.push(critical(fixed(dir)))
      const parent = p.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  const at = (rel: string, rule: string): Candidate => ({
    parts: [...home, ...rel.split('/')],
    rule,
    critical: false
  })
  out.push(at('.ssh', 'sensitive.ssh'))
  for (const dir of CREDENTIAL_DIRS) out.push(at(dir, 'sensitive.credentials'))
  for (const file of CREDENTIAL_FILES) out.push(at(file, 'sensitive.credentials'))
  for (const file of SHELL_RC) out.push(at(file, 'sensitive.shellRc'))
  for (const file of GITCONFIG) out.push(at(file, 'sensitive.gitconfig'))
  for (const dir of claudeDirs(e))
    out.push({ parts: fixed(dir), rule: 'sensitive.claudeSettings', critical: false })
  if (e.appDataDir)
    out.push({ parts: fixed(e.appDataDir), rule: 'sensitive.claudedeck', critical: false })
  for (const dir of systemDirs(e))
    out.push({ parts: fixed(dir), rule: 'sensitive.system', critical: false })
  return out
}

/** Folders holding keys and credentials: copying or archiving them exposes secrets. */
const SECRET_DIRS = ['.ssh', '.aws', '.gnupg', '.kube', '.azure', '.config/gcloud', '.docker']

/**
 * A recursive read (`cp -r`, `tar`, `zip -r`, `grep -r`) of `path` takes a secret folder along:
 * the path is in one, or (`parents`) it is a folder that contains one.
 */
export function readsSecretDir(path: string, e: LocationEnv, parents: boolean): boolean {
  const p = pathApi(e.os)
  const dirs = memo('secret', e, () => [
    ...SECRET_DIRS.map((d) => p.join(e.home, d)),
    ...claudeDirs(e)
  ])
  return dirs.some((dir) => within(path, dir, e.os) || (parents && within(dir, path, e.os)))
}

const SSH_PUBLIC = new Set(['known_hosts', 'known_hosts.old', 'config', 'authorized_keys'])
const KEY_NAME = /^id_(rsa|dsa|ecdsa|ed25519|ecdsa_sk|ed25519_sk)$/
const SECRET_FILES = new Set([
  '.aws/credentials',
  '.aws/config',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.docker/config.json',
  '.kube/config',
  '.config/gh/hosts.yml',
  '.npmrc',
  '.pypirc',
  '.gnupg/secring.gpg',
  '.config/gcloud/credentials.db',
  '.config/gcloud/application_default_credentials.json'
])

/** A private key or credential file: reading or copying it exposes a secret. */
export function isSecretFile(path: string, e: LocationEnv): boolean {
  const parts = segments(path, e.os)
  const name = parts[parts.length - 1] ?? ''
  if (KEY_NAME.test(name) || isGuardKey(path, e)) return true
  const claude = claudeDirs(e).some((dir) => {
    const rel = relativeParts(path, dir, e.os)
    return !!rel && rel.length === 1 && rel[0] === '.credentials.json'
  })
  if (claude) return true
  const rel = homeRel(path, e)
  if (rel === null || rel === '') return false
  if (rel.startsWith('.ssh/')) {
    return !SSH_PUBLIC.has(name) && !name.endsWith('.pub')
  }
  if (rel.startsWith('.gnupg/private-keys-v1.d/')) return true
  return SECRET_FILES.has(rel)
}
