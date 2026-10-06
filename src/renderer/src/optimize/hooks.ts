import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useReducedMotion } from 'motion/react'

const CLOCK_TICK_MS = 1000

/** Runs `action` once at a time and reports whether it is in flight. */
export function useBusy(): [boolean, (action: () => Promise<unknown>) => void] {
  const [busy, setBusy] = useState(false)
  const run = (action: () => Promise<unknown>): void => {
    if (busy) return
    setBusy(true)
    void action().finally(() => setBusy(false))
  }
  return [busy, run]
}

/** Re-renders every second while `active`, for the elapsed time. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(timer)
  }, [active])
  return now
}

/** `useReducedMotion` as a plain boolean (it is null before the media query is read). */
export function useReduced(): boolean {
  return useReducedMotion() ?? false
}

/** Whether the element's content is cut off (e.g. by line-clamp); follows size changes. */
export function useOverflowing(ref: RefObject<HTMLElement | null>): boolean {
  const [overflowing, setOverflowing] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => setOverflowing(el.scrollHeight > el.clientHeight + 1)
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref])
  return overflowing
}

/**
 * `value`, but each shown value stays for at least `minMs` so quickly changing text (Claude's
 * status line) can be read. Only the latest value is shown after the hold.
 */
export function useHeld<T>(value: T, minMs: number): T {
  const [shown, setShown] = useState(value)
  const shownAt = useRef(0)
  useEffect(() => {
    if (Object.is(value, shown)) return
    const wait = Math.max(0, shownAt.current + minMs - Date.now())
    const timer = setTimeout(() => {
      shownAt.current = Date.now()
      setShown(value)
    }, wait)
    return () => clearTimeout(timer)
  }, [value, shown, minMs])
  return shown
}

/**
 * Steps through `length` items, one every `stepMs`, for the sequence identified by `key`.
 * Returns the current index (null once the sequence ended or when there is none) and a
 * function that ends it early. While `enabled` is false the sequence pauses where it is.
 */
export function useSequence(
  key: string | number | null,
  length: number,
  stepMs: number,
  enabled: boolean
): [number | null, () => void] {
  const [state, setState] = useState<{ key: string | number | null; index: number }>({
    key: null,
    index: 0
  })
  const index = state.key === key ? state.index : 0
  const running = key !== null && index < length
  useEffect(() => {
    if (!running || !enabled) return
    const timer = setTimeout(() => setState({ key, index: index + 1 }), stepMs)
    return () => clearTimeout(timer)
  }, [running, enabled, key, index, stepMs])
  const end = (): void => setState({ key, index: length })
  return [running ? index : null, end]
}
