interface Props {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}

/** Labelled on/off switch row. */
export function Switch({ checked, onChange, label, hint, disabled }: Props): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center gap-3 rounded-lg py-1 text-left focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
    >
      <span className="min-w-0 flex-1">
        <span className="block">{label}</span>
        {hint && <span className="block text-[12px] leading-snug text-muted">{hint}</span>}
      </span>
      <span
        aria-hidden
        className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-fg/20'}`}
      >
        <span
          className={`absolute top-0.5 left-0.5 size-3.5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-3.5' : ''}`}
        />
      </span>
    </button>
  )
}
