import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PermissionMode } from '@shared/types'
import { useApp } from '../store'
import { sectionTitleClass } from '../ui/styles'
import { Switch } from '../ui/Switch'
import { useBypassConfirm } from './useBypassConfirm'
import { INHERIT, PermissionModeSelect } from './PermissionModeSelect'

function ModeRow({
  label,
  hint,
  children
}: {
  label: string
  hint: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="min-w-0">
        <span className="block">{label}</span>
        <span className="block text-[12px] leading-snug text-muted">{hint}</span>
      </span>
      {children}
    </div>
  )
}

/** Settings > Claude permissions: the starting mode of Claude tabs and the bypass switch. */
export function ClaudePermissionsSection(): React.JSX.Element | null {
  const { t } = useTranslation()
  const claude = useApp((s) => s.data?.settings.claude)
  const setClaudeSettings = useApp((s) => s.setClaudeSettings)
  const { choose, dialog } = useBypassConfirm()
  if (!claude) return null

  return (
    <section className="mt-6 space-y-3">
      <h3 className={sectionTitleClass}>{t('permissions.title')}</h3>
      <ModeRow
        label={t('permissions.mode')}
        hint={t(`permissions.modeHints.${claude.permissionMode}`)}
      >
        <PermissionModeSelect<PermissionMode>
          label={t('permissions.mode')}
          value={claude.permissionMode}
          onChange={(mode) =>
            choose(mode, (permissionMode) => void setClaudeSettings({ permissionMode }))
          }
        />
      </ModeRow>
      <Switch
        label={t('permissions.allowBypass')}
        hint={t('permissions.allowBypassHint')}
        checked={claude.allowBypass}
        onChange={(allowBypass) => {
          if (!allowBypass) void setClaudeSettings({ allowBypass })
          else choose('bypassPermissions', () => void setClaudeSettings({ allowBypass }))
        }}
      />
      <p className="text-[12px] leading-snug text-muted">
        {t('permissions.modeHint')} {t('permissions.testQueueNote')}
      </p>
      {dialog}
    </section>
  )
}

/**
 * Project dialog "Claude permissions" disclosure. Saved right away, like the test queue
 * section next to it.
 */
export function ProjectPermissionsSection({
  projectId
}: {
  projectId: string
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const override = useApp(
    (s) => s.data?.projects.find((p) => p.id === projectId)?.claude?.permissionMode
  )
  const globalMode = useApp((s) => s.data?.settings.claude.permissionMode) ?? 'default'
  const setProjectClaude = useApp((s) => s.setProjectClaude)
  const { choose, dialog } = useBypassConfirm<PermissionMode | typeof INHERIT>()
  const value = override ?? INHERIT
  const effective = override ?? globalMode

  return (
    <>
      <details className="group/pm rounded-lg border border-border">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[13px] hover:bg-fg/[0.03] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
          <ChevronRight
            size={13}
            aria-hidden
            className="text-muted transition-transform group-open/pm:rotate-90 motion-reduce:transition-none"
          />
          <span className="flex-1">{t('permissions.title')}</span>
          <span
            className={`text-[11px] ${effective === 'bypassPermissions' ? 'text-danger' : 'text-muted'}`}
          >
            {override
              ? t(`permissions.modes.${override}`)
              : t('permissions.inherit', { mode: t(`permissions.modes.${globalMode}`) })}
          </span>
        </summary>
        <div className="space-y-3 px-3 pb-3 pt-1">
          <ModeRow
            label={t('permissions.projectLabel')}
            hint={override ? t(`permissions.modeHints.${override}`) : t('permissions.projectHint')}
          >
            <PermissionModeSelect
              label={t('permissions.projectLabel')}
              value={value}
              inheritLabel={t('permissions.inherit', {
                mode: t(`permissions.modes.${globalMode}`)
              })}
              onChange={(mode) =>
                choose(
                  mode,
                  (permissionMode) => void setProjectClaude(projectId, { permissionMode })
                )
              }
            />
          </ModeRow>
          <p className="text-[12px] leading-snug text-muted">{t('permissions.testQueueNote')}</p>
        </div>
      </details>
      {dialog}
    </>
  )
}
