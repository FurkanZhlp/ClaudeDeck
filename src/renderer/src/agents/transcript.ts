import type { AgentEvent } from '@shared/types'

/** Most transcript events the renderer keeps for the open agent; older ones page back in. */
export const MAX_RENDERED_EVENTS = 1500

/** Event ids are `<line byte offset>:<block index>`; the offset doubles as a paging cursor. */
function parseId(id: string): [number, number] {
  const [offset, index] = id.split(':')
  const line = Number(offset)
  const block = Number(index)
  return [Number.isFinite(line) ? line : 0, Number.isFinite(block) ? block : 0]
}

export const eventOffset = (event: AgentEvent): number => parseId(event.id)[0]

const compare = (a: AgentEvent, b: AgentEvent): number => {
  const [lineA, blockA] = parseId(a.id)
  const [lineB, blockB] = parseId(b.id)
  return lineA - lineB || blockA - blockB
}

/** Union of two event lists without duplicates, in transcript order. */
export function mergeEvents(current: AgentEvent[], incoming: AgentEvent[]): AgentEvent[] {
  if (incoming.length === 0) return current
  const seen = new Set(current.map((e) => e.id))
  const added = incoming.filter((e) => !seen.has(e.id))
  if (added.length === 0) return current
  const merged = [...current, ...added]
  // Live events normally arrive after the last one; sort only when they do not.
  const last = current[current.length - 1]
  if (!last || compare(last, added[0]) < 0) {
    if (added.every((e, i) => i === 0 || compare(added[i - 1], e) < 0)) return merged
  }
  return merged.sort(compare)
}

/**
 * Keeps at most `limit` events, dropping whole transcript lines from the start. Returns the
 * cursor that pages the dropped part back in (the first kept line), or the old cursor when
 * nothing was dropped.
 */
export function capEvents(
  events: AgentEvent[],
  cursor: number | null,
  limit = MAX_RENDERED_EVENTS
): { events: AgentEvent[]; cursor: number | null } {
  if (events.length <= limit) return { events, cursor }
  let start = events.length - limit
  // Do not split a line: skip forward past the rest of the line the cut fell into.
  while (start < events.length && eventOffset(events[start - 1]) === eventOffset(events[start])) {
    start++
  }
  const kept = events.slice(start)
  return kept.length > 0 ? { events: kept, cursor: eventOffset(kept[0]) } : { events, cursor }
}

/** A row of the transcript view: a tool call carries its result when both are loaded. */
export type TranscriptItem =
  | { type: 'event'; event: AgentEvent }
  | { type: 'tool'; call: AgentEvent; result: AgentEvent | null }

export function toItems(events: AgentEvent[]): TranscriptItem[] {
  const calls = new Set<string>()
  const results = new Map<string, AgentEvent>()
  for (const event of events) {
    if (!event.toolUseId) continue
    if (event.kind === 'tool_use') calls.add(event.toolUseId)
    else if (event.kind === 'tool_result' && !results.has(event.toolUseId)) {
      results.set(event.toolUseId, event)
    }
  }
  const items: TranscriptItem[] = []
  for (const event of events) {
    if (event.kind === 'tool_use') {
      items.push({
        type: 'tool',
        call: event,
        result: event.toolUseId ? (results.get(event.toolUseId) ?? null) : null
      })
    } else if (event.kind === 'tool_result' && event.toolUseId && calls.has(event.toolUseId)) {
      continue
    } else {
      items.push({ type: 'event', event })
    }
  }
  return items
}
