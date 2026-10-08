import type { ReactNode } from 'react'

/** A labelled settings row with its control on the right. */
export function SettingRow({
  label,
  hint,
  children,
  disabled
}: {
  label: string
  hint?: string
  children: ReactNode
  disabled?: boolean
}): React.JSX.Element {
  return (
    <div className={`flex items-center justify-between gap-4 ${disabled ? 'text-muted' : ''}`}>
      <span className="min-w-0">
        <span className="block">{label}</span>
        {hint && <span className="block text-[12px] leading-snug text-muted">{hint}</span>}
      </span>
      {children}
    </div>
  )
}
