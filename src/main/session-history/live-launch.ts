/**
 * The launch a conversation runs on NOW, from the record of the tab that still
 * holds it (PRDCT-4236, round 5 F1). The ledger learns a launch when a row is
 * stamped (a placement, a rename, a switch of bypass or of account), and a
 * chat that leaves bypass for plan stamps nothing: the renderer never sees
 * the mode, only the record does, written back as the provider reports it.
 * So the History, when read, lays the live record over the ledger's memory
 * for every conversation a tab still holds, live or stopped: the same facts
 * the tab's own Resume reads. A conversation whose tab is gone keeps the
 * ledger's last word. Pure, shared by the dialog's read and the agent's.
 */
import type { Session, SessionRecord } from '@clave/contract/sessions'
import { accountOf, conversationIdOf, runtimeChoices } from '../../shared/runtime-choices'
import type { LedgerLaunch } from './ledger'

/** What `launchOfRecord` reads of a session's record. */
export type LaunchRecord = Partial<
  Pick<
    SessionRecord,
    | 'model'
    | 'dangerousMode'
    | 'permissionMode'
    | 'effort'
    | 'codexMode'
    | 'codexAccountId'
    | 'codexAccountLabel'
    | 'claudeProfileId'
    | 'claudeProfileLabel'
  >
>

/** The record's launch, as a ledger row would carry it: the Resume's rule for
 *  bypass and the mode, the effort as reported, the account the record names. */
export function launchOfRecord(record: LaunchRecord): LedgerLaunch {
  const runtime = runtimeChoices(record)
  const out: LedgerLaunch = { dangerous: runtime.dangerousMode }
  if (runtime.permissionMode) out.permissionMode = runtime.permissionMode
  else if (record.permissionMode === 'bypassPermissions') out.permissionMode = 'bypassPermissions'
  if (runtime.effort) out.effort = runtime.effort
  return { ...out, ...accountOf(record) }
}

/** The entries with the live record's launch laid over the ledger's, for
 *  every conversation a record still holds (a running one preferred). */
export function overlayLiveLaunch<E extends { claudeSessionId: string; launch?: LedgerLaunch }>(
  entries: readonly E[],
  records: readonly SessionRecord[]
): E[] {
  const byConversation = new Map<string, SessionRecord>()
  for (const r of records) {
    const id = conversationIdOf(r)
    if (!id) continue
    const known = byConversation.get(id)
    if (!known || (r.running === true && known.running !== true)) byConversation.set(id, r)
  }
  if (byConversation.size === 0) return [...entries]
  return entries.map((e) => {
    const record = byConversation.get(e.claudeSessionId)
    return record ? { ...e, launch: { ...e.launch, ...launchOfRecord(record) } } : e
  })
}

/** How many ids one by-id records read carries: they travel in a query
 *  string, and a Mac with hundreds of ended sessions must not overflow it
 *  (round 2, N-F4). */
export const RECORDS_BY_ID_CHUNK = 40

/**
 * The records the holders are read from: the listing a window restores from,
 * plus, by id, the records of every session the host lists that the listing
 * lacks (a hosted session whose process has ended is left out of the listing
 * and still holds its conversation, round 1 F2), a chunk at a time. A read
 * that fails is said, never swallowed: a quiet fallback would bring the
 * duplicate tab back without a word.
 */
export async function recordsWithStopped(
  listAdoptable: (ids?: ReadonlyArray<string>) => Promise<ReadonlyArray<SessionRecord>>,
  list: () => Promise<ReadonlyArray<Session>>
): Promise<readonly SessionRecord[]> {
  const listed = await listAdoptable()
  const ids = new Set(listed.map((r) => r.id))
  const missing = (await list()).map((s) => s.id).filter((id) => !ids.has(id))
  if (missing.length === 0) return listed
  const more: SessionRecord[] = []
  for (let at = 0; at < missing.length; at += RECORDS_BY_ID_CHUNK)
    more.push(...(await listAdoptable(missing.slice(at, at + RECORDS_BY_ID_CHUNK))))
  return [...listed, ...more.filter((r) => !ids.has(r.id))]
}
