import { create } from 'zustand'

/**
 * Whether the "talk to us" invitation is still expanded, and whether its dialog
 * is open. One fact read in two places — the card in the sidebar's
 * announcements slot and the icon in its foot panel — so it lives here rather
 * than inside either of them.
 *
 * Once collapsed (by the user, or by booking/sending) it never expands again:
 * the door stays open without nagging. Unlike the telemetry notice this is not
 * gated on `telemetryEnabled` — opting out of the anonymous ping says nothing
 * about whether someone wants to talk to us.
 */
interface FeedbackState {
  /** null while the main process is still being asked. */
  collapsed: boolean | null
  dialogOpen: boolean
  load: () => void
  collapse: () => void
  setDialogOpen: (open: boolean) => void
}

export const useFeedbackStore = create<FeedbackState>((set) => ({
  collapsed: null,
  dialogOpen: false,
  load: () => {
    window.electronAPI
      ?.feedbackGetState()
      .then((state) => set({ collapsed: state.collapsed }))
      // Silently fail — never block the sidebar on feedback state.
      .catch(() => {})
  },
  collapse: () => {
    set({ collapsed: true })
    window.electronAPI?.feedbackSetCollapsed()
  },
  setDialogOpen: (dialogOpen) => set({ dialogOpen })
}))
