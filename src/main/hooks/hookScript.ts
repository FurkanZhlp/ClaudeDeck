import { shellQuote } from '../env/shellEnv'
import type { OsName } from '../platform/types'

/** Script file in the account's `claudedeck/` folder. */
export const HOOK_SCRIPT_FILE = 'hook.sh'
/** Name of the script before the command guard (test queue only); removed when found. */
export const LEGACY_HOOK_SCRIPT_FILE = 'test-queue.sh'

/** Any hook command pointing at a ClaudeDeck hook script is ours (any account, old names too). */
export const OURS = /claudedeck[\\/](hook|test-queue)\.sh/

/** Env var with the tab's hook base URL, set next to the MCP token. */
export const HOOK_URL_ENV = 'CLAUDEDECK_HOOK_URL'

/** Server path prefix of the hook routes; the script appends `pre` or `post`. */
export const HOOK_PATH_PREFIX = '/hooks/'

export type HookEvent = 'pre' | 'post'

/** Body event of the first pre request: the guard step. Queue polls send `pre`. */
export const GUARD_STEP = 'guard'

/** Body of a pre poll answered without a decision: the script polls again. */
export const WAIT_MARKER = 'claudedeck-wait'
/** Answer of the guard step when the call is allowed and the test queue takes over. */
export const QUEUE_MARKER = 'claudedeck-queue'

/** Tools the PreToolUse hook runs for while the guard is on. */
export const GUARD_MATCHER = 'Bash|PowerShell|Monitor|Write|Edit|MultiEdit|NotebookEdit'
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
}

/**
 * POSIX sh script Claude Code runs for PreToolUse and PostToolUse(Failure) (macOS /bin/sh,
 * Git Bash on Windows).
 *
 * - Does nothing unless the tab's token and hook URL are well formed, so other `claude`
 *   processes on the same config dir and shell tabs are unaffected (exit 0, no output).
 * - The token never reaches argv or a file: the builtin `printf` pipes the body into curl's
 *   stdin. `%s` prints the payload as it is (no escapes or expansions are applied to it).
 * - Pre: first the guard step (`e: guard`, 5 s). Its answer is printed as it is (a deny or ask
 *   decision, or nothing), unless it is QUEUE_MARKER: then the test queue's short polls follow
 *   (`e: pre`, each answered within 20 s; WAIT_MARKER means poll again).
 * - Guard step failures (no connection, a status other than 200, no answer in 5 s) deny the
 *   call while the guard is on; 401 (the server does not know the tab) lets it through.
 * - curl runs in the background and the script `wait`s for it, so a signal (Esc, the hook
 *   timeout) is handled at once: curl gets SIGTERM, the server sees the connection close.
 * - The exit code is always 0: exit 2 would block with the script path as the reason. `-q`
 *   ignores any .curlrc; `--noproxy` keeps loopback off proxies. Answers go to private temp
 *   files (mktemp) that are removed on exit.
 */
export function hookScript({ guard, maxWaitMinutes }: HookScriptOptions): string {
  const polls = prePolls(maxWaitMinutes)
  return [
    '#!/bin/sh',
    '# Generated by ClaudeDeck: command guard and test queue hook. It checks tool calls against',
    '# the guard rules and waits for a free test slot. Outside ClaudeDeck tabs it exits at once.',
    'event=$1',
    'case $event in',
    '  pre|post) ;;',
    '  *) exit 0 ;;',
    'esac',
    `guard=${guard ? 1 : 0}`,
    `polls=${polls}`,
    'token=${CLAUDEDECK_MCP_TOKEN-}',
    `url=\${${HOOK_URL_ENV}-}`,
    '[ ${#token} -eq 64 ] || exit 0',
    'case $token in *[!0-9a-f]*) exit 0 ;; esac',
    'case $url in',
    '  http://127.0.0.1:*/*) ;;',
    '  *) exit 0 ;;',
    'esac',
    'case $url in *[!A-Za-z0-9:/._-]*) exit 0 ;; esac',
    'port=${url#http://127.0.0.1:}',
    'port=${port%%/*}',
    "case $port in ''|*[!0-9]*) exit 0 ;; esac",
    'deny() {',
    `  [ "$guard" = 1 ] && [ "$event" = pre ] && printf '%s\\n' '${GUARD_UNAVAILABLE_REPLY}'`,
    '}',
    'input=$(cat) || { deny; exit 0; }',
    'out=$(mktemp 2>/dev/null) || { deny; exit 0; }',
    'code=$(mktemp 2>/dev/null) || { rm -f "$out"; deny; exit 0; }',
    'pid=',
    'finish() {',
    '  [ -z "$pid" ] || kill -TERM "$pid" 2>/dev/null',
    '  rm -f "$out" "$code"',
    '  exit 0',
    '}',
    'trap finish HUP INT TERM',
    '# send <body event> <route> <seconds>: the answer in $out, its first line in $answer.',
    'send() {',
    '  status=',
    '  answer=',
    '  : >"$out" && : >"$code" || return 0',
    '  printf \'%s\' "{\\"t\\":\\"$token\\",\\"e\\":\\"$1\\",\\"p\\":$input}" |',
    "    curl -q -s --noproxy '*' --connect-timeout 2 --max-time \"$3\" -w '%{http_code}' \\",
    '      -H \'Content-Type: application/json\' --data-binary @- -o "$out" "$url$2" >"$code" &',
    '  pid=$!',
    '  wait "$pid"',
    '  pid=',
    '  IFS= read -r status <"$code" || :',
    '  IFS= read -r answer <"$out" || :',
    '}',
    'if [ "$event" = post ]; then',
    `  send post post ${POST_CURL_MAX_TIME}`,
    '  finish',
    'fi',
    `send ${GUARD_STEP} pre ${GUARD_CURL_MAX_TIME}`,
    'case $status in',
    '  200) ;;',
    '  401) finish ;;',
    '  *) deny; finish ;;',
    'esac',
    `if [ "$answer" != ${QUEUE_MARKER} ]; then`,
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
