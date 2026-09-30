import { create } from 'zustand'
import { pullRefKey, type PullRef } from '../../../src/shared/github-pull'

export interface RecentPull extends PullRef {
  title: string | null
  openedAt: number
}

/** What the panel is showing and what it has shown. Module state, like the
 *  plugin UI store's own selection: the pull request survives the side panel
 *  being closed and reopened, and the recent list is the empty state's
 *  offer. Neither is persisted — a restart starts clean. */
interface GithubPanelState {
  current: PullRef | null
  recent: RecentPull[]
  /** Show a pull request. Opening again what is already open changes nothing,
   *  so a second click on the same link never restarts a load. */
  open: (ref: PullRef) => void
  /** Give a recent entry the title the record turned out to carry. */
  remember: (ref: PullRef, title: string) => void
  close: () => void
}

const RECENT_LIMIT = 10

export const useGithubPanelStore = create<GithubPanelState>((set, get) => ({
  current: null,
  recent: [],
  open: (ref) => {
    const key = pullRefKey(ref)
    const current = get().current
    const previous = get().recent.find((entry) => pullRefKey(entry) === key)
    const recent = [
      { ...ref, title: previous?.title ?? null, openedAt: Date.now() },
      ...get().recent.filter((entry) => pullRefKey(entry) !== key)
    ].slice(0, RECENT_LIMIT)
    set({ current: current && pullRefKey(current) === key ? current : ref, recent })
  },
  remember: (ref, title) => {
    const key = pullRefKey(ref)
    set({
      recent: get().recent.map((entry) => (pullRefKey(entry) === key ? { ...entry, title } : entry))
    })
  },
  close: () => set({ current: null })
}))
