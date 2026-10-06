import { AlertTriangle } from 'lucide-react'
import type { ReactNode } from 'react'

export function Notice({
  tone,
  children
}: {
  tone: 'warn' | 'danger'
  children: ReactNode
}): React.JSX.Element {
  const color = tone === 'danger' ? 'text-danger' : 'text-warn'
  return (
    <div className="flex gap-2.5 rounded-lg border border-border bg-bg p-3">
      <AlertTriangle size={16} className={`mt-0.5 shrink-0 ${color}`} />
      <div className="min-w-0 flex-1 space-y-3">{children}</div>
    </div>
  )
}
