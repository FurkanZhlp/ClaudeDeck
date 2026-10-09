import { shellQuote } from '../env/shellEnv'
import type { OsName } from '../platform/types'

/** Script file in the account's `claudedeck/` folder. */
export const HOOK_SCRIPT_FILE = 'hook.sh'
/** Name of the script before the command guard (test queue only); removed when found. */
export const LEGACY_HOOK_SCRIPT_FILE = 'test-queue.sh'

/** A hook command ClaudeDeck generated: `/bin/sh '<...>/claudedeck/hook.sh' pre` (old names too). */
export const OURS =
  /^\/bin\/sh '(?:[^']|'\\'')*[\\/]claudedeck[\\/](hook|test-queue)\.sh' (pre|post)$/

/**
 * Env var with the tab's hook base URL, set next to the MCP token. Informational only: the
 * script takes the URL from the protected key file, never from the environment (a process in
 * the tab could point it at a server of its own that allows everything).
 */
export const HOOK_URL_ENV = 'CLAUDEDECK_HOOK_URL'

/** Server path prefix of the hook routes; the script appends `pre` or `post`. */
export const HOOK_PATH_PREFIX = '/hooks/'

export type HookEvent = 'pre' | 'post'

/** Route of guard-only calls authenticated with the account's guard key. */
export const GUARD_ROUTE = 'guard'
/**
 * Per-account file next to the script, one value per line: the guard key (64 hex), the hook
 * base URL, ClaudeDeck's process id and that process's start time (`ps -o lstart=`, blanks
 * collapsed; empty where unknown). The script takes the server URL only from here; claude
 * processes that lost the tab's env (`env -i claude`) still reach the guard with the key.
 */
export const GUARD_KEY_FILE = 'guard.key'

/** Contents of the guard key file. */
export function guardKeyFile(entry: {
  key: string
  url: string | null
  pid?: number | null
  startTime?: string | null
}): string {
  const start = (entry.startTime ?? '').replace(/\s+/g, ' ').trim()
  return `${entry.key}\n${entry.url ?? ''}\n${entry.pid ?? ''}\n${start}\n`
}

/** Body event of the first pre request: the guard step. Queue polls send `pre`. */
export const GUARD_STEP = 'guard'

/** Body of a pre poll answered without a decision: the script polls again. */
export const WAIT_MARKER = 'claudedeck-wait'
/** Answer of the guard step when the call is allowed and the test queue takes over. */
export const QUEUE_MARKER = 'claudedeck-queue'

/** Tools the PreToolUse hook runs for while the guard is on. */
export const GUARD_MATCHER = 'Bash|PowerShell|Monitor|Write|Edit|MultiEdit|NotebookEdit|Read|Grep'
/** Tools the test queue handles (pre and post). */
export const QUEUE_MATCHER = 'Bash|PowerShell'

/** Seconds a post hook (and its curl) may take. */
export const POST_HOOK_TIMEOUT_SECONDS = 10
const POST_CURL_MAX_TIME = 8
/** One queue poll: the server answers within 20 s (a decision or WAIT_MARKER). */
export const PRE_CURL_MAX_TIME = 30
/** The guard step: the server answers at once; no answer in time counts as a failure. */
export const GUARD_CURL_MAX_TIME = 5
/** Hook timeout while only the guard is on. */
export const GUARD_HOOK_TIMEOUT_SECONDS = 30
const MAX_WAIT_RANGE = { min: 1, max: 240 }

/**
 * Fixed answer of the script when the guard step fails for a ClaudeDeck tab (server gone, an
 * error, no answer within 5 s): the call is denied rather than let through unchecked.
 */
export const GUARD_UNAVAILABLE_REPLY = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason:
      'ClaudeDeck command guard is unavailable, so this tool call was blocked. Ask the user to check that ClaudeDeck is running, then try again.'
  },
  systemMessage: 'ClaudeDeck command guard is unavailable; the tool call was blocked.'
})

function checkMaxWait(maxWaitMinutes: number): number {
  if (
    !Number.isInteger(maxWaitMinutes) ||
    maxWaitMinutes < MAX_WAIT_RANGE.min ||
    maxWaitMinutes > MAX_WAIT_RANGE.max
  ) {
    throw new RangeError(`invalid max wait: ${maxWaitMinutes}`)
  }
  return maxWaitMinutes
}

/** The hook may run 60 s past the queue's own max wait. */
export const preHookTimeout = (maxWaitMinutes: number): number =>
  checkMaxWait(maxWaitMinutes) * 60 + 60

/** Polls a pre hook makes at most: the hook timeout over the shortest useful poll (10 s). */
export const prePolls = (maxWaitMinutes: number): number =>
  Math.ceil(preHookTimeout(maxWaitMinutes) / 10)

/** Hook base URL for a running server (`http://127.0.0.1:<port>/hooks/`). */
export function hookBaseUrl(serverUrl: string): string {
  const url = new URL(serverUrl)
  return `${url.protocol}//${url.host}${HOOK_PATH_PREFIX}`
}

