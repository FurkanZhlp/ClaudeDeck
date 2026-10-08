/**
 * Index the settings navigation moves focus to for a key, or null when the key is not a
 * navigation key. Up/Down wrap around; Home/End jump to the ends.
 */
export function navTargetIndex(key: string, current: number, count: number): number | null {
  if (count <= 0) return null
  switch (key) {
    case 'ArrowDown':
      return current < 0 ? 0 : (current + 1) % count
    case 'ArrowUp':
      return current < 0 ? count - 1 : (current - 1 + count) % count
    case 'Home':
      return 0
    case 'End':
      return count - 1
    default:
      return null
  }
}

/** Share of the visible height a Page Up / Page Down moves, like the browser's own paging. */
const PAGE_SHARE = 0.9

/**
 * Page Up / Page Down pressed in the navigation scroll the page content instead: focus starts in
 * the navigation, whose own keys would otherwise leave a long section out of keyboard reach.
 */
export function pageScrollDelta(key: string, viewportHeight: number): number | null {
  if (key === 'PageDown') return Math.round(viewportHeight * PAGE_SHARE)
  if (key === 'PageUp') return -Math.round(viewportHeight * PAGE_SHARE)
  return null
}
