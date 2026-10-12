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
import { recordsForIds } from './records-by-id'
import { sessionWindows } from './windows'

export interface SessionRecordsSource {
  readonly listAdoptableRecords: (ids?: ReadonlyArray<string>) => SessionRecord[]
  readonly discardRecord: (key: string) => void
  readonly release: (ids: ReadonlyArray<string>, fallbackWindowKey?: string) => ReleaseOutcome
}

/** The records over the app's own terminal manager. */
export const sessionRecords: SessionRecordsSource = {
  listAdoptableRecords: (ids) => {
    const all = ptyManager.listAdoptableSessions()
    if (ids === undefined) return all as SessionRecord[]
    // By id, the records of the sessions this process already runs come back
    // too, marked `running` (records-by-id.ts, the rule's own test).
    return recordsForIds(all, ids, {
      recordOf: (id) => ptyManager.getSessionRecord(id) ?? undefined,
      isAlive: (id) => ptyManager.getSession(id)?.alive === true
    }) as SessionRecord[]
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
