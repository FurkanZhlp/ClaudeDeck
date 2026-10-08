import { positionals, type Arg, type Cmd } from '../commands'
import { psParam, psValue } from '../targets'
import { hit, type CmdDetector, type Hit } from './types'

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

export const systemRules: CmdDetector = (cmd, index) => [
  ...elevation(cmd, index),
  ...killHits(cmd, index),
  ...shutdownOrService(cmd, index)
]
