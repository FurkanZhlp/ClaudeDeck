import { cmdName, positionals, type Cmd } from '../commands'
import { lex, substitutionBodies } from '../../shell/shellLexer'
import { hit, type CmdDetector } from './types'

/** Code downloaded and run in one go: `curl | sh`, `bash <(curl)`, `iwr | iex`. */

const DOWNLOADERS = new Set([
  'curl',
  'wget',
  'fetch',
  'http',
  'https',
  'xh',
  'aria2c',
  'invoke-webrequest',
  'invoke-restmethod'
])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'fish', 'ash'])
const INTERPRETER =
  /^(sh|bash|zsh|dash|ksh|mksh|fish|ash|python[\d.]*|node|nodejs|perl|ruby|php|deno|bun|pwsh|powershell)$/
const EVALUATORS = new Set(['eval', 'source', '.', 'invoke-expression', 'invoke-command'])
const INTERPRETER_VALUE_FLAGS = new Set([
  '-o',
  '-O',
  '+o',
  '+O',
  '-W',
  '-X',
  '-r',
  '--require',
  '-I'
])

const isDownloader = (cmd: Cmd): boolean => DOWNLOADERS.has(cmd.name)

/** Runs code from its standard input: no script file given, or `-`/`-s`. */
function readsStdin(cmd: Cmd): boolean {
  if (cmd.name === 'invoke-expression') return cmd.args.length === 0
  if (!INTERPRETER.test(cmd.name)) return false
  const texts = cmd.args.map((a) => a.text)
  if (texts.some((t) => /^-[a-zA-Z]*c$/.test(t) || t === '-e' || t === '--eval' || t === '-m'))
    return false
  if (texts.includes('-') || texts.includes('-s')) return true
  return positionals(cmd.args, INTERPRETER_VALUE_FLAGS).length === 0
}

/** A substitution text (`$(curl ...)`, `<(wget ...)`, PowerShell `(iwr ...)`) downloads. */
function downloadsIn(text: string, depth = 0): boolean {
  if (depth > 3) return false
  if (/\.Download(String|File|Data)\s*\(/i.test(text)) return true
  for (const body of substitutionBodies(text).concat(
    /^[({]/.test(text) ? [text.slice(1, -1)] : []
  )) {
    for (const segment of lex(body)) {
      const head = segment.words[0]
      if (head && DOWNLOADERS.has(cmdName(head.text))) return true
      if (head && /^(iwr|irm)$/i.test(head.text)) return true
      if (segment.words.some((w) => w.opaque && downloadsIn(w.text, depth + 1))) return true
    }
  }
  return false
}

/** Files the downloader saves (`curl -o f`, `wget -O f`, `-OutFile f`, wget's default name). */
function savedFiles(cmd: Cmd): string[] {
  const out: string[] = []
  const args = cmd.args
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text
    const next = args[i + 1]?.text
    if (
      (t === '-o' ||
        t === '--output' ||
        (cmd.name === 'wget' && t === '-O') ||
        /^-outf/i.test(t)) &&
      next
    )
      out.push(next)
    else if (t.startsWith('--output=') || t.startsWith('--output-document='))
      out.push(t.split('=')[1])
  }
  const urls = args.filter((a) => /^https?:\/\//i.test(a.text)).map((a) => a.text)
  const remoteName =
    cmd.name === 'wget'
      ? !out.length
      : args.some((a) => /^-[A-Za-z]*O[A-Za-z]*$/.test(a.text) || a.text === '--remote-name')
  if (remoteName) {
    for (const url of urls) {
      const name = url.split(/[?#]/)[0].split('/').pop()
      if (name) out.push(name)
    }
  }
  return out
}

const baseName = (path: string): string => path.split(/[\\/]/).pop()?.toLowerCase() ?? ''

/** A command runs `file`: as the program itself or as an interpreter's script. */
function runsFile(cmd: Cmd, file: string): boolean {
  const want = baseName(file)
  if (!want) return false
  if (cmd.name === want) return true
  if (INTERPRETER.test(cmd.name) || EVALUATORS.has(cmd.name)) {
    const script = positionals(cmd.args, INTERPRETER_VALUE_FLAGS)[0]
    return !!script && baseName(script.text) === want
  }
  return false
}

export const fetchExecRules: CmdDetector = (cmd, index, _ctx, all) => {
  // Pipeline: a download earlier in the same pipeline feeds an interpreter.
  if (readsStdin(cmd)) {
    const feeder = all.slice(0, index).some((c) => c.pipeline === cmd.pipeline && isDownloader(c))
    if (feeder) return [hit('fetchExec.pipeShell', cmd, index)]
  }
  // Substitution: `bash <(curl ...)`, `sh -c "$(curl ...)"`, `eval "$(wget -qO- ...)"`, `iex (iwr ...)`.
  if (INTERPRETER.test(cmd.name) || EVALUATORS.has(cmd.name) || SHELLS.has(cmd.name)) {
    if (cmd.args.some((a) => a.opaque && downloadsIn(a.text))) {
      return [hit('fetchExec.substitution', cmd, index)]
    }
  }
  // Downloaded earlier on the same line, run now.
  for (const earlier of all.slice(0, index)) {
    if (!isDownloader(earlier)) continue
    if (savedFiles(earlier).some((file) => runsFile(cmd, file))) {
      return [hit('fetchExec.downloadRun', cmd, index)]
    }
  }
  return []
}
