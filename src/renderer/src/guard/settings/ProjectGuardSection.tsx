import { ChevronRight, Info, RotateCcw } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { GUARD_ACTIONS, GUARD_CATEGORIES } from '@shared/guardLimits'
import type { GuardCategoryId, GuardRuleInfo, ProjectGuard } from '@shared/types'
import { useApp } from '../../store'
import { Button } from '../../ui/Button'
import { inputClass } from '../../ui/styles'
import {
  INHERIT,
  needsAllowConfirm,
  rulesByCategory,
  withProjectChoice,
  type ProjectChoice
} from '../guardModel'
import { useGuard } from '../guardStore'
import { useAllowConfirm } from './useAllowConfirm'
import { GuardCustomRules } from './GuardCustomRules'
import { GuardTryCommand } from './GuardTryCommand'
import { CATEGORY_ICONS } from './categoryIcons'

const subHeadingClass = 'text-[12px] font-medium text-muted'

/**
 * Project dialog "Command guard" disclosure: per-category overrides on top of the global
 * actions and extra rules for this project. Saved right away, like the sections next to it.
 */
export function ProjectGuardSection({
  projectId
}: {
  projectId: string
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const override = useApp((s) => s.data?.projects.find((p) => p.id === projectId)?.guard)
  const global = useApp((s) => s.data?.settings.guard)
  const saveProject = useGuard((s) => s.saveProject)
  const rules = useGuard((s) => s.rules)
  const { confirm, dialog } = useAllowConfirm()

  useEffect(() => {
    void useGuard.getState().loadRules()
  }, [])

  if (!global) return null

  const save = async (patch: Partial<ProjectGuard> | null): Promise<string | null> => {
    const code = await saveProject(projectId, patch)
    if (code) useApp.getState().setError(code)
    return code
  }
  const categories = override?.categories ?? {}
  const groups = rulesByCategory(rules ?? [])
  const changed = Object.keys(categories).length + (override?.customRules.length ?? 0)
  const choose = (category: GuardCategoryId, choice: ProjectChoice): void =>
    confirm(
      category,
      choice !== INHERIT && needsAllowConfirm(category, choice),
      () => void save({ categories: withProjectChoice(categories, category, choice) })
    )

  return (
    <>
      <details className="group/guard rounded-lg border border-border">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-[13px] hover:bg-fg/[0.03] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
          <ChevronRight
            size={13}
            aria-hidden
            className="text-muted transition-transform group-open/guard:rotate-90 motion-reduce:transition-none"
          />
          <span className="flex-1">{t('settings.sections.guard.label')}</span>
          <span className="text-[11px] text-muted">
            {!global.enabled
              ? t('guard.project.off')
              : changed > 0
                ? t('guard.project.changed', { count: changed })
                : t('guard.project.inherit')}
          </span>
        </summary>
        <div className="space-y-3 px-3 pb-3 pt-1">
          {!global.enabled && (
            <p className="text-[12px] leading-snug text-muted">{t('guard.project.globalOff')}</p>
          )}
          <p className="text-[12px] leading-snug text-muted">{t('guard.project.hint')}</p>
          <ul className="space-y-1.5">
            {GUARD_CATEGORIES.map(({ id }) => {
              const Icon = CATEGORY_ICONS[id]
              const name = t(`guard.categories.${id}`)
              const value = categories[id] ?? INHERIT
              return (
                <li key={id} className="flex items-center gap-2.5">
                  <Icon size={14} aria-hidden className="shrink-0 text-muted" />
                  <span className="flex min-w-0 flex-1 items-center gap-1.5">
                    <span className="truncate">{name}</span>
                    <SpecialRulesInfo rules={groups.get(id) ?? []} />
                  </span>
                  <select
                    aria-label={t('guard.settings.categoryAction', { category: name })}
                    className={`${inputClass} !w-44 shrink-0 !py-1 text-[12px] ${value === INHERIT ? 'text-muted' : ''}`}
                    value={value}
                    onChange={(event) => choose(id, event.target.value as ProjectChoice)}
                  >
                    <option value={INHERIT}>
                      {t('guard.project.inheritAction', {
                        action: t(`guard.actions.${global.categories[id]}`)
                      })}
                    </option>
                    {GUARD_ACTIONS.map((action) => (
                      <option key={action} value={action}>
                        {t(`guard.actions.${action}`)}
                      </option>
                    ))}
                  </select>
                </li>
              )
            })}
          </ul>
          <div className="space-y-1.5">
            <h4 className={subHeadingClass}>{t('guard.project.customRules')}</h4>
            <GuardCustomRules
              rules={override?.customRules ?? []}
              onSave={(customRules) => saveProject(projectId, { customRules })}
            />
          </div>
          <div className="space-y-1.5">
            <h4 className={subHeadingClass}>{t('guard.try.title')}</h4>
            <GuardTryCommand projectId={projectId} />
          </div>
          {override && (
            <Button variant="ghost" className="!px-2" onClick={() => void save(null)}>
              <RotateCcw size={13} aria-hidden />
              {t('guard.project.reset')}
            </Button>
          )}
        </div>
      </details>
      {dialog}
    </>
  )
}

/**
 * Rules that do not simply follow the category action chosen here: capped ones ask at most, and
 * default-deny ones deny unless the category allows.
 */
function SpecialRulesInfo({
  rules
}: {
  rules: readonly GuardRuleInfo[]
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const names = (list: GuardRuleInfo[]): string => list.map((r) => t(r.label)).join(', ')
  const capped = rules.filter((r) => r.maxAction)
  const denied = rules.filter((r) => r.defaultAction)
  const lines = [
    capped.length > 0 ? t('guard.project.cappedRules', { rules: names(capped) }) : null,
    denied.length > 0 ? t('guard.project.defaultRules', { rules: names(denied) }) : null
  ].filter((line): line is string => line !== null)
  if (lines.length === 0) return null
  const text = `${lines.join('. ')}.`
  return (
    <span
      tabIndex={0}
      role="img"
      aria-label={text}
      data-tooltip={text}
      className="shrink-0 rounded text-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
    >
      <Info size={12} aria-hidden />
    </span>
  )
}
