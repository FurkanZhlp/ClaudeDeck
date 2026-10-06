import { Check, CircleSlash, Loader2, RotateCcw, Undo2, X } from 'lucide-react'
import { motion } from 'motion/react'
import { useTranslation } from 'react-i18next'
import type { OptimizeState } from '@shared/types'
import { ActionButton } from './ActionButton'
import { Disclosure } from './Disclosure'
import { plainText } from './friendly'
import { useBusy } from './hooks'
import { EASE_OUT, momentVariants, popVariants } from './motionPresets'
import { useOptimize } from './optimizeStore'
import type { RunSummary } from './runEvents'

/** Delay before the check mark draws, after the circle popped in. */
const CHECK_DRAW_DELAY_S = 0.2
const CHECK_DRAW_S = 0.45

const momentClass = 'flex w-full max-w-xl flex-col items-center text-center'
const iconCircle = 'flex size-20 items-center justify-center rounded-full'

/** A short celebration with the count; the change list waits behind "Details". */
export function FinishedMoment({
  run,
  summary,
  onDone
}: {
  run: OptimizeState
  summary: RunSummary
  onDone?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const revert = useOptimize((s) => s.revert)
  const [busy, guard] = useBusy()
  const changes = summary.finish?.changes ?? []
  const line = plainText(summary.finish?.summary ?? '')

  const undoAll = (): void => {
    if (window.confirm(t('optimize.finished.revertConfirm'))) guard(() => revert(run.accountId))
  }

  return (
    <motion.section
      variants={momentVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className={momentClass}
    >
      <motion.span
        aria-hidden
        variants={popVariants}
        className={`${iconCircle} bg-ok/12 text-ok ring-[10px] ring-ok/5`}
      >
        <svg viewBox="0 0 24 24" className="size-9" fill="none" stroke="currentColor">
          <motion.path
            d="M5 12.5l4.5 4.5L19 7.5"
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ delay: CHECK_DRAW_DELAY_S, duration: CHECK_DRAW_S, ease: EASE_OUT }}
          />
        </svg>
      </motion.span>
      <h2 className="mt-7 text-[26px] font-semibold tracking-tight">
        {changes.length > 0
          ? t('optimize.finished.applied', { count: changes.length })
          : t('optimize.finished.none')}
      </h2>
      {run.reverted && (
        <p role="status" className="animate-fade-up mt-2 flex items-center gap-1.5 text-ok">
          <Undo2 size={14} aria-hidden />
          {t('optimize.finished.reverted')}
        </p>
      )}

      <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
        {run.backupDir && !run.reverted && (
          <ActionButton variant="ghost" disabled={busy} onClick={undoAll}>
            {busy ? (
              <Loader2 size={15} className="animate-spin" aria-hidden />
            ) : (
              <Undo2 size={15} aria-hidden />
            )}
            {t('optimize.finished.revert')}
          </ActionButton>
        )}
        {onDone && (
          <ActionButton variant="primary" data-autofocus onClick={onDone}>
            {t('optimize.finished.done')}
          </ActionButton>
        )}
      </div>

      {(changes.length > 0 || line || run.backupDir) && (
        <Disclosure
          className="mt-6 w-full max-w-md text-left"
          label={t('optimize.finished.details')}
          openLabel={t('optimize.finished.hideDetails')}
        >
          <div className="space-y-2 text-[12.5px] select-text">
            {line && <p className="text-muted">{line}</p>}
            {changes.length > 0 && (
              <ul className="space-y-1">
                {changes.map((change, index) => (
                  <li key={index} className="flex gap-2">
                    <Check
                      size={13}
                      aria-hidden
                      strokeWidth={2.5}
                      className="mt-0.5 shrink-0 text-ok"
                    />
                    <span className="min-w-0">{change}</span>
                  </li>
                ))}
              </ul>
            )}
            {run.backupDir && (
              <p className="break-all text-[11.5px] text-muted">
                {t('optimize.finished.backup', { path: run.backupDir })}
              </p>
            )}
          </div>
        </Disclosure>
      )}
    </motion.section>
  )
}

/** Failed or stopped: one short message and Try again. */
export function EndedMoment({
  run,
  summary
}: {
  run: OptimizeState
  summary: RunSummary
}): React.JSX.Element {
  const { t } = useTranslation()
  const start = useOptimize((s) => s.start)
  const [busy, guard] = useBusy()
  const failed = run.status === 'failed'
  const message = failed
    ? plainText(summary.error ?? '') || t('optimize.failed.unknown')
    : t('optimize.cancelled.body')

  return (
    <motion.section
      variants={momentVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      className={momentClass}
    >
      <motion.span
        aria-hidden
        variants={popVariants}
        className={`${iconCircle} ${failed ? 'bg-danger/10 text-danger' : 'bg-panel text-muted'}`}
      >
        {failed ? <X size={32} strokeWidth={2.2} /> : <CircleSlash size={30} />}
      </motion.span>
      <h2 className="mt-7 text-[24px] font-semibold tracking-tight">
        {t(failed ? 'optimize.failed.title' : 'optimize.cancelled.title')}
      </h2>
      <p
        role={failed ? 'alert' : undefined}
        data-tooltip={message}
        className="mt-2 line-clamp-2 max-w-md text-[14px] text-muted"
      >
        {message}
      </p>
      <ActionButton
        variant="primary"
        className="mt-8"
        data-autofocus
        disabled={busy}
        onClick={() => guard(() => start(run.accountId))}
      >
        {busy ? (
          <Loader2 size={15} className="animate-spin" aria-hidden />
        ) : (
          <RotateCcw size={15} aria-hidden />
        )}
        {t('optimize.failed.retry')}
      </ActionButton>
    </motion.section>
  )
}
