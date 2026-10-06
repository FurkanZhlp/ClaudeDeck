import type { ReactNode } from 'react'

export function Field({
  label,
  children,
  className = ''
}: {
  label: string
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <label className={`block space-y-1.5 ${className}`}>
      <span className="block text-[12px] font-medium text-muted">{label}</span>
      {children}
    </label>
  )
}
