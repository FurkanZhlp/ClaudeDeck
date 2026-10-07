import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProjectTestQueue } from '@shared/types'
import { useApp } from '../../store'
import { Segmented } from '../../ui/Segmented'
import { useTestQueue } from '../testQueueStore'
import { BuiltinList } from './BuiltinList'
import { CustomRules } from './CustomRules'
import { TryCommand } from './TryCommand'

const INHERIT: ProjectTestQueue = { mode: 'inherit', disabledBuiltins: [], customPatterns: [] }

/**
 * Project dialog "Test queue" disclosure: inherit or off, plus project-only rules. Changes are
 * saved right away (independent of the dialog's Save button), like the global settings.
 */
export function ProjectTestQueueSection({ projectId }: { projectId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const overrides = useApp((s) => s.data?.projects.find((p) => p.id === projectId)?.testQueue)
  const globalEnabled = useApp((s) => s.data?.settings.testQueue.enabled ?? false)
  const globalDisabled = useApp((s) => s.data?.settings.testQueue.disabledBuiltins) ?? []
  const saveProject = useTestQueue((s) => s.saveProject)
  const current = overrides ?? INHERIT

  const save = async (patch: Partial<ProjectTestQueue>): Promise<string | null> => {
    const code = await saveProject(projectId, patch)
    if (code) useApp.getState().setError(code)
    return code
  }
  const off = current.mode === 'off'

  return (
    <details className="group/tq rounded-lg border border-border">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[13px] hover:bg-fg/[0.03] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
        <ChevronRight
          size={13}
          aria-hidden
          className="text-muted transition-transform group-open/tq:rotate-90 motion-reduce:transition-none"
        />
        <span className="flex-1">{t('testQueue.title')}</span>
        <span className="text-[11px] text-muted">
          {t(`testQueue.project.mode.${current.mode}`)}
        </span>
      </summary>
      <div className="space-y-3 px-3 pb-3 pt-1">
        {!globalEnabled && (
          <p className="text-[12px] leading-snug text-muted">{t('testQueue.project.globalOff')}</p>
        )}
        <div className="flex items-center justify-between gap-4">
          <span className="min-w-0">
            <span className="block">{t('testQueue.project.modeLabel')}</span>
            <span className="block text-[12px] leading-snug text-muted">
              {t(`testQueue.project.modeHint.${current.mode}`)}
            </span>
          </span>
          <Segmented<ProjectTestQueue['mode']>
            label={t('testQueue.project.modeLabel')}
            value={current.mode}
            options={[
              { value: 'inherit', label: t('testQueue.project.mode.inherit') },
              { value: 'off', label: t('testQueue.project.mode.off') }
            ]}
            onChange={(mode) => void save({ mode })}
          />
        </div>
        {!off && (
          <>
            <div className="space-y-1.5">
              <h4 className="text-[12px] font-medium text-muted">
                {t('testQueue.project.builtins')}
              </h4>
              <BuiltinList
                disabled={current.disabledBuiltins}
                lockedOff={globalDisabled}
                onChange={(disabledBuiltins) => void save({ disabledBuiltins })}
              />
            </div>
            <div className="space-y-1.5">
              <h4 className="text-[12px] font-medium text-muted">
                {t('testQueue.project.customRules')}
              </h4>
              <CustomRules
                patterns={current.customPatterns}
                onSave={(customPatterns) => saveProject(projectId, { customPatterns })}
              />
            </div>
            <div className="space-y-1.5">
              <h4 className="text-[12px] font-medium text-muted">{t('testQueue.try.title')}</h4>
              <TryCommand projectId={projectId} />
            </div>
          </>
        )}
      </div>
    </details>
  )
}
