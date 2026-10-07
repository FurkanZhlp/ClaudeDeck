import { useState } from 'react'
import { inputClass } from '../../ui/styles'

interface Props {
  label: string
  value: number | null
  min: number
  max: number
  /** Shown after the field, e.g. "min" or "%". */
  unit?: string
  /** An empty field means null (e.g. "automatic"); otherwise empty restores the value. */
  allowEmpty?: boolean
  placeholder?: string
  disabled?: boolean
  onCommit: (value: number | null) => void
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/** Whole-number field that commits on blur or Enter, clamped to its range. */
export function NumberInput({
  label,
  value,
  min,
  max,
  unit,
  allowEmpty,
  placeholder,
  disabled,
  onCommit
}: Props): React.JSX.Element {
  const shown = value === null ? '' : String(value)
  const [draft, setDraft] = useState(shown)
  // The saved value changed (clamped by main, or edited elsewhere): show it.
  const [prevShown, setPrevShown] = useState(shown)
  if (prevShown !== shown) {
    setPrevShown(shown)
    setDraft(shown)
  }

  const commit = (): void => {
    const text = draft.trim()
    if (text === '') {
      if (allowEmpty && value !== null) onCommit(null)
      else setDraft(shown)
      return
    }
    const parsed = Number.parseInt(text, 10)
    if (!Number.isFinite(parsed)) return setDraft(shown)
    const next = clamp(parsed, min, max)
    setDraft(String(next))
    if (next !== value) onCommit(next)
  }

  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <input
        type="number"
        inputMode="numeric"
        aria-label={label}
        className={`${inputClass} !w-24 shrink-0 text-right tabular-nums disabled:opacity-50`}
        min={min}
        max={max}
        step={1}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit()
          if (event.key === 'Escape') {
            // Restore instead of closing the whole dialog.
            event.stopPropagation()
            setDraft(shown)
          }
        }}
      />
      {/* Always present, so fields with and without a unit line up. */}
      <span className="w-6 text-[12px] text-muted">{unit}</span>
    </span>
  )
}
