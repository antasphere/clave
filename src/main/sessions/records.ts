/**
 * The session records as the host serves them (wave 4, lane C, PRDCT-3376):
 * the adoptable listing a window brings its tabs back from, the discard of a
 * survivor nobody wants back, and the release that lets another window take
 * a live session in. One implementation behind the IPC handlers and the
 * server's commands, over the terminal manager and the session windows port;
 * nothing here imports Electron, so the standalone server serves the same.
 */
import type { ReleaseOutcome, SessionRecord } from '@clave/contract/sessions'
import { ptyManager } from '../pty-manager'
import { hostedListing, recordsForIds } from './records-by-id'
import { sessionManager } from './session-manager'
import { sessionWindows } from './windows'

export interface SessionRecordsSource {
  readonly listAdoptableRecords: (ids?: ReadonlyArray<string>) => SessionRecord[]
  readonly discardRecord: (key: string) => void
  readonly release: (ids: ReadonlyArray<string>, fallbackWindowKey?: string) => ReleaseOutcome
}

/** What this process holds. A chat is alive once its provider was started,
 *  not merely registered: the restore keeps an unstarted one dormant, so
 *  opening it is still what starts its agent (issue #183). */
const hosted: Parameters<typeof hostedListing>[1] = {
  hosts: (id) => ptyManager.getSession(id) !== undefined,
  isAlive: (id) =>
    sessionManager.get(id)?.transport === 'events'
      ? sessionManager.started(id)
      : ptyManager.getSession(id)?.alive === true,
  ids: () => ptyManager.getAllSessions().map((s) => s.id),
  recordOf: (id) => ptyManager.getSessionRecord(id) ?? undefined
}

/** The records over the app's own terminal manager. */
export const sessionRecords: SessionRecordsSource = {
  listAdoptableRecords: (ids) => {
    const all = ptyManager.listAdoptableSessions()
    // A session this process hosts is marked `running` wherever it is
    // answered, and its record comes back even where the backend's listing
    // left it out (records-by-id.ts, the rule's own test).
    if (ids === undefined) return hostedListing(all, hosted) as SessionRecord[]
    return recordsForIds(all, ids, hosted) as SessionRecord[]
  },
  discardRecord: (key) => ptyManager.discardSessionRecord(key),
  release: (ids, fallbackWindowKey) => {
    const released: string[] = []
    const refused: ReleaseOutcome['refused'][number][] = []
    for (const id of ids) {
      const session = ptyManager.getSession(id)
      if (!session) {
        refused.push({ sessionId: id, reason: 'not-live' })
        continue
      }
      if (!session.tmuxName) {
        // A plain pty's scrollback lives in one renderer and dies with the
        // detach: refused for a move. A closing window hands it to the
        // primary all the same: the record goes there, the session is let
        // go of, and the next boot offers it in the primary.
        refused.push({ sessionId: id, reason: 'not-tmux' })
        if (fallbackWindowKey) {
          ptyManager.setSessionWindowKey(id, fallbackWindowKey)
          void ptyManager.kill(id, false)
          sessionWindows().unbind(id)
        }
        continue
      }
      // Detach: the tmux session and its record survive, as at a quit; the
      // window that takes the session in starts it again with adoptSessionId.
      void ptyManager.kill(id, false)
      sessionWindows().unbind(id)
      released.push(id)
    }
    return { released, refused }
  }
}
