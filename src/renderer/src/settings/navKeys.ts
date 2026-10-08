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
