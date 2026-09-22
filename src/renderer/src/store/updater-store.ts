import { create } from 'zustand'
import type {
  DownloadProgress,
  ReleaseNote,
  UpdatePhase,
  UpdaterState
} from '../../../shared/updater-types'

export type { DownloadProgress, ReleaseNote, UpdatePhase, UpdaterState }

const initialProgress: DownloadProgress = {
  percent: 0,
  bytesPerSecond: 0,
  transferred: 0,
  total: 0
}

/**
 * The renderer's view of the updater. Every field except the two local ones
 * below is a mirror of main-process state — this store never decides anything
 * about updates, it only reflects and forwards.
 *
 * `hydrate()` is why the update affordance can no longer go missing. The old
 * store learned about an update from a push it had to be listening for at the
 * exact moment it fired; anything that made it miss that push (mounting late,
 * a renderer reload, a check that errored) left the UI insisting the app was
 * current, with the next opportunity 30 minutes out.
 */
interface UpdaterStore extends UpdaterState {
  /** "Later" — per-version, remembered across launches. Renderer-only. */
  dismissed: boolean
  /**
   * The user pressed Back on a failed download. Renderer-only: it hides the
   * overlay without lying to the main process about the download's outcome.
   */
  errorAcknowledged: boolean

  hydrate: () => Promise<void>
  applyState: (state: UpdaterState) => void
  check: () => Promise<void>
  /** The "Receive pre-release builds" toggle; the main process owns the value. */
  setPrereleaseUpdates: (enabled: boolean) => Promise<void>
  startDownload: (attempt?: 'first' | 'retry') => void
  cancelDownload: () => void
  dismiss: () => void
  undismiss: () => void
  acknowledgeError: () => void
}

function getDismissedVersion(): string | null {
  try {
    return localStorage.getItem('update-dismissed-version')
  } catch {
    return null
  }
}

function setDismissedVersion(version: string | null): void {
  try {
    if (version) {
      localStorage.setItem('update-dismissed-version', version)
    } else {
      localStorage.removeItem('update-dismissed-version')
    }
  } catch {
    // ignore
  }
}

const initialState: UpdaterState = {
  supported: false,
  phase: 'idle',
  currentVersion: '',
  availableVersion: null,
  releaseNotes: null,
  progress: initialProgress,
  errorMessage: null,
  checkErrorMessage: null,
  lastCheckedAt: null,
  channel: 'stable',
  currentIsPrerelease: false,
  availableIsPrerelease: false,
  flags: { allowPrerelease: false, allowDowngrade: false },
  snapshotPath: null
}

export const useUpdaterStore = create<UpdaterStore>((set, get) => ({
  ...initialState,
  dismissed: false,
  errorAcknowledged: false,

  applyState: (state) =>
    set({
      ...state,
      // A "Later" only silences the version it was given for; a newer one
      // brings the banner back on its own.
      dismissed:
        state.availableVersion !== null && getDismissedVersion() === state.availableVersion,
      // A fresh download attempt clears a previously acknowledged failure.
      errorAcknowledged: state.phase === 'error' ? get().errorAcknowledged : false
    }),

  hydrate: async () => {
    const state = await window.electronAPI?.getUpdaterState?.()
    if (state) get().applyState(state)
  },

  check: async () => {
    const state = await window.electronAPI?.checkForUpdates?.()
    if (state) get().applyState(state)
  },

  setPrereleaseUpdates: async (enabled) => {
    const state = await window.electronAPI?.setPrereleaseUpdates?.(enabled)
    if (state) get().applyState(state)
  },

  startDownload: (attempt = 'first') => {
    setDismissedVersion(null)
    set({
      phase: 'downloading',
      progress: initialProgress,
      errorMessage: null,
      dismissed: false,
      errorAcknowledged: false
    })
    void window.electronAPI?.startDownload(attempt)
  },

  cancelDownload: () => {
    void window.electronAPI?.cancelDownload()
  },

  dismiss: () =>
    set((state) => {
      if (state.availableVersion) setDismissedVersion(state.availableVersion)
      return { dismissed: true }
    }),

  undismiss: () => {
    setDismissedVersion(null)
    set({ dismissed: false })
  },

  acknowledgeError: () => set({ errorAcknowledged: true })
}))

declare global {
  interface Window {
    /** Set by the preload from `--test-no-activate`; false in every shipped build. */
    __claveTestMode?: boolean
    /**
     * E2E seam: the updater store, so a spec can put the app into an update
     * phase. A dev build reports `supported: false` and never reaches
     * `available`, so the update banner is otherwise unreachable outside a
     * signed, packaged, genuinely-out-of-date app — which is to say untestable.
     *
     * Writing through the STORE rather than faking the DOM is what keeps the
     * check honest: it is the same seam the main process pushes state into, so
     * if the shape main sends and the shape the UI reads ever diverge, the
     * spec goes red instead of passing against a fixture of its own making.
     *
     * Gated on the test flag, so this handle does not exist in a user's app.
     */
    __claveUpdaterStoreForTests?: typeof useUpdaterStore
  }
}

if (typeof window !== 'undefined' && window.__claveTestMode) {
  window.__claveUpdaterStoreForTests = useUpdaterStore
}

/**
 * Subscribe once, from the app shell, and pull the current truth immediately.
 * Returns the unsubscribe.
 */
export function connectUpdaterStore(): () => void {
  const { hydrate, applyState } = useUpdaterStore.getState()
  void hydrate()
  return window.electronAPI?.onUpdaterState?.(applyState) ?? ((): void => {})
}
