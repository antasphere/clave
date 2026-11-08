import { useMemo } from 'react'
import { useSessionStore } from '../../store/session-store'
import { useWorkspaceStore } from '../../store/workspace-store'
import { useOngoingStore } from '../../store/ongoing-store'
import {
  entriesInWorkspace,
  sessionOfEntry,
  sortEntries,
  statusOf,
  type OngoingEntry,
  type OngoingStatus
} from '../../lib/ongoing'
import type { Session } from '../../store/session-types'

export interface OngoingRow {
  entry: OngoingEntry
  session: Session | undefined
  status: OngoingStatus
}

/** The active workspace's ongoing conversations, each with the tab it lives
 *  in and where it stands, in the page's order. */
export function useOngoingRows(elsewhere?: ReadonlySet<string>): OngoingRow[] {
  const entries = useOngoingStore((s) => s.entries)
  const sessions = useSessionStore((s) => s.sessions)
  const workspaceId = useWorkspaceStore((s) => s.activeWorkspaceId)
  return useMemo(() => {
    const rows = entriesInWorkspace(entries, workspaceId).map((entry) => {
      const session = sessionOfEntry<Session>(entry, sessions)
      return { entry, session, status: statusOf(session, !!elsewhere?.has(entry.id)) }
    })
    return sortEntries(rows)
  }, [entries, sessions, workspaceId, elsewhere])
}