export interface HookScriptOptions {
  /** Guard on: a failed guard step denies the call (fail closed for ClaudeDeck tabs). */
  guard: boolean
  /** Test queue max wait; sets the number of queue polls. */
  maxWaitMinutes: number
  /**
   * Host OS. On Windows (Git Bash) the process check of the key file is skipped: a refused
   * connection alone means ClaudeDeck is not running.
   */
  os?: OsName
}

/**
 * POSIX sh script Claude Code runs for PreToolUse and PostToolUse(Failure) (macOS /bin/sh,
 * Git Bash on Windows).
 *
 * - The server URL comes only from the account's key file next to the script (GUARD_KEY_FILE),
 *   which the guard protects; the environment gives the tab's token and nothing else.
 * - A ClaudeDeck tab is recognised by its token (env). Without it, while the guard is on, the
 *   script uses the account key from the file: a claude process started from a tab with a
 *   cleared env is still checked (guard only, no queue). Without either it does nothing
 *   (exit 0, no output), so other `claude` processes on the same config dir are unaffected. A
 *   tab token without a usable key file is denied while the guard is on.
 * - The token or key never reaches argv: the builtin `printf` pipes the body into curl's
 *   stdin. `%s` prints the payload as it is (no escapes or expansions are applied to it).
 * - Pre: first the guard step (`e: guard`, 5 s). Its answer is printed as it is (a deny or ask
 *   decision, or nothing), unless it is QUEUE_MARKER: then the test queue's short polls follow
 *   (`e: pre`, each answered within 20 s; WAIT_MARKER means poll again).
 * - Guard step failures (no connection, a status other than 200, no answer in 5 s) deny the
 *   call while the guard is on. A tab token the server does not know (401) falls back to the
 *   key, and is denied without one. With the key, no connection lets the call through only when
 *   ClaudeDeck's process (pid and start time from the key file) is gone; while it lives the
 *   call is denied (its server is blocked or stopped, not absent).
 * - A signal during the guard step (the hook timeout, a kill) denies the call before exiting.
 * - curl runs in the background and the script `wait`s for it, so a signal (Esc, the hook
 *   timeout) is handled at once: curl gets SIGTERM, the server sees the connection close.
 * - The exit code is always 0: exit 2 would block with the script path as the reason. `-q`
 *   ignores any .curlrc; `--noproxy` keeps loopback off proxies. Answers go to private temp
 *   files (mktemp) that are removed on exit.
 */
