import { isSafeRegex } from '../../../shared/safeRegex'
import { positionals, type Arg, type Cmd } from '../commands'
import { psParam, psValue } from '../targets'
import { hit, type CmdDetector, type DetectContext, type Hit } from './types'

/** Administrator commands, broad kills, shutdowns and service changes. */

/** Processes whose mass kill takes down the session, the desktop or Claude itself. */
const CRITICAL = new Set([
  'node',
  'node.exe',
  'claude',
  'claude.exe',
  'electron',
  'claudedeck',
  'bash',
  'zsh',
  'sh',
  'fish',
  'login',
  'launchd',
  'systemd',
  'init',
  'finder',
  'dock',
  'windowserver',
  'loginwindow',
  'terminal',
  'iterm2',
  'explorer',
  'explorer.exe',
  'svchost',
  'svchost.exe',
  'csrss',
  'winlogon',
  'lsass',
  'powershell',
  'pwsh',
  'cmd',
  'cmd.exe',
  'conhost',
  'sshd',
  'python',
  'python3'
])

/** A process name or pattern that selects too much. */
function broad(pattern: string | undefined, full: boolean): boolean {
  if (pattern === undefined) return true
  const p = pattern.toLowerCase().replace(/^\^|\$$/g, '')
  if (CRITICAL.has(p)) return true
  if (/^[.*?+\\^$[\]|()]*$/.test(p) || p.includes('*')) return true
  return p.length < (full ? 4 : 2)
}

const KILL_SIGNAL = /^-(\d+|[A-Z]+|SIG[A-Z]+)$/

function killHits(cmd: Cmd, index: number): Hit[] {
  const { name, args } = cmd
  const one = (): Hit[] => [hit('system.killAll', cmd, index)]
  if (name === 'kill' && cmd.shell !== 'powershell') {
    let rest = args
    if (rest[0] && KILL_SIGNAL.test(rest[0].text)) rest = rest.slice(1)
    else if (rest[0] && (rest[0].text === '-s' || rest[0].text === '-n')) rest = rest.slice(2)
    if (rest[0]?.text === '--') rest = rest.slice(1)
    return rest.some((a) => a.text === '-1' || a.text === '0') ? one() : []
  }
  if (name === 'killall' || name === 'pkill') {
    const values = new Set([
      '-u',
      '-U',
      '-g',
      '-G',
      '-t',
      '-s',
      '-P',
      '--signal',
      '-c',
      '--user',
      '-o',
      '-y'
    ])
    const pattern = positionals(
      args.filter((a) => !KILL_SIGNAL.test(a.text) || a.text === '-u'),
      values
    )[0]
    const full = args.some(
      (a) => a.text === '-f' || a.text === '--full' || a.text === '-r' || a.text === '--regexp'
    )
    return broad(pattern?.text, full) ? one() : []
  }
  if (name === 'taskkill') {
    const im = args.findIndex((a) => /^\/im$/i.test(a.text))
    if (args.some((a) => /^\/fi$/i.test(a.text))) return one()
    return im >= 0 && broad(args[im + 1]?.text, false) ? one() : []
  }
  if (name === 'stop-process') {
    const target = psValue(args, 'name', 1)
    if (target) return broad(target.text, false) ? one() : []
    return []
  }
  return []
}

/* ClaudeDeck's own processes ------------------------------------------------------------------ */

/** Process names of ClaudeDeck, Claude and the hook script (which runs under sh). */
const OWN_NAMES = [
  'claude',
  'claudedeck',
  'ClaudeDeck',
  'ClaudeDeck Helper',
  'ClaudeDeck Helper (Renderer)',
  'Electron',
  'Electron Helper',
  'sh',
  'bash'
]
/** Command lines `pkill -f` patterns are matched against. */
const OWN_COMMAND_LINES = [
  '/bin/sh /Users/dev/Library/Application Support/ClaudeDeck/accounts/a1/claudedeck/hook.sh pre',
  '/bin/sh C:/Users/dev/AppData/Roaming/ClaudeDeck/accounts/a1/claudedeck/hook.sh pre',
  '/Applications/ClaudeDeck.app/Contents/MacOS/ClaudeDeck',
  'C:\\Users\\dev\\AppData\\Local\\Programs\\ClaudeDeck\\ClaudeDeck.exe',
  '/Users/dev/ClaudeDeck/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .',
  '/Applications/ClaudeDeck.app/Contents/Frameworks/ClaudeDeck Helper.app/Contents/MacOS/ClaudeDeck Helper --type=utility',
  'claude --resume 0f0e',
  'node /usr/local/bin/claude --resume 0f0e'
]
const MAX_PROCESS_PATTERN = 200

