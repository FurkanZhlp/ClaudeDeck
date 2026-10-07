import { create } from 'zustand'

/** Panels that share the workspace's right edge; only one is shown at a time. */
export type SidePanel = 'notes' | 'agents'

interface SidePanelStore {
  panel: SidePanel | null
  /** Shows the panel, or hides it when it is already shown. */
  toggle: (panel: SidePanel) => void
  /** Shows the panel (replacing the other one) or, with false, hides it if it is shown. */
  setOpen: (panel: SidePanel, open: boolean) => void
}

export const useSidePanel = create<SidePanelStore>((set) => ({
  panel: null,
  toggle: (panel) => set((s) => ({ panel: s.panel === panel ? null : panel })),
  setOpen: (panel, open) =>
    set((s) => ({ panel: open ? panel : s.panel === panel ? null : s.panel }))
}))
