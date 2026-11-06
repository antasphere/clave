import { create } from 'zustand'
import {
  pullRefKey,
  type GithubFailureKind,
  type PullDiffFile,
  type PullRef,
  type PullRequestView
} from '../../../src/shared/github-pull'

export interface RecentPull extends PullRef {
  title: string | null
  openedAt: number
}

/** What the panel knows of one pull request (PRDCT-4142): the record as
 *  last read, the failure if the read failed, the diff once asked for, and the
 *  comment being typed. Kept here rather than in the detail view, so a glance
 *  at another tab, or the pull request drawn again, shows the record at once
 *  and keeps the draft; the view refreshes the record behind it. */
export interface PullRecord {
  view: PullRequestView | null
  failure: { kind: GithubFailureKind; message: string } | null
  diff: PullDiffFile[] | null
  draft: string
}

export const EMPTY_RECORD: PullRecord = { view: null, failure: null, diff: null, draft: '' }

/** What the panel is showing and what it has shown. Module state, like the
 *  plugin UI store's own selection: the pull request survives the side panel
 *  being closed and reopened, and the recent list is the empty state's
 *  offer. Neither is persisted — a restart starts clean. */
interface GithubPanelState {
  current: PullRef | null
  recent: RecentPull[]
  /** One record per pull request, keyed by `pullRefKey`. */
  records: Record<string, PullRecord>
  /** Write part of a pull request's record; a pull request never seen starts
   *  from the empty record. */
  update: (ref: PullRef, patch: Partial<PullRecord>) => void
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
  records: {},
  update: (ref, patch) => {
    const key = pullRefKey(ref)
    const records = get().records
    set({ records: { ...records, [key]: { ...(records[key] ?? EMPTY_RECORD), ...patch } } })
  },
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
