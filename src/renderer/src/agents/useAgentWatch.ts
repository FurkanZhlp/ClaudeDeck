import { useEffect } from 'react'
import { useAgents } from './agentsStore'

/**
 * Watches a Claude tab's agents while `enabled`: subscribes to the pushes, then pairs one
 * `agents.watch` with one `agents.unwatch` (on switch, close or when disabled).
 */
export function useAgentWatch(sessionId: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return
    const { applyUpdate, applyEvents, watch, unwatch } = useAgents.getState()
    const offUpdate = window.api.agents.onUpdate(applyUpdate)
    const offEvents = window.api.agents.onEvents(applyEvents)
    void watch(sessionId)
    return () => {
      offUpdate()
      offEvents()
      unwatch(sessionId)
    }
  }, [sessionId, enabled])
}
