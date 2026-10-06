export type NoteLink = { kind: 'note'; name: string } | { kind: 'external'; url: string } | null

/**
 * Decides what a link inside a note does: another note in the same folder is opened in the
 * panel, http(s) links go to the main process (which asks for confirmation), anything else
 * is ignored.
 */
export function resolveNoteLink(href: string | undefined, names: string[]): NoteLink {
  if (!href) return null
  if (/^https?:\/\//i.test(href)) return { kind: 'external', url: href }

  let target = href.split(/[?#]/)[0].replace(/^\.\//, '')
  try {
    target = decodeURIComponent(target)
  } catch {
    return null
  }
  if (!target || /[/\\]/.test(target) || !/\.md$/i.test(target)) return null

  const name =
    names.find((n) => n === target) ?? names.find((n) => n.toLowerCase() === target.toLowerCase())
  return name ? { kind: 'note', name } : null
}