/** A pkill-style pattern (a regex) that selects one of ClaudeDeck's processes. */
function selectsOwn(pattern: string, full: boolean, ignoreCase: boolean): boolean {
  const samples = full ? OWN_COMMAND_LINES : OWN_NAMES
  if (pattern.length > MAX_PROCESS_PATTERN) return true
  let regex: RegExp | null = null
  if (isSafeRegex(pattern)) {
    try {
      regex = new RegExp(pattern, ignoreCase ? 'i' : '')
    } catch {
      regex = null
    }
  }
  if (regex) return samples.some((s) => (regex as RegExp).test(s))
  const lower = pattern.toLowerCase()
  return samples.some((s) => s.toLowerCase().includes(lower))
}

/** An exact process name (killall, taskkill /im, Stop-Process -Name; `*` wildcards). */
function namesOwn(name: string): boolean {
  const base = name.replace(/\.exe$/i, '').replace(/\*+/g, '*')
  if ((base.match(/\*/g)?.length ?? 0) > 3) return true
  if (base.includes('*') || base.includes('?')) {
    const re = new RegExp(
      `^${base
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')}$`,
      'i'
    )
    return OWN_NAMES.some((n) => re.test(n))
  }
  return OWN_NAMES.some((n) => n.toLowerCase() === base.toLowerCase())
}

