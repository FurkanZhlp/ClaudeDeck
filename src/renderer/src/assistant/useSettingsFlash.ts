import { useEffect, type RefObject } from 'react'
import { useReduced } from '../optimize/hooks'
import { useAssistant } from './assistantStore'
import './assistant.css'

/** How long changed rows stay highlighted (matches the CSS animation). */
const FLASH_MS = 2600
/** The section page fades in after navigation; rows are looked up once it rendered. */
const RENDER_DELAY_MS = 120

/**
 * Highlights the settings rows an apply changed (`data-setting` keys) inside `root` and brings
 * the first one into view.
 */
export function useSettingsFlash(root: RefObject<HTMLElement | null>): void {
  const highlight = useAssistant((s) => s.highlight)
  const reduced = useReduced()

  useEffect(() => {
    if (!highlight || highlight.keys.length === 0) return
    let rows: HTMLElement[] = []
    let clear: ReturnType<typeof setTimeout> | undefined
    const show = setTimeout(() => {
      const scope = root.current
      if (!scope) return
      rows = highlight.keys.flatMap((key) => [
        ...scope.querySelectorAll<HTMLElement>(`[data-setting="${CSS.escape(key)}"]`)
      ])
      rows.forEach((row) => row.classList.add('setting-flash'))
      rows[0]?.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' })
      clear = setTimeout(
        () => rows.forEach((row) => row.classList.remove('setting-flash')),
        FLASH_MS
      )
    }, RENDER_DELAY_MS)
    return () => {
      clearTimeout(show)
      clearTimeout(clear)
      rows.forEach((row) => row.classList.remove('setting-flash'))
    }
  }, [highlight, root, reduced])
}
