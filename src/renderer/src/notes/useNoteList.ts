import { useEffect, useState } from 'react'
import type { NoteFile } from '@shared/types'
import { errorCode, useApp } from '../store'

interface NoteList {
  /** null until the first list for this project has arrived. */
  notes: NoteFile[] | null
  /** Increases every time the list is reloaded, so dependents can refresh too. */
  version: number
}

type Loaded = { projectId: string; notes: NoteFile[]; version: number }

/**
 * Loads the note list of a project and reloads it whenever the main process reports a change.
 * The previous list stays visible while a reload is in flight, so the UI does not jump.
 */
export function useNoteList(projectId: string): NoteList {
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    let active = true
    let request = 0
    const load = (): void => {
      const current = ++request
      window.api.notes.list(projectId).then(
        (notes) => {
          if (active && current === request)
            setLoaded((prev) => ({ projectId, notes, version: (prev?.version ?? 0) + 1 }))
        },
        (error: unknown) => {
          if (active) useApp.getState().setError(errorCode(error))
        }
      )
    }
    load()
    const unsubscribe = window.api.notes.onChanged((changedId) => {
      if (changedId === projectId) load()
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [projectId])

  return loaded?.projectId === projectId
    ? { notes: loaded.notes, version: loaded.version }
    : { notes: null, version: 0 }
}

export const MEMORY_NOTE = 'MEMORY.md'

/** Remembered note if it still exists, else MEMORY.md, else the first note. */
export function pickNote(notes: NoteFile[], remembered: string | undefined): string | null {
  if (remembered && notes.some((n) => n.name === remembered)) return remembered
  if (notes.some((n) => n.name === MEMORY_NOTE)) return MEMORY_NOTE
  return notes[0]?.name ?? null
}
