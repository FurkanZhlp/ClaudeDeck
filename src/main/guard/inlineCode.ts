/**
 * Code given to an interpreter on its command line (`python -c`, `node -e`, `perl -e`,
 * `osascript -e`, an awk program) or through a heredoc or here-string. The guard never runs it:
 * it looks for shell commands embedded in it and for protected paths next to file APIs.
 */

export interface CodeSource {
  name: string
  args: { text: string; opaque: boolean }[]
  /** Heredoc bodies and here-string texts given to the interpreter on stdin. */
  stdin: string[]
}

const PYTHON = /^python[\d.]*$/
const NODE_LIKE = new Set(['node', 'nodejs', 'bun'])
const AWK = new Set(['awk', 'gawk', 'mawk', 'nawk'])
const CODE_FLAGS: Record<string, readonly string[]> = {
  python: ['-c'],
  node: ['-e', '--eval', '-p', '--print'],
  perl: ['-e', '-E'],
  ruby: ['-e'],
  php: ['-r'],
  osascript: ['-e'],
  deno: ['eval']
}

const kindOf = (name: string): string | null => {
  if (PYTHON.test(name)) return 'python'
  if (NODE_LIKE.has(name)) return 'node'
  if (AWK.has(name)) return 'awk'
  return name in CODE_FLAGS ? name : null
}

/** An interpreter the guard reads inline code of. */
export const isInterpreter = (name: string): boolean => kindOf(name) !== null

/** Inline code texts of an interpreter call; empty when there is none (a script file). */
export function inlineCode(source: CodeSource): string[] {
  const kind = kindOf(source.name)
  if (!kind) return []
  const out: string[] = []
  const { args } = source
  if (kind === 'awk') {
    // The program is the first word that is not an option, unless it comes from -f.
    if (args.some((a) => a.text === '-f' || a.text.startsWith('--file'))) return source.stdin
    for (let i = 0; i < args.length; i++) {
      const t = args[i].text
      if (/^-[vF]$/.test(t)) {
        i++
        continue
      }
      if (t.startsWith('-') && t !== '-') continue
      out.push(t)
      break
    }
    return [...out, ...source.stdin]
  }
  const flags = CODE_FLAGS[kind]
  let scriptFile = false
  for (let i = 0; i < args.length; i++) {
    const t = args[i].text
    const glued = flags.find((f) => f.startsWith('--') && t.startsWith(`${f}=`))
    if (glued) out.push(t.slice(glued.length + 1))
    else if (flags.includes(t) && args[i + 1]) out.push(args[++i].text)
    else if (kind === 'python' && /^-[A-Za-z]*c$/.test(t) && args[i + 1]) {
      out.push(args[++i].text)
      break
    } else if (!t.startsWith('-') && !out.length) {
      scriptFile = true
      break
    }
  }
  return scriptFile || out.length ? out : source.stdin
}

const unescape = (text: string): string => text.replace(/\\(["'\\`$])/g, '$1')

/** Shell command lines embedded in code: `system("...")`, `do shell script "..."`, backticks. */
export function embeddedShell(code: string, name: string): string[] {
  const out: string[] = []
  const add = (text: string | undefined): void => {
    if (text && out.length < 32) out.push(unescape(text))
  }
  for (const m of code.matchAll(/do shell script\s+"((?:[^"\\]|\\.)*)"/gi)) add(m[1])
  const call =
    /\b(?:system|popen|exec|execSync|execFileSync|spawnSync|shell_exec|passthru|getoutput|getstatusoutput|check_output|check_call|call|run|Popen|qx)\s*\(\s*[rfbu]?(["'`])((?:\\.|(?!\1)[^\\])*)\1/g
  for (const m of code.matchAll(call)) add(m[2])
  if (name === 'perl' || name === 'ruby') {
    for (const m of code.matchAll(/`((?:\\.|[^`\\])*)`/g)) add(m[1])
    for (const m of code.matchAll(/\b(?:qx|%x)\s*[({[]([^)}\]]*)[)}\]]/g)) add(m[1])
  }
  return out
}

/** File APIs that delete, write, move or change permissions, or run commands. */
export const CHANGE_API =
  /\b(rmtree|rmdir|removedirs|unlink|remove|rmSync|rmdirSync|unlinkSync|rm_rf|rm_r|rm_f|remove_tree|remove_dir_all|remove_file|truncate|writeFile|writeFileSync|appendFile|appendFileSync|write_text|write_bytes|write|chmod|chown|rename|renameSync|move|copyfile|copytree|copyFileSync|cpSync|symlink|symlinkSync|system|exec|execSync|spawn|spawnSync|popen|Popen|delete|DeleteFile|trash|File::Path)\b|\bopen\s*\([^)]*,\s*["'][wax+]|do shell script/i

/** File APIs that read a file (for private keys). */
export const READ_API =
  /\b(open|read|readFile|readFileSync|read_text|read_bytes|File\.read|IO\.read|slurp|file_get_contents|fopen|cat)\b/

/** Paths named in code: string literals that are absolute or start at the home folder. */
export function codePaths(code: string): string[] {
  const out = new Set<string>()
  for (const m of code.matchAll(
    /(["'`])((?:~|\/|[A-Za-z]:[\\/]|\$HOME\b|\$\{HOME\})[^"'`\n]*)\1/g
  )) {
    out.add(m[2])
  }
  if (
    /Path\.home\(\)|os\.homedir\(\)|process\.env\.HOME\b|\$ENV\{HOME\}|ENV\[["']HOME["']\]|getenv\(\s*["']HOME["']\s*\)|environ\[["']HOME["']\]|expanduser\(\s*["']~["']\s*\)|path to home folder/i.test(
      code
    )
  ) {
    out.add('~')
  }
  return [...out].slice(0, 64)
}