export function hookScript({ guard, maxWaitMinutes, os }: HookScriptOptions): string {
  const polls = prePolls(maxWaitMinutes)
  const processCheck =
    os === 'win32'
      ? [
          '# Windows: a refused connection alone means ClaudeDeck is not running.',
          'alive() { return 1; }'
        ]
      : [
          '# ClaudeDeck still runs: its pid is alive and started when the key file says.',
          'alive() {',
          '  [ -n "$kpid" ] || return 1',
          '  kill -0 "$kpid" 2>/dev/null || return 1',
          '  [ -n "$kstart" ] || return 0',
          '  now=$(LC_ALL=C ps -o lstart= -p "$kpid" 2>/dev/null) || return 0',
          '  set -f',
          '  set -- $now',
          '  set +f',
          '  [ "$*" = "$kstart" ]',
          '}'
        ]
  return [
    '#!/bin/sh',
    '# Generated by ClaudeDeck: command guard and test queue hook. It checks tool calls against',
    '# the guard rules and waits for a free test slot. Outside ClaudeDeck it exits at once.',
    'event=$1',
    'case $event in',
    '  pre|post) ;;',
    '  *) exit 0 ;;',
    'esac',
    `guard=${guard ? 1 : 0}`,
    `polls=${polls}`,
    'hex64() {',
    '  [ ${#1} -eq 64 ] || return 1',
    '  case $1 in *[!0-9a-f]*) return 1 ;; esac',
    '}',
    'hookurl() {',
    '  case $1 in',
    '    http://127.0.0.1:*/*) ;;',
    '    *) return 1 ;;',
    '  esac',
    '  case $1 in *[!A-Za-z0-9:/._-]*) return 1 ;; esac',
    '  p=${1#http://127.0.0.1:}',
    '  p=${p%%/*}',
    "  case $p in ''|*[!0-9]*) return 1 ;; esac",
    '}',
    "# The key file next to this script: the key, the hook URL, ClaudeDeck's pid and start time.",
    'key=',
    'keyurl=',
    'kpid=',
    'kstart=',
    'case $0 in',
    `  */*) keyfile=\${0%/*}/${GUARD_KEY_FILE} ;;`,
    `  *\\\\*) keyfile=\${0%\\\\*}/${GUARD_KEY_FILE} ;;`,
    `  *) keyfile=./${GUARD_KEY_FILE} ;;`,
    'esac',
    'if [ -f "$keyfile" ]; then',
    '  { IFS= read -r key; IFS= read -r keyurl; IFS= read -r kpid; IFS= read -r kstart; } <"$keyfile" 2>/dev/null || :',
    'fi',
    'hex64 "$key" || key=',
    'hookurl "$keyurl" || keyurl=',
    "case $kpid in ''|*[!0-9]*) kpid= ;; esac",
    'deny() {',
    `  [ "$guard" = 1 ] && [ "$event" = pre ] && printf '%s\\n' '${GUARD_UNAVAILABLE_REPLY}'`,
    '}',
    'token=${CLAUDEDECK_MCP_TOKEN-}',
    'url=$keyurl',
    'route=pre',
    'if hex64 "$token" && [ -n "$url" ]; then',
    '  mode=tab',
    'elif [ "$guard" = 1 ] && [ "$event" = pre ] && [ -n "$key" ] && [ -n "$url" ]; then',
    '  mode=key',
    '  token=$key',
    `  route=${GUARD_ROUTE}`,
    'elif hex64 "$token"; then',
    '  # A tab without a usable key file: the guard cannot be reached safely.',
    '  cat >/dev/null 2>&1',
    '  deny',
    '  exit 0',
    'else',
    '  exit 0',
    'fi',
    ...processCheck,
    'input=$(cat) || { deny; exit 0; }',
    'out=$(mktemp 2>/dev/null) || { deny; exit 0; }',
    'code=$(mktemp 2>/dev/null) || { rm -f "$out"; deny; exit 0; }',
    'pid=',
    'stage=',
    'finish() {',
    '  [ -z "$pid" ] || kill -TERM "$pid" 2>/dev/null',
    '  rm -f "$out" "$code"',
    '  # Stopped while the guard was checking: the call is denied, not let through.',
    '  [ "$stage" = guard ] && deny',
    '  exit 0',
    '}',
    'trap finish HUP INT TERM',
    '# send <body event> <route> <seconds>: the answer in $out, its first line in $answer,',
    "# curl's exit code in $rc and whether it connected at all in $connected.",
    'send() {',
    '  status=',
    '  answer=',
    '  rc=0',
    '  connected=',
    '  : >"$out" && : >"$code" || return 0',
    '  printf \'%s\' "{\\"t\\":\\"$token\\",\\"e\\":\\"$1\\",\\"p\\":$input}" |',
    "    curl -q -s --noproxy '*' --connect-timeout 2 --max-time \"$3\" -w '%{http_code} %{time_connect}' \\",
    '      -H \'Content-Type: application/json\' --data-binary @- -o "$out" "$url$2" >"$code" &',
    '  pid=$!',
    '  wait "$pid"',
    '  rc=$?',
    '  pid=',
    '  read -r status connect <"$code" || :',
    '  case $connect in *[1-9]*) connected=1 ;; esac',
    '  IFS= read -r answer <"$out" || :',
    '}',
    'if [ "$event" = post ]; then',
    `  [ "$mode" = tab ] && send post post ${POST_CURL_MAX_TIME}`,
    '  finish',
    'fi',
    'stage=guard',
    `send ${GUARD_STEP} "$route" ${GUARD_CURL_MAX_TIME}`,
    '# A tab token the server does not know: the account key, when there is one.',
    'if [ "$status" = 401 ] && [ "$mode" = tab ] && [ "$guard" = 1 ] && [ -n "$key" ]; then',
    '  mode=key',
    '  token=$key',
    `  route=${GUARD_ROUTE}`,
    `  send ${GUARD_STEP} "$route" ${GUARD_CURL_MAX_TIME}`,
    'fi',
    '# With the key, no connection while ClaudeDeck is gone means it is not running: pass.',
    'case $mode:$status in',
    '  *:200) ;;',
    '  key:000)',
    '    if { [ "$rc" = 7 ] || [ -z "$connected" ]; } && ! alive; then stage=; finish; fi',
    '    stage=; deny; finish ;;',
    '  *) stage=; deny; finish ;;',
    'esac',
    'stage=',
    `if [ "$mode" = key ] || [ "$answer" != ${QUEUE_MARKER} ]; then`,
    '  cat "$out" 2>/dev/null',
    '  finish',
    'fi',
    'n=0',
    'while [ "$n" -lt "$polls" ]; do',
    '  n=$((n + 1))',
    `  send pre pre ${PRE_CURL_MAX_TIME}`,
    `  [ "$answer" = ${WAIT_MARKER} ] || break`,
    'done',
    `[ "$answer" = ${WAIT_MARKER} ] || [ "$answer" = ${QUEUE_MARKER} ] || cat "$out" 2>/dev/null`,
    'finish',
    ''
  ].join('\n')
}

/**
 * settings.json `command` for one event: `/bin/sh '<script>' pre`. On Windows Claude Code runs
 * hooks with Git Bash, which reads `C:/...` paths; backslashes are turned into slashes.
 */
export function hookCommand(scriptPath: string, event: HookEvent, os: OsName): string {
  const path = os === 'win32' ? scriptPath.replace(/\\/g, '/') : scriptPath
  return `/bin/sh ${shellQuote(path)} ${event}`
}
