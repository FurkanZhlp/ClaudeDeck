import { Workflow } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useApp } from '../store'
import { Button } from '../ui/Button'
import { useSidePanel } from '../ui/sidePanelStore'
import { runningCount, useAgents } from './agentsStore'
import { useAgentWatch } from './useAgentWatch'

/** Toolbar button for a Claude tab; its badge counts the tab's running agents. */
export function AgentsToggle({ sessionId }: { sessionId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const open = useSidePanel((s) => s.panel === 'agents')
  const toggle = useSidePanel((s) => s.toggle)
  const tabRunning = useApp((s) => s.running[sessionId]?.exitCode === null)
  // A stopped tab has no live agents; it is only read when the panel shows it.
  useAgentWatch(sessionId, tabRunning || open)
  const count = useAgents((s) => (s.sessionId === sessionId ? runningCount(s.agents) : 0))
  const label = open ? t('agents.hide') : t('agents.show')

  return (
    <Button
      variant="ghost"
      aria-pressed={open}
      aria-label={count > 0 ? `${label}, ${t('agents.runningCount', { count })}` : label}
      data-tooltip={label}
      className={`relative px-2 ${open ? 'bg-panel text-fg' : ''}`}
      onClick={() => toggle('agents')}
    >
      <Workflow size={15} aria-hidden />
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
