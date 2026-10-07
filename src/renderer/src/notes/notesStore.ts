import { create } from 'zustand'
import { useSidePanel } from '../ui/sidePanelStore'

interface NotesStore {
  /** Last selected note name per project id. */
  selected: Record<string, string>
  /** Shows or hides the notes panel (visibility lives in the shared side panel store). */
  setOpen: (open: boolean) => void
  select: (projectId: string, name: string) => void
}

export const useNotes = create<NotesStore>((set) => ({
  selected: {},
  setOpen: (open) => useSidePanel.getState().setOpen('notes', open),
  select: (projectId, name) => set((s) => ({ selected: { ...s.selected, [projectId]: name } }))
}))
