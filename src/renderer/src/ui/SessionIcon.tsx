import { Bot, SquareTerminal } from 'lucide-react'
import type { SessionKind } from '@shared/types'
import type { Running } from '../store'

export function SessionIcon({
  kind,
  size = 13
}: {
  kind: SessionKind
  size?: number
}): React.JSX.Element {
  return kind === 'claude' ? (
    <Bot size={size} className="shrink-0" />
  ) : (
    <SquareTerminal size={size} className="shrink-0" />
  )
}

export function StatusDot({ run }: { run: Running | undefined }): React.JSX.Element | null {
  if (!run) return null
  const color = run.exitCode === null ? 'bg-ok' : 'bg-muted'
  return <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${color}`} />
}
