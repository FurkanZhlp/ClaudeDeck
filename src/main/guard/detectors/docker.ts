import { hasFlag, positionals, type Arg } from '../commands'
import { hit, type CmdDetector } from './types'

/** Docker data loss: prunes, volume removal, mass removal; pushes count as publishing. */

const ENGINES = new Set(['docker', 'podman', 'nerdctl'])
const GLOBAL_FLAGS = new Set(['--context', '-c', '-H', '--host', '--config', '-l', '--log-level'])
const COMPOSE_FLAGS = new Set([
  '-f',
  '--file',
  '-p',
  '--project-name',
  '--profile',
  '--env-file',
  '--project-directory',
  '--ansi',
  '--parallel'
])

function skip(args: Arg[], from: number, valueFlags: ReadonlySet<string>): number {
  let i = from
  while (i < args.length && args[i].text.startsWith('-')) {
    const t = args[i].text
    i++
    if (!t.includes('=') && valueFlags.has(t)) i++
  }
  return i
}

export const dockerRules: CmdDetector = (cmd, index) => {
  const one = (id: string): ReturnType<CmdDetector> => [hit(id, cmd, index)]
  let args: Arg[]
  let compose = false
  if (cmd.name === 'docker-compose' || cmd.name === 'podman-compose') {
    compose = true
    args = cmd.args.slice(skip(cmd.args, 0, COMPOSE_FLAGS))
  } else if (ENGINES.has(cmd.name)) {
    args = cmd.args.slice(skip(cmd.args, 0, GLOBAL_FLAGS))
    if (args[0]?.text === 'compose') {
      compose = true
      args = args.slice(skip(args, 1, COMPOSE_FLAGS))
    }
  } else {
    return []
  }
  const [a = '', b = ''] = args.map((x) => x.text)
  const rest = args.slice(1)
  if (compose) {
    return a === 'down' && hasFlag(rest, 'v', '--volumes') ? one('docker.volumes') : []
  }
  // `docker container rm` = `docker rm`, `docker image rm` = `docker rmi`.
  const group = ['container', 'image', 'volume', 'system', 'builder', 'network', 'buildx'].includes(
    a
  )
    ? a
    : ''
  const verb = group ? b : a
  const verbArgs = group ? args.slice(2) : rest
  const many = (list: Arg[]): boolean => {
    const targets = positionals(list, new Set(['-t', '--time', '-s', '--signal', '--filter']))
    return targets.some((t) => t.opaque) || targets.length >= 3
  }
  if (verb === 'prune') {
    if (group === 'system' || group === 'container' || group === 'network')
      return one('docker.prune')
    if (group === 'volume') return one('docker.volumes')
    if (
      (group === 'image' || group === 'builder' || group === 'buildx') &&
      hasFlag(verbArgs, 'a', '--all')
    ) {
      return one('docker.prune')
    }
    return []
  }
  if (group === 'volume' && (verb === 'rm' || verb === 'remove')) return one('docker.volumes')
  if (
    verb === 'push' ||
    (group === 'buildx' && verb === 'build' && hasFlag(verbArgs, '', '--push')) ||
    (verb === 'build' && hasFlag(verbArgs, '', '--push'))
  ) {
    return one('publish.dockerPush')
  }
  if (group === 'image' ? verb === 'rm' : verb === 'rmi') {
    return many(verbArgs) ? one('docker.removeMany') : []
  }
  if ((group === '' || group === 'container') && ['rm', 'kill', 'stop'].includes(verb)) {
    return many(verbArgs) ? one('docker.removeMany') : []
  }
  return []
}
