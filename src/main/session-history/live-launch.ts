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
import type { SessionRecord } from '@clave/contract/sessions'
import { runtimeChoices } from '../../shared/runtime-choices'
import type { LedgerLaunch } from './ledger'

/** The record's launch, as a ledger row would carry it: the Resume's rule for
 *  bypass and the mode, the effort as reported, the account the record names. */
export function launchOfRecord(record: SessionRecord): LedgerLaunch {
  const runtime = runtimeChoices(record)
  const out: LedgerLaunch = { dangerous: runtime.dangerousMode }
  if (runtime.permissionMode) out.permissionMode = runtime.permissionMode
  else if (record.permissionMode === 'bypassPermissions') out.permissionMode = 'bypassPermissions'
  if (runtime.effort) out.effort = runtime.effort
  const accountId = record.codexMode ? record.codexAccountId : record.claudeProfileId
  const accountLabel = record.codexMode ? record.codexAccountLabel : record.claudeProfileLabel
  if (accountId) {
    out.accountId = accountId
    if (accountLabel) out.accountLabel = accountLabel
  }
  return out
}

const conversationOf = (r: SessionRecord): string | undefined =>
  r.claudeSessionId ?? r.codexThreadId ?? r.piSessionId

/** The entries with the live record's launch laid over the ledger's, for
 *  every conversation a record still holds (a running one preferred). */
export function overlayLiveLaunch<E extends { claudeSessionId: string; launch?: LedgerLaunch }>(
  entries: readonly E[],
  records: readonly SessionRecord[]
): E[] {
  const byConversation = new Map<string, SessionRecord>()
  for (const r of records) {
    const id = conversationOf(r)
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
