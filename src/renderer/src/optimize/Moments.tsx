import { CircleAlert, CircleCheck, ScanSearch } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { OptimizeState } from '@shared/types'
import type { FindingLine, FindingTone } from './friendly'
import { thinkingLine } from './friendly'
import { useHeld } from './hooks'
import { lineVariants, momentVariants } from './motionPresets'
import type { RunSummary } from './runEvents'

/** Minimum time a status line stays on screen before the next one replaces it. */
const LINE_HOLD_MS = 1200

const momentClass = 'flex w-full max-w-xl flex-col items-center text-center'

/** The orb and one short line about what Claude is doing; the line crossfades as it changes. */
export function ThinkingMoment({
  run,
  summary
}: {
  run: OptimizeState
  summary: RunSummary
}): React.JSX.Element {
  const { t } = useTranslation()
  const starting = run.status === 'starting'
  const line = useHeld(thinkingLine(summary.latest, starting, t), LINE_HOLD_MS)

  return (
    <motion.div
      variants={momentVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className={momentClass}
    >
      <div className="optimize-orb" aria-hidden>
        <span className="optimize-orb-halo" />
        <span className="optimize-orb-arc" />
        <span className="optimize-orb-core" />
      </div>
      <h2 className="mt-8 text-[20px] font-semibold tracking-tight">
        {t(starting ? 'optimize.thinking.titleStarting' : 'optimize.thinking.title')}
      </h2>
      <div role="status" aria-live="polite" className="mt-2 flex h-6 w-full justify-center">
        <AnimatePresence mode="wait" initial={false}>
          <motion.p
            key={line}
            variants={lineVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            data-tooltip={line}
            className="max-w-full truncate text-[14px] text-muted first-letter:uppercase"
          >
            {line}
          </motion.p>
        </AnimatePresence>
      </div>
    </motion.div>
  )
}

const TONES: Record<FindingTone, { Icon: typeof ScanSearch; className: string }> = {
  summary: { Icon: ScanSearch, className: 'bg-accent/12 text-accent' },
  issue: { Icon: CircleAlert, className: 'bg-warn/12 text-warn' },
  good: { Icon: CircleCheck, className: 'bg-ok/12 text-ok' }
}

/**
 * One finding at a time: a big short line with its tone icon and a thin bar that fills while
 * the line is shown. `index` is the line on screen, `stepMs` how long each one stays.
 */
export function FindingsMoment({
  lines,
  index,
  stepMs
}: {
  lines: FindingLine[]
  index: number
  stepMs: number
}): React.JSX.Element {
  const { t } = useTranslation()
  const line = lines[index]
  const { Icon, className } = TONES[line.tone]

  return (
    <motion.div
      variants={momentVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className={momentClass}
    >
      <p className="text-[12px] font-semibold uppercase tracking-wide text-muted">
        {t('optimize.findings.title')}
        <span className="ml-2 tabular-nums font-normal normal-case">
          {index + 1}/{lines.length}
        </span>
      </p>
      <div role="status" aria-live="polite" className="mt-6 w-full">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={index}
            variants={lineVariants}
            initial="initial"
            animate="animate"
            exit="exit"
            className="flex flex-col items-center"
          >
            <span
              aria-hidden
              className={`flex size-11 items-center justify-center rounded-full ${className}`}
            >
              <Icon size={20} />
            </span>
            <p
              data-tooltip={line.text}
              className="mt-5 line-clamp-3 text-[22px] font-medium leading-snug tracking-tight text-balance"
            >
              {line.text}
            </p>
          </motion.div>
        </AnimatePresence>
      </div>
      <div aria-hidden className="mt-8 h-0.5 w-24 overflow-hidden rounded-full bg-border">
        <motion.span
          key={index}
          className="block h-full origin-left bg-accent/70"
          initial={{ scaleX: 0 }}
          animate={{ scaleX: 1 }}
          transition={{ duration: stepMs / 1000, ease: 'linear' }}
        />
      </div>
    </motion.div>
  )
}
