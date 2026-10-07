import type { AgentStatus } from '@shared/types'

const STATUS_DOT: Record<AgentStatus, string> = {
  running: 'bg-ok agents-pulse',
  idle: 'bg-warn',
  done: 'bg-muted/60'
}

export function StatusDot({
  status,
  className = 'mt-[5px]'
}: {
  status: AgentStatus
  className?: string
}): React.JSX.Element {
  return (
    <span aria-hidden className={`flex size-2 shrink-0 ${className}`}>
      <span className={`size-2 rounded-full ${STATUS_DOT[status]}`} />
    </span>
  )
}

export function Message({
  icon,
  title,
  body
}: {
  icon: React.ReactNode
  title: string
  body?: string
}): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <div className="flex size-11 items-center justify-center rounded-xl border border-border bg-elevated text-muted">
        {icon}
      </div>
      <h3 className="text-[14px] font-semibold">{title}</h3>
      {body && <p className="max-w-[17rem] leading-relaxed text-muted">{body}</p>}
    </div>
  )
}
