import type { ClaudeSettings, PermissionMode, Project, Session } from './types'

/** Every selectable mode, in the order the UI lists them. */
export const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'manual',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions'
]

export const BYPASS_MODE: PermissionMode = 'bypassPermissions'

/** CLI value per mode; 'default' passes no flag. Manual's config value is `default`. */
const CLI_VALUE: Record<PermissionMode, string | null> = {
  default: null,
  manual: 'default',
  acceptEdits: 'acceptEdits',
  plan: 'plan',
  auto: 'auto',
  dontAsk: 'dontAsk',
  bypassPermissions: 'bypassPermissions'
}

export const PERMISSION_MODE_FLAG = '--permission-mode'
export const ALLOW_BYPASS_FLAG = '--allow-dangerously-skip-permissions'

export const isPermissionMode = (value: unknown): value is PermissionMode =>
  typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value)

export const defaultClaudeSettings = (): ClaudeSettings => ({
  permissionMode: 'default',
  allowBypass: false
})

/** Mode a Claude tab starts in: the tab's choice, else the project's, else the global one. */
export function effectivePermissionMode(
  settings: ClaudeSettings,
  project?: Pick<Project, 'claude'>,
  session?: Pick<Session, 'permissionMode'>
): PermissionMode {
  if (isPermissionMode(session?.permissionMode)) return session.permissionMode
  if (isPermissionMode(project?.claude?.permissionMode)) return project.claude.permissionMode
  return isPermissionMode(settings.permissionMode) ? settings.permissionMode : 'default'
}

/**
 * Extra `claude` arguments for an interactive tab. Empty for 'default' without the allow
 * switch, so the launched command stays exactly what it was before modes existed.
 */
export function permissionModeArgs(mode: PermissionMode, allowBypass: boolean): string[] {
  const value = CLI_VALUE[mode]
  const args = value ? [PERMISSION_MODE_FLAG, value] : []
  // Starting in bypass already puts it in the Shift+Tab cycle.
  if (allowBypass && mode !== BYPASS_MODE) args.push(ALLOW_BYPASS_FLAG)
  return args
}
