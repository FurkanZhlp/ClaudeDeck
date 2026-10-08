import { positionals, type Arg } from '../commands'
import { hit, type CmdDetector } from './types'

/** Publishing packages, production deploys, live infrastructure changes and releases. */

const PM_FLAGS = new Set([
  '-C',
  '--dir',
  '--filter',
  '-F',
  '--prefix',
  '-w',
  '--workspace',
  '--cwd',
  '--registry',
  '--tag',
  '--access',
  '--otp'
])

/** First positional words, value flags of package managers skipped. */
const words = (args: Arg[]): string[] => positionals(args, PM_FLAGS).map((a) => a.text)

/** `<tool> <sub>` pairs that publish a package. */
const PACKAGE: Record<string, RegExp> = {
  npm: /^(publish|unpublish)\b/,
  pnpm: /^(publish|unpublish)\b/,
  yarn: /^(publish|npm publish)\b/,
  bun: /^publish\b/,
  cargo: /^(publish|yank)\b/,
  gem: /^(push|yank)\b/,
  twine: /^upload\b/,
  poetry: /^publish\b/,
  uv: /^publish\b/,
  flit: /^publish\b/,
  hatch: /^publish\b/,
  pdm: /^publish\b/,
  nuget: /^push\b/,
  dotnet: /^nuget push\b/,
  pod: /^trunk push\b/,
  vsce: /^publish\b/,
  ovsx: /^publish\b/,
  dart: /^pub publish\b/,
  flutter: /^pub publish\b/,
  deno: /^publish\b/,
  jsr: /^publish\b/,
  changeset: /^publish\b/,
  lerna: /^publish\b/,
  helm: /^push\b/,
  goreleaser: /^release\b(?!.*--snapshot)/
}

/** `<tool> <sub>` pairs that deploy or change live infrastructure. */
const DEPLOY: Record<string, RegExp> = {
  netlify: /^deploy\b.*--prod/,
  firebase: /^deploy\b/,
  wrangler: /^(deploy|publish|pages deploy|delete)\b/,
  fly: /^(deploy|apps destroy)\b/,
  flyctl: /^(deploy|apps destroy)\b/,
  gcloud: /\b(deploy|delete)\b/,
  terraform: /^(apply|destroy)\b/,
  tofu: /^(apply|destroy)\b/,
  pulumi: /^(up|update|destroy)\b/,
  cdk: /^(deploy|destroy)\b/,
  serverless: /^(deploy|remove)\b/,
  sls: /^(deploy|remove)\b/,
  railway: /^(up|down)\b/,
  kubectl: /^delete\b/,
  helm: /^(uninstall|delete)\b/,
  heroku: /^(apps:destroy|pg:reset)\b/,
  amplify: /^publish\b/
}

export const publishRules: CmdDetector = (cmd, index) => {
  const one = (id: string): ReturnType<CmdDetector> => [hit(id, cmd, index)]
  const list = words(cmd.args)
  const line = list.join(' ')
  const full = cmd.args.map((a) => a.text).join(' ')
  const { name } = cmd

  if (PACKAGE[name]?.test(line)) return one('publish.package')
  if (name === 'semantic-release') return one('publish.package')
  if ((name === 'mvn' || name === 'mvnw') && list.includes('deploy')) return one('publish.package')
  if (
    (name === 'gradle' || name === 'gradlew') &&
    list.some((w) => /^publish(?!ToMavenLocal)/i.test(w.split(':').pop() ?? ''))
  ) {
    return one('publish.package')
  }
  if (
    (name === 'vercel' || name === 'vc') &&
    cmd.args.some(
      (a) => a.text === '--prod' || a.text === '--production' || a.text === '--prod=true'
    )
  ) {
    return one('publish.deploy')
  }
  if ((name === 'vercel' || name === 'vc') && /^(remove|rm|promote|rollback)\b/.test(line))
    return one('publish.deploy')
  if (DEPLOY[name] && (DEPLOY[name].test(line) || DEPLOY[name].test(full))) {
    if (name === 'gcloud' && !/\b(app|run|functions|sql|compute|container)\b/.test(line)) return []
    return one('publish.deploy')
  }
  if (
    name === 'gh' &&
    list[0] === 'release' &&
    /^(create|delete|upload|edit)$/.test(list[1] ?? '')
  ) {
    return one('publish.release')
  }
  return []
}
