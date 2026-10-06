export const inputClass =
  'no-drag w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-[13px] text-fg outline-none focus:border-accent'

export const sectionTitleClass = 'text-[11px] font-semibold uppercase tracking-wide text-muted'

export const ACCOUNT_COLORS = [
  '#c96442',
  '#d97706',
  '#16a34a',
  '#0891b2',
  '#2563eb',
  '#9333ea',
  '#db2777',
  '#64748b'
]

/** Translucent version of an account colour for backgrounds and soft borders. */
export const tint = (color: string, percent: number): string =>
  `color-mix(in srgb, ${color} ${percent}%, transparent)`
