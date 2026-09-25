import { useEffect } from 'react'
import { create } from 'zustand'
import type { BackgroundTask, HistoryItem, SessionEvent } from '../../../shared/session-model'

/** One event as it arrived, with the moment it did: a view that groups turns by
 *  time needs the arrival, and the transport carries none. */
export interface LoggedEvent {
  event: SessionEvent
  at: number
}
/** What the host keeps for a session while its pane is mounted. The host keeps
 *  the LOG, not a reduction of it: reducing is a view's reading of the session,
 *  and two views of one plugin may read the same events differently. A view
 *  reduces this log with its own reducer and re-renders the same entries after
 *  a switch, because the log outlives every view. */
export interface SessionLog {
  events: LoggedEvent[]
  /** The conversation's past before this subscription, oldest first: the
   *  pages of `sessions:history` read so far. Kept apart from `events` because
   *  it grows at the front, and a view keys its rows from the end of it. */
  past: HistoryItem[]
  /** What to ask for the page older than `past`; null once nothing is older,
   *  undefined until the first page has been read. */
  before?: number | null
  /** Set once the subscription is acknowledged; a view waits for it before writing. */
  ready: boolean
  /** The provider's exit code, once it has exited. */
  exitCode?: number
  /** A subscription that never came up, in the words the main process used. */
  error?: string
  /** The last `background_tasks` snapshot, kept as it arrives so a reader never
   *  scans the log for it: that scan ran on every event of every session. */
  background?: BackgroundTask[]
}
const empty: SessionLog = { events: [], past: [], ready: false }
interface ConversationState {
  logs: Record<string, SessionLog>
}
export const useConversationStore = create<ConversationState>(() => ({ logs: {} }))

function patch(sessionId: string, change: (log: SessionLog) => SessionLog): void {
  useConversationStore.setState((state) => ({
    logs: { ...state.logs, [sessionId]: change(state.logs[sessionId] ?? empty) }
  }))
}
/** Every consumer of one session shares one subscription, released by the last
 *  of them. The preload reference-counts the main-process subscription in turn,
 *  so a view of its own beside this log never detaches either. */
const attachments = new Map<string, { refs: number; release: () => void }>()

/** Hold a session's log open, imperatively; the returned function releases this
 *  holder's claim. `useSessionLog` is the React face of exactly this. */
export function attachSessionLog(sessionId: string): () => void {
  // The host passes an empty id for a session that has no event transport at
  // all (a PTY pane), so the hook can be called unconditionally.
  if (!sessionId) return () => {}
  attach(sessionId)
  let released = false
  return () => {
    if (released) return
    released = true
    detach(sessionId)
  }
}
function attach(sessionId: string): void {
  const live = attachments.get(sessionId)
  if (live) {
    live.refs += 1
    return
  }
  patch(sessionId, () => ({ ...empty }))
  let disposed = false
  const stopStream = window.electronAPI.onSessionStream(sessionId, (value) => {
    if (value.kind === 'event')
      patch(sessionId, (log) => ({
        ...log,
        events: [...log.events, { event: value.event, at: Date.now() }],
        ...(value.event.type === 'background_tasks' ? { background: value.event.tasks } : {})
      }))
  })
  const stopExit = window.electronAPI.onSessionStreamExit(sessionId, (code) =>
    patch(sessionId, (log) => ({ ...log, exitCode: code }))
  )
  void window.electronAPI
    .sessionsSubscribe(sessionId)
    .then(() => {
      if (disposed) return
      patch(sessionId, (log) => ({ ...log, ready: true }))
      // Only the newest page: a view asks for more as its reader scrolls up
      // (`loadEarlierLog`). A host without the call leaves the past empty.
      return Promise.resolve()
        .then(() => window.electronAPI.sessionsHistory(sessionId))
        .then((page) => {
          if (!disposed)
            patch(sessionId, (log) => ({ ...log, past: page.items, before: page.before }))
        })
        .catch(() => {
          if (!disposed) patch(sessionId, (log) => ({ ...log, before: null }))
        })
    })
    .catch((error: unknown) => {
      if (!disposed) patch(sessionId, (log) => ({ ...log, error: String(error) }))
    })
  attachments.set(sessionId, {
    refs: 1,
    release: () => {
      disposed = true
      stopStream()
      stopExit()
      void window.electronAPI.sessionsUnsubscribe(sessionId)
    }
  })
}
function detach(sessionId: string): void {
  const live = attachments.get(sessionId)
  if (!live) return
  live.refs -= 1
  if (live.refs > 0) return
  attachments.delete(sessionId)
  live.release()
  // The log is dropped with the last consumer: the pane is gone, and a session
  // reopened later is a fresh subscription that reads its past from main again.
  useConversationStore.setState((state) => {
    const logs = { ...state.logs }
    delete logs[sessionId]
    return { logs }
  })
}
/** Read the page of the past before the oldest one held, into the front of
 *  `past`. Resolves to what puts it there, or null when nothing is older. */
export async function loadEarlierLog(sessionId: string): Promise<(() => void) | null> {
  const before = useConversationStore.getState().logs[sessionId]?.before
  if (before === null || before === undefined) return null
  const page = await window.electronAPI.sessionsHistory(sessionId, before)
  return () =>
    patch(sessionId, (log) =>
      // A log dropped or reset meanwhile is not this page's to extend.
      log.before === before
        ? { ...log, past: [...page.items, ...log.past], before: page.before }
        : log
    )
}
/** Keep the session's log alive for as long as this component is mounted, and
 *  read it. The host mounts this for the pane's lifetime, so the log spans
 *  every view switch inside it. */
export function useSessionLog(sessionId: string): SessionLog {
  useEffect(() => attachSessionLog(sessionId), [sessionId])
  return useConversationStore((state) => state.logs[sessionId] ?? empty)
}
/** Read a session's log without holding it open: for a view that renders inside
 *  a pane the host already keeps attached. */
export function useSessionLogValue(sessionId: string): SessionLog {
  return useConversationStore((state) => state.logs[sessionId] ?? empty)
}
