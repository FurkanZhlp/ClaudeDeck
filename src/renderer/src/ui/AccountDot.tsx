export function AccountDot({
  color,
  size = 8
}: {
  color: string
  size?: number
}): React.JSX.Element {
  return (
    <span
      aria-hidden
      className="inline-block shrink-0 rounded-full"
      style={{ background: color, width: size, height: size }}
    />
  )
}
