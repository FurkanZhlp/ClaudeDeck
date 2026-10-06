import { ChevronDown } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useId, useState, type ReactNode } from 'react'
import { revealVariants } from './motionPresets'

export const linkButtonClass =
  'no-drag inline-flex items-center gap-1 rounded text-[12px] font-medium text-muted transition-colors hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent'

/** A quiet toggle that reveals secondary content (full texts, diffs, backup path). */
export function Disclosure({
  label,
  openLabel,
  className = '',
  children
}: {
  label: string
  /** Toggle text while open; defaults to `label`. */
  openLabel?: string
  className?: string
  children: ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const bodyId = useId()

  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        className={linkButtonClass}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown
          size={13}
          aria-hidden
          className={`transition-transform duration-200 ${open ? '' : '-rotate-90'}`}
        />
        {open ? (openLabel ?? label) : label}
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            id={bodyId}
            variants={revealVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="mt-2"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
