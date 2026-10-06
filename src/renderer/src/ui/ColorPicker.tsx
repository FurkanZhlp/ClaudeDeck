import { ACCOUNT_COLORS } from './styles'

interface Props {
  value: string
  onChange: (color: string) => void
  label: string
}

export function ColorPicker({ value, onChange, label }: Props): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label={label} className="flex h-[30px] items-center gap-1.5">
      {ACCOUNT_COLORS.map((color) => (
        <button
          key={color}
          type="button"
          role="radio"
          aria-label={color}
          aria-checked={value === color}
          onClick={() => onChange(color)}
          className={`size-5 rounded-full ring-offset-2 ring-offset-elevated transition-transform hover:scale-110 ${value === color ? 'ring-2 ring-fg' : ''}`}
          style={{ background: color }}
        />
      ))}
    </div>
  )
}
