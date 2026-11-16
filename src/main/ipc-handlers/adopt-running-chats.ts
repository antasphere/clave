import type { SessionRecord, SessionRecordFields } from '@clave/contract/sessions'
import { selectAdoptableRecords, type AdoptionScope } from '../../shared/adoption-scope'

interface AdoptionHost {
  list(ids?: string[]): Promise<readonly SessionRecord[]>
  keep(id: string, fields: SessionRecordFields): Promise<void>
  bind(id: string, windowKey: string): void
}

/** Only the primary claims windowless chats or chats whose home no longer
 * exists. Each window also recovers its own hosted chats after a missed
 * reply. This host is the app's local server, never a configured fleet server. */
export async function adoptRunningChats(
  scope: AdoptionScope,
  host: AdoptionHost
): Promise<SessionRecord[]> {
  const known = new Set([...scope.knownWindowKeys, scope.windowKey])
  const eligible = selectAdoptableRecords(await host.list(), scope).filter(
    (r) => r.running === true && r.transport === 'events' && !r.link
  )
  const orphans = eligible.filter((r) => !r.windowKey || !known.has(r.windowKey))
  if (!eligible.length) return []
  for (const record of orphans) {
    await host.keep(record.id, {
      window: { key: scope.windowKey, expectedKey: record.windowKey || null }
    })
  }
  // A move or close can win while the claim is on the wire. Bind only the
  // still-hosted records whose claim actually took, never the stale read.
  const claimed = (await host.list(eligible.map((r) => r.id))).filter(
    (r) =>
      r.windowKey === scope.windowKey && r.running === true && r.transport === 'events' && !r.link
  )
  for (const record of claimed) host.bind(record.id, scope.windowKey)
  return [...claimed]
}
