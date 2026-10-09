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
  deno: ['eval'],
  swift: ['-e']
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

/** String literals of a code list (`["rm", "-rf", "/x"]`), quoted for the shell. */
function listItems(list: string): string[] | null {
  const items: string[] = []
  const re = /\s*([rfbu]?)(["'])((?:\\.|(?!\2)[^\\])*)\2\s*(,|$)/gy
  let m: RegExpExecArray | null
  while ((m = re.exec(list)) && items.length < 64) {
    items.push(`'${unescape(m[3]).replace(/'/g, `'\\''`)}'`)
    if (re.lastIndex >= list.length) return items
  }
  return items.length && re.lastIndex >= list.trimEnd().length ? items : null
}

/** Shell command lines embedded in code: `system("...")`, `do shell script "..."`, backticks. */
export function embeddedShell(code: string, name: string): string[] {
  const out: string[] = []
  const add = (text: string | undefined): void => {
    if (text && out.length < 32) out.push(unescape(text))
  }
  for (const m of code.matchAll(/do shell script\s+"((?:[^"\\]|\\.)*)"/gi)) add(m[1])
  // Argument lists: `subprocess.run(["rm", "-rf", "/x"])`, `spawnSync("sh", ["-c", "..."])`.
  const lists =
    /\b(?:run|call|Popen|check_call|check_output|spawn|spawnSync|execFile|execFileSync|execv\w*|system)\s*\(\s*(?:([rfbu]?["'])([^"'\n]{1,200})["']\s*,\s*)?\[([^\]]{0,2000})\]/g
  for (const m of code.matchAll(lists)) {
    const items = listItems(m[3])
    if (!items) continue
    const words = m[2] ? [m[2], ...items] : items
    if (out.length < 32) out.push(words.join(' '))
  }
  const call =
    /\b(?:system|popen|exec|execSync|execFileSync|spawnSync|shell_exec|passthru|getoutput|getstatusoutput|check_output|check_call|call|run|Popen|qx)\s*\(\s*[rfbu]?(["'`])((?:\\.|(?!\1)[^\\])*)\1/g
  for (const m of code.matchAll(call)) add(m[2])
  if (name === 'perl' || name === 'ruby') {
    for (const m of code.matchAll(/`((?:\\.|[^`\\])*)`/g)) add(m[1])
    for (const m of code.matchAll(/\b(?:qx|%x)\s*[({[]([^)}\]]*)[)}\]]/g)) add(m[1])
  }
  return out
}

/** `tell app "Terminal" to do script "..."`: a command line run in a new terminal window. */
export function terminalScripts(code: string): string[] {
  const out: string[] = []
  for (const m of code.matchAll(/\bdo script\s+"((?:[^"\\]|\\.)*)"/gi)) {
    if (out.length < 32) out.push(unescape(m[1]))
  }
  return out
}

/**
 * A process API given something other than a string literal (`os.system(base64...)`,
 * `execSync(cmd)`): the command it runs cannot be read.
 */
export function opaqueShellCall(code: string): boolean {
  return /\b(?:os\.(?:system|popen|exec\w*|spawn\w*)|subprocess\.\w+|child_process\.\w+|execSync|execFileSync|spawnSync|shell_exec|passthru|proc_open|popen|Kernel\.system|IO\.popen|Deno\.run|Deno\.Command)\s*\(\s*(?![rfbu]?["'`[]|\))/.test(
    code
  )
}

/** File APIs that delete, write, move or change permissions, or run commands. */
export const CHANGE_API =
  /\b(removeSync|removeItem|rmtree|rmdir|removedirs|unlink|remove|rmSync|rmdirSync|unlinkSync|rm_rf|rm_r|rm_f|remove_tree|remove_dir_all|remove_file|truncate|writeFile|writeFileSync|appendFile|appendFileSync|write_text|write_bytes|write|chmod|chown|rename|renameSync|move|copyfile|copytree|copyFileSync|cpSync|symlink|symlinkSync|system|exec|execSync|spawn|spawnSync|popen|Popen|delete|DeleteFile|trash|File::Path)\b|\brm\s*\(|\bopen\s*\([^)]*,\s*["'][wax+]|do shell script/i

/** File APIs that read a file (for private keys). */
export const READ_API =
  /\b(open|read|readFile|readFileSync|read_text|read_bytes|File\.read|IO\.read|slurp|file_get_contents|fopen|cat)\b/

/** The code refers to the home folder through an API (`os.homedir()`, `Path.home()`, ...). */
const HOME_API =
  /\.homedir\(\)|Path\.home\(\)|process\.env\.HOME\b|\$ENV\{HOME\}|ENV\[["']HOME["']\]|getenv\(\s*["']HOME["']\s*\)|environ(?:\.get\(|\[)\s*["']HOME["']|expanduser\(\s*["']~|Dir\.home\b|NSHomeDirectory\(\)|homeDirectoryForCurrentUser|Deno\.env\.get\(\s*["']HOME["']|UserHomeDir\(\)|path to home folder/i

/** Paths named in code: string literals that are absolute or start at the home folder. */
export function codePaths(code: string): string[] {
  const out = new Set<string>()
  for (const m of code.matchAll(
    /(["'`])((?:~|\/|[A-Za-z]:[\\/]|\$HOME\b|\$\{HOME\})[^"'`\n]*)\1/g
  )) {
    out.add(m[2])
  }
  if (HOME_API.test(code)) out.add('~')
  return [...out].slice(0, 64)
}

/** Relative paths into a `.claude` folder named in code (`open(".claude/settings.json", "w")`). */
export function codeClaudePaths(code: string): string[] {
  const out = new Set<string>()
  for (const m of code.matchAll(/(["'`])((?:\.{1,2}[\\/])*\.claude(?:[\\/][^"'`\n]*)?)\1/gi)) {
    out.add(m[2])
  }
  return [...out].slice(0, 64)
}
