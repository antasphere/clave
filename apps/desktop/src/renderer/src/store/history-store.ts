import { create } from 'zustand'

/** The session-history dialog's open state (PRDCT-1738): opened from a
 *  group's context menu with that group preselected, or from ⌘⇧H on All.
 *  A store rather than component state because the two openers live in
 *  different trees (the sidebar and the app shell) and the dialog mounts at
 *  the shell so it works with the sidebar closed. */
interface HistoryStore {
  open: boolean
  /** The live group preselected on open; null = All. */
  groupId: string | null
  /** Bumped on every open: the dialog keys its panel on it, so each open is
   *  a fresh panel (fresh read, preset chip, empty filter) rather than the
   *  previous one's state. */
  openSeq: number
  openHistory: (groupId: string | null) => void
  closeHistory: () => void
}

export const useHistoryStore = create<HistoryStore>((set) => ({
  open: false,
  groupId: null,
  openSeq: 0,
  openHistory: (groupId) => set((s) => ({ open: true, groupId, openSeq: s.openSeq + 1 })),
  closeHistory: () => set({ open: false })
}))
