import { useEffect, useRef } from 'react'
import * as pool from './terminalPool'

interface Props {
  id: string
  /** İlk ölçüm yapıldığında bir kez çağrılır; süreç başlatmak için. */
  onReady?: (cols: number, rows: number) => void
}

export function TerminalView({ id, onReady }: Props): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const onReadyRef = useRef(onReady)

  useEffect(() => {
    onReadyRef.current = onReady
  })

  useEffect(() => {
    const container = ref.current
    if (!container) return
    pool.attach(id, container)

    const sync = (): void => {
      const size = pool.fit(id)
      if (size) window.api.pty.resize(id, size.cols, size.rows)
    }
    const frame = requestAnimationFrame(() => {
      const size = pool.fit(id)
      pool.focus(id)
      if (size) onReadyRef.current?.(size.cols, size.rows)
    })
    const observer = new ResizeObserver(sync)
    observer.observe(container)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      pool.detach(id)
    }
  }, [id])

  return <div ref={ref} className="h-full w-full overflow-hidden bg-[#141413]" />
}
