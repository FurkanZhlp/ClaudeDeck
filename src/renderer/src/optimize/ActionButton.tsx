import { motion } from 'motion/react'
import type { ReactNode } from 'react'
import { useReduced } from './hooks'

const base =
  'no-drag inline-flex h-11 items-center justify-center gap-2 rounded-xl px-5 text-[14px] font-medium transition-[filter,background-color,color] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-50'

const VARIANTS = {
  primary: 'min-w-[10rem] bg-accent text-accent-fg shadow-sm hover:brightness-110',
  secondary: 'border border-border text-fg hover:bg-panel',
  ghost: 'text-muted hover:bg-panel hover:text-fg'
} as const

/** Large action of the run screen with a light press feedback. */
export function ActionButton({
  variant,
  className = '',
  ...props
}: {
  variant: keyof typeof VARIANTS
  className?: string
  disabled?: boolean
  'data-autofocus'?: boolean
  onClick: () => void
  children: ReactNode
}): React.JSX.Element {
  const reduced = useReduced()
  return (
    <motion.button
      type="button"
      whileTap={reduced ? undefined : { scale: 0.97 }}
      className={`${base} ${VARIANTS[variant]} ${className}`}
      {...props}
    />
  )
}
