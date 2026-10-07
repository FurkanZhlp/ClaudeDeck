interface Option<T extends string> {
  value: T
  label: string
}

interface Props<T extends string> {
  value: T
  options: ReadonlyArray<Option<T>>
  onChange: (value: T) => void
  label: string
  disabled?: boolean
}

/** Small segmented control; same look as the period switch in the usage details. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled
}: Props<T>): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={label}
      className={`inline-flex rounded-lg bg-fg/[0.06] p-0.5 ${disabled ? 'opacity-50' : ''}`}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          disabled={disabled}
          className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent ${value === option.value ? 'bg-elevated text-fg shadow-sm' : 'text-muted enabled:hover:text-fg'}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
