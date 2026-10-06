import { create } from 'zustand'

interface NotesStore {
  open: boolean
  /** Last selected note name per project id. */
  selected: Record<string, string>
  toggle: () => void
  setOpen: (open: boolean) => void
  select: (projectId: string, name: string) => void
}

export const useNotes = create<NotesStore>((set) => ({
  open: false,
  selected: {},
  toggle: () => set((s) => ({ open: !s.open })),
  setOpen: (open) => set({ open }),
  select: (projectId, name) => set((s) => ({ selected: { ...s.selected, [projectId]: name } }))
}))
