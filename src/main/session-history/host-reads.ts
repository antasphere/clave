/**
 * The History's reads of the session host (PRDCT-4236), shared by the IPC
 * handlers (the dialog, the ledger's stamps, the close's restamp) and the
 * agent tools (`clave_history`, `clave_open_session` with `resume`, the
 * close tool's restamp): the session's record for a ledger row, and the
 * History with the live launch of every held conversation laid over it.
 */
import type { Session, SessionRecord } from '@clave/contract/sessions'
import { listHistory, recordFor, restampLaunch, type StampRecordSource } from './service'
import { overlayLiveLaunch, recordsWithStopped } from './live-launch'
import { ptyManager } from '../pty-manager'
import { isServerExternal } from '../server/endpoint'
import { serverClient } from '../mcp/server-client'

/** What these reads ask of the server's client. */
export interface HostSessionsApi {
  sessions: {
    listAdoptable(ids?: ReadonlyArray<string>): Promise<ReadonlyArray<SessionRecord>>
    list(): Promise<ReadonlyArray<Session>>
  }
}

/** The session's record for a ledger row's launch: main's own, else, when
 *  the sessions live on a server of their own, the server's. */
export const stampRecords: StampRecordSource = {
  local: (sessionId) => ptyManager.getSessionRecord(sessionId),
  remote: async (sessionId) => {
    if (!isServerExternal()) return null
    const records = await (await serverClient.api()).sessions.listAdoptable([sessionId])
    return records.find((r) => r.id === sessionId) ?? null
  }
}

/** The ledger told what a tab runs on before its record goes (round 6): main's
 *  record, else the server's. Never throws: a close must not wait on, or fail
 *  because of, the History. */
export async function restampSessionLaunch(sessionId: string): Promise<void> {
  try {
    const record = await recordFor(sessionId, stampRecords)
    if (record) await restampLaunch(sessionId, record)
  } catch (err) {
    console.error('[session-history] failed to restamp the launch', err)
  }
}

/** The records the holders are read from, over the server's client. */
export function hostRecords(api: HostSessionsApi): Promise<readonly SessionRecord[]> {
  return recordsWithStopped(
    (ids) => api.sessions.listAdoptable(ids),
    () => api.sessions.list()
  )
}

/** The History's memory with the live record of every held conversation laid
 *  over it (round 5 F1): what the tab's own Resume reads. A failed read of the
 *  records is the caller's to handle. */
export async function historyWithLiveLaunch(
  api: HostSessionsApi,
  records: () => Promise<readonly SessionRecord[]> = () => hostRecords(api)
): Promise<ReturnType<typeof listHistory>> {
  const listed = listHistory()
  return { ...listed, entries: overlayLiveLaunch(listed.entries, await records()) }
}
