/** Elapsed time as `m:ss` or `h:mm:ss`, independent of the UI language. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`
}

/** `claude-sonnet-4-5-20250929` → `sonnet-4-5`; other names are returned unchanged. */
export function shortModel(model: string): string {
  return model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
}

/** First non-empty line of a tool input preview, for the collapsed tool row. */
export function firstLine(text: string | undefined, max = 120): string {
  const line = (text ?? '').split('\n').find((l) => l.trim()) ?? ''
  const trimmed = line.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

export type TextPart = { kind: 'text'; text: string } | { kind: 'link'; text: string; url: string }

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g
const TRAILING = /[.,;:!?)\]}]+$/

/** Splits plain text into text and http(s) link parts; nothing is interpreted as markup. */
export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = []
  let last = 0
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0]
    const url = raw.replace(TRAILING, '')
    const start = match.index
    if (start > last) parts.push({ kind: 'text', text: text.slice(last, start) })
    parts.push({ kind: 'link', text: url, url })
    last = start + url.length
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) })
  return parts
}
