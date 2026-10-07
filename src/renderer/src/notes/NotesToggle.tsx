import { NotebookText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button'
import { useSidePanel } from '../ui/sidePanelStore'
import { useNoteList } from './useNoteList'

export function NotesToggle({ projectId }: { projectId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const open = useSidePanel((s) => s.panel === 'notes')
  const toggle = useSidePanel((s) => s.toggle)
  const count = useNoteList(projectId).notes?.length ?? 0
  const label = open ? t('notes.hide') : t('notes.show')

  return (
    <Button
      variant="ghost"
      aria-pressed={open}
      aria-label={count > 0 ? `${label}, ${t('notes.count', { count })}` : label}
      data-tooltip={label}
      className={`relative px-2 ${open ? 'bg-panel text-fg' : ''}`}
      onClick={() => toggle('notes')}
    >
      <NotebookText size={15} aria-hidden />
      {count > 0 && (
        <span
          aria-hidden
          className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-accent-fg tabular-nums"
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Button>
  )
}
