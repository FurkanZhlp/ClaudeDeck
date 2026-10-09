import { MessageSquareText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AssistantSection } from '@shared/assistant'
import { Button } from '../ui/Button'
import { useAssistant } from './assistantStore'

/** "Claude ile düzenle" in the settings page header; opens the window for the section. */
export function AssistantHeaderButton({
  section
}: {
  section: AssistantSection | undefined
}): React.JSX.Element {
  const { t } = useTranslation()
  const openWindow = useAssistant((s) => s.openWindow)
  return (
    <Button
      aria-haspopup="dialog"
      data-tooltip={t('assistant.openHint')}
      onClick={() => openWindow({ section })}
      className="shrink-0"
    >
      <MessageSquareText size={14} aria-hidden />
      {t('assistant.open')}
    </Button>
  )
}

/** "Claude ile yaz" next to a rule editor; opens the window pre-scoped to its section. */
export function AssistantInlineButton({
  section,
  hintKey
}: {
  section: AssistantSection
  hintKey: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const openWindow = useAssistant((s) => s.openWindow)
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={() => openWindow({ section, hintKey })}
      className="no-drag inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-medium text-accent hover:bg-accent/10 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
    >
      <MessageSquareText size={12} aria-hidden />
      {t('assistant.writeWithClaude')}
    </button>
  )
}
