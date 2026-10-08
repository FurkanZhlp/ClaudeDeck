import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../../store'
import { useGuard } from '../guardStore'

/**
 * Readable rule names: a built-in rule's label, or a custom rule's pattern (global or of the
 * given project). Unknown ids (a rule removed since) show as they are.
 */
export function useRuleLabeler(): (ruleId: string | undefined, projectId?: string) => string {
  const { t } = useTranslation()
  const rules = useGuard((s) => s.rules)
  const global = useApp((s) => s.data?.settings.guard.customRules)
  const projects = useApp((s) => s.data?.projects)

  useEffect(() => {
    void useGuard.getState().loadRules()
  }, [])

  return (ruleId, projectId) => {
    if (!ruleId) return ''
    const builtin = rules?.find((r) => r.id === ruleId)
    if (builtin) return t(builtin.label)
    const local = projects?.find((p) => p.id === projectId)?.guard?.customRules ?? []
    const custom = [...(global ?? []), ...local].find((r) => r.id === ruleId)
    return custom?.pattern ?? ruleId
  }
}