/** Text that names ClaudeDeck's processes (`$(pgrep -f hook.sh)`, `$PPID`). */
const OWN_TEXT = /hook\.sh|claudedeck|\bclaude\b|\$\{?PPID\b/i

/** Ports an `lsof -i` selection names (`:47321`, `TCP:47321`, `@127.0.0.1:47321`). */
function lsofPorts(cmd: Cmd): { ports: number[]; network: boolean; unknown: boolean } {
  const ports: number[] = []
  let network = false
  let unknown = false
  const args = cmd.args
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text
    const glued = /^-[a-zA-Z]*i(.*)$/.exec(t)
    if (!glued && !/^:/.test(t)) continue
    network = true
    const spec = glued
      ? glued[1] || (args[i + 1] && !args[i + 1].text.startsWith('-') ? args[++i].text : '')
      : t
    if (args[i]?.opaque || /[$`]/.test(spec)) unknown = true
    for (const m of spec.matchAll(/:(\d+)(?:-(\d+))?/g)) {
      const from = Number(m[1])
      const to = Number(m[2] ?? m[1])
      if (to - from > 1000) unknown = true
      else for (let p = from; p <= to; p++) ports.push(p)
    }
  }
  return { ports, network, unknown }
}

/** `lsof -ti :<hook port> | xargs kill`: the feeder selects ClaudeDeck's hook server. */
function lsofSelectsOwn(feeder: Cmd, ctx: DetectContext): 'own' | 'unknown' | null {
  const { ports, network, unknown } = lsofPorts(feeder)
  if (!network) {
    // `lsof -t <file>`: the processes holding ClaudeDeck's files open.
    const files = feeder.args.filter((a) => !a.text.startsWith('-'))
    return files.some((a) => /claudedeck/i.test(a.text)) ? 'own' : null
  }
  if (unknown) return 'unknown'
  if (!ports.length) return 'own'
  if (ctx.hookPort === undefined) return null
  return ports.includes(ctx.hookPort) ? 'own' : null
}

function ownProcessHits(cmd: Cmd, index: number, all: Cmd[], ctx: DetectContext): Hit[] {
  const { name, args } = cmd
  const one = (): Hit[] => [hit('sensitive.claudedeckProcess', cmd, index)]
  const texts = args.map((a) => a.text)
  if (name === 'kill' && cmd.shell !== 'powershell') {
    if (texts.some((t) => OWN_TEXT.test(t) && (/[$`]/.test(t) || /hook\.sh/.test(t)))) return one()
    // `kill -STOP 4242` with ClaudeDeck's own process id.
    const own = ctx.ownPids ?? []
    if (texts.some((t) => /^\d+$/.test(t) && own.includes(Number(t)))) return one()
    // `pgrep -f hook.sh | xargs kill`, `lsof -ti :<hook port> | xargs kill`
    if (cmd.via.includes('xargs')) {
      const feeders = all.filter((c) => c.pipeline === cmd.pipeline && c !== cmd)
      const pgrep = feeders.find((c) => c.name === 'pgrep' || c.name === 'pidof')
      if (pgrep && ownProcessHits({ ...pgrep, name: 'pkill' }, index, all, ctx).length) return one()
      const lsof = feeders.find((c) => c.name === 'lsof')
      const selects = lsof ? lsofSelectsOwn(lsof, ctx) : null
      if (selects === 'own') return one()
      if (selects === 'unknown')
        return [hit('sensitive.claudedeckProcess', cmd, index, { cap: 'ask' })]
    }
    // `kill $(lsof -ti :<hook port>)`
    if (texts.some((t) => /[$`]/.test(t) && /\blsof\b/.test(t))) {
      const lsof = all.find((c) => c.name === 'lsof' && c.via.includes('substitution'))
      const selects = lsof ? lsofSelectsOwn(lsof, ctx) : null
      if (selects === 'own') return one()
      if (selects === 'unknown')
        return [hit('sensitive.claudedeckProcess', cmd, index, { cap: 'ask' })]
    }
    return []
  }
  if (name === 'osascript') {
    // `osascript -e 'quit app "ClaudeDeck"'`, `tell application "ClaudeDeck" to quit`.
    const code = texts.join('\n')
    if (
      /\bquit\s+(app|application)\s+(id\s+)?["'](ClaudeDeck|Electron)/i.test(code) ||
      /\btell\s+(app|application)\s+(id\s+)?["'](ClaudeDeck|Electron)[^"']*["']\s+to\s+quit\b/i.test(
        code
      ) ||
      /\bkill\b[^\n]*\b(ClaudeDeck|Electron)\b/i.test(code)
    )
      return one()
    return []
  }
  if (name === 'netsh' && ctx.hookPort !== undefined) {
    // A firewall rule blocking the hook server's port.
    const code = texts.join(' ')
    if (
      /\bblock\b/i.test(code) &&
      new RegExp(`port=([\\d,-]*,)?${ctx.hookPort}\\b`, 'i').test(code)
    )
      return one()
    return []
  }
  if (name === 'pkill' || name === 'pgrep') {
    if (name === 'pgrep') return []
    const values = new Set([
      '-u',
      '-U',
      '-g',
      '-G',
      '-t',
      '-s',
      '-P',
      '--signal',
      '-F',
      '--pidfile'
    ])
    const pattern = positionals(
      args.filter((a) => !KILL_SIGNAL.test(a.text)),
      values
    )[0]
    if (!pattern) return []
    const full = args.some(
      (a) => a.text === '-f' || a.text === '--full' || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a.text)
    )
    const ci = args.some((a) => a.text === '-i' || a.text === '--ignore-case')
    return pattern.opaque || selectsOwn(pattern.text, full, ci) ? one() : []
  }
  if (name === 'killall') {
    const regex = args.some((a) => a.text === '-r' || a.text === '--regexp' || a.text === '-m')
    const list = positionals(
      args.filter((a) => !KILL_SIGNAL.test(a.text) || a.text === '-u'),
      new Set(['-u', '-t', '-c', '-s', '--signal', '-o', '-y'])
    )
    return list.some(
      (p) => p.opaque || (regex ? selectsOwn(p.text, false, true) : namesOwn(p.text))
    )
      ? one()
      : []
  }
  if (name === 'taskkill') {
    const im = args.findIndex((a) => /^\/im$/i.test(a.text))
    return im >= 0 && args[im + 1] && namesOwn(args[im + 1].text) ? one() : []
  }
  if (name === 'stop-process') {
    const target = psValue(args, 'name', 1)
    return target && namesOwn(target.text) ? one() : []
  }
  return []
}

/* Login items, launch agents and scheduled jobs --------------------------------------------- */

const LAUNCHCTL_ADD = /^(load|bootstrap|enable|submit|kickstart|setenv|unsetenv|config)$/
const PS_AUTOSTART = new Set([
  'register-scheduledtask',
  'new-scheduledtask',
  'new-service',
  'set-scheduledtask'
])

function autostartHits(cmd: Cmd, index: number): Hit[] {
  const { name, args } = cmd
  const texts = args.map((a) => a.text)
  const one = (): Hit[] => [hit('system.autostart', cmd, index)]
  if (name === 'launchctl') return LAUNCHCTL_ADD.test(texts[0] ?? '') ? one() : []
  if (name === 'crontab') {
    if (texts.some((t) => t === '-l' || t === '-r')) return []
    return one()
  }
  if (name === 'schtasks' && texts.some((t) => /^\/create$/i.test(t))) return one()
  if (name === 'reg' && /^add$/i.test(texts[0] ?? '') && /\\Run(Once)?\b/i.test(texts[1] ?? ''))
    return one()
  if (PS_AUTOSTART.has(name)) return one()
  if (name === 'systemctl' && /^(enable|link)$/.test(positionals(args)[0]?.text ?? '')) return one()
  return []
}

const SHUTDOWN = new Set([
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'stop-computer',
  'restart-computer'
])
const SYSTEMCTL_POWER =
  /^(poweroff|reboot|halt|suspend|hibernate|kexec|soft-reboot|emergency|rescue)$/
const SYSTEMCTL_SERVICE = /^(stop|disable|mask|kill|isolate)$/
const LAUNCHCTL = /^(unload|bootout|disable|remove|kill)$/

function shutdownOrService(cmd: Cmd, index: number): Hit[] {
  const { name, args } = cmd
  const texts = args.map((a) => a.text)
  const power = (): Hit[] => [hit('system.shutdown', cmd, index)]
  const service = (): Hit[] => [hit('system.services', cmd, index)]
  if (SHUTDOWN.has(name)) {
    if (name === 'shutdown' && texts.some((t) => t === '-c' || /^\/a$/i.test(t))) return []
    return power()
  }
  if ((name === 'init' || name === 'telinit') && /^[06]$/.test(texts[0] ?? '')) return power()
  if (name === 'systemctl') {
    const sub = positionals(args)[0]?.text ?? ''
    if (SYSTEMCTL_POWER.test(sub)) return power()
    if (SYSTEMCTL_SERVICE.test(sub)) return service()
    return []
  }
  if (name === 'launchctl') {
    const sub = texts[0] ?? ''
    if (sub === 'reboot') return power()
    return LAUNCHCTL.test(sub) ? service() : []
  }
  if (name === 'osascript' && /\b(shut down|restart|log out)\b/i.test(texts.join(' ')))
    return power()
  if (name === 'service' && /^(stop|disable)$/.test(texts[1] ?? '')) return service()
  if (name === 'sc' && cmd.shell !== 'powershell' && /^(stop|delete|config)$/i.test(texts[0] ?? ''))
    return service()
  if (name === 'sc.exe' || (name === 'sc' && /^(stop|delete|config)$/i.test(texts[0] ?? '')))
    return service()
  if (name === 'net' && /^stop$/i.test(texts[0] ?? '')) return service()
  if (name === 'stop-service' || name === 'remove-service') return service()
  if (name === 'set-service' && /disabled|stopped/i.test(texts.join(' '))) return service()
  if (name === 'crontab' && texts.includes('-r')) return service()
  if (name === 'schtasks' && texts.some((t) => /^\/(delete|end|change)$/i.test(t))) return service()
  return []
}

const ELEVATE = new Set(['sudo', 'doas', 'pkexec', 'run0', 'gsudo', 'runas'])

function elevation(cmd: Cmd, index: number): Hit[] {
  if (ELEVATE.has(cmd.name)) return [hit('system.sudo', cmd, index)]
  if (cmd.name === 'su' && cmd.shell === 'posix') return [hit('system.sudo', cmd, index)]
  if (cmd.name === 'start-process') {
    const verb: Arg | null = psValue(cmd.args, 'verb', 1)
    if (verb && /^runas$/i.test(verb.text)) return [hit('system.sudo', cmd, index)]
    if (psParam(cmd.args, 'verb', 1) && cmd.args.some((a) => /^runas$/i.test(a.text)))
      return [hit('system.sudo', cmd, index)]
  }
  return []
}

export const systemRules: CmdDetector = (cmd, index, ctx, all) => [
  ...elevation(cmd, index),
  ...ownProcessHits(cmd, index, all, ctx),
  ...killHits(cmd, index),
  ...shutdownOrService(cmd, index),
  ...autostartHits(cmd, index),
  ...(cmd.unknownScript ? [hit('system.uncheckedCode', cmd, index)] : [])
]
