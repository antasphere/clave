/**
 * Which stored provider connection (PRDCT-4426) an agent's `account` names on
 * a Pi or OpenCode tab (PRDCT-4496): ONE pure rule every road reads (the
 * daemon's `clave_open_session` through the routines' `resolveLaunch`, the
 * Mac's served open, the window's open on a server, a routine's run), and
 * that `clave_launch_options` marks as `suggested` under the provider pools,
 * so the listing and the open cannot drift.
 *
 * Pure: nothing here reads a store, a file or a key.
 */
import type { ProviderConnectionView } from '@clave/contract/settings/connections'
import { connectionServes } from '@clave/contract/settings/provider-catalogue'
import type { SessionRecord, SpawnOptions } from '@clave/contract/sessions'
import type { Harness } from './harness'

/** What the rule reads of a connection: its id, its label, and whether a
 *  launch on it can start (its key stored, or none needed). */
export interface PickableConnection {
  readonly id: string
  readonly label: string
  readonly usable: boolean
}

export type ProviderConnectionPick<C extends PickableConnection> =
  | { ok: true; connection: C }
  | { ok: false; reason: 'none' | 'unknown'; labels: string[] }

/**
 * `ref` undefined or `any`: the first usable connection in the list's order
 * (`none` when there is none). Otherwise an exact id, then an exact label,
 * then a case-insensitive label, among ALL connections: a match that is not
 * usable is still the answer, and the spawn then says why it cannot start
 * ('The connection has no key yet.'). No match: `unknown`, with the label of
 * every connection.
 */
export function pickProviderConnection<C extends PickableConnection>(
  connections: readonly C[],
  ref: string | undefined
): ProviderConnectionPick<C> {
  if (ref === undefined || ref === 'any') {
    const first = connections.find((c) => c.usable)
    return first
      ? { ok: true, connection: first }
      : { ok: false, reason: 'none', labels: connections.map((c) => c.label) }
  }
  const match =
    connections.find((c) => c.id === ref) ??
    connections.find((c) => c.label === ref) ??
    connections.find((c) => c.label.toLowerCase() === ref.toLowerCase())
  return match
    ? { ok: true, connection: match }
    : { ok: false, reason: 'unknown', labels: connections.map((c) => c.label) }
}

/** Whether a stored connection is listed under a harness's provider `pool`:
 *  that company's, serving one of the wire formats the harness speaks. The
 *  one filter the open (`harnessProviderConnections`) and every listing's
 *  provider pool rows read, so a connection the open would never land on is
 *  never suggested. */
export function servesHarnessPool(
  view: Pick<ProviderConnectionView, 'company' | 'endpoints'>,
  pool: string,
  harness: Pick<Harness, 'wireFormats'>
): boolean {
  return view.company === pool && connectionServes(view, harness.wireFormats)
}

/** A stored connection as the rule reads it, with its company. */
export type HarnessProviderConnection = PickableConnection & { readonly company: string }

/**
 * The stored connections a harness can run on, in the order the listing
 * shows them (`clave_launch_options`: pool by pool, in the harness's pool
 * order, the store's order within a pool): those of a company the harness
 * has a pool for, serving one of the wire formats it speaks. Usable once its
 * key is stored or when it needs none (`providerConnection`).
 */
export function harnessProviderConnections(
  harness: Pick<Harness, 'connectionPools' | 'wireFormats'>,
  views: readonly ProviderConnectionView[]
): HarnessProviderConnection[] {
  const pools: readonly string[] = harness.connectionPools
  return pools.flatMap((pool) =>
    views
      .filter((view) => servesHarnessPool(view, pool, harness))
      .map((view) => ({
        id: view.id,
        label: view.label,
        company: view.company,
        usable: view.hasKey || !view.needsKey
      }))
  )
}

/** The refusal of a pick that found nothing, in the voice of an unknown
 *  Claude account (`resolveAccountRef`, `served-accounts.ts`): the name
 *  asked, then every connection by its label and its id. */
export function providerConnectionRefusal(
  harnessName: string,
  ref: string | undefined,
  pick: { reason: 'none' | 'unknown' },
  connections: readonly PickableConnection[]
): string {
  if (connections.length === 0)
    return `No stored connection serves ${harnessName} yet: add one in Settings → Connections.`
  if (pick.reason === 'none')
    return `No stored connection of ${harnessName} has its key yet: set one in Settings → Connections.`
  const names = connections.map((c) => `"${c.label}" (${c.id})`).join(', ')
  return `Unknown ${harnessName} connection "${ref}". Available: ${names}`
}

/** The connection an `account` names on a Pi or OpenCode launch, from the
 *  machine's stored connections; the refusal sentence when it names none. */
export function resolveProviderConnection(
  harness: Pick<Harness, 'name' | 'connectionPools' | 'wireFormats'>,
  views: readonly ProviderConnectionView[],
  ref: string
): { ok: true; connection: HarnessProviderConnection } | { ok: false; reason: string } {
  const connections = harnessProviderConnections(harness, views)
  const pick = pickProviderConnection(connections, ref)
  return pick.ok
    ? pick
    : { ok: false, reason: providerConnectionRefusal(harness.name, ref, pick, connections) }
}

/** What the spawn is told of the connection: its id and its name, never its key. */
export const providerConnectionSpawnFields = (connection: {
  id: string
  label: string
}): Pick<SpawnOptions, 'connectionId' | 'connectionLabel'> => ({
  connectionId: connection.id,
  connectionLabel: connection.label
})

/** A Pi or OpenCode tab's connection as `clave_list` reports it, the way it
 *  reports a Claude tab's account: its id, its label (the store's current
 *  one, else the one the record kept), never exhausted (a provider key
 *  reports no usage). Null for a tab on no stored connection. */
export function listedProviderConnection(
  record: Pick<
    SessionRecord,
    'piMode' | 'opencodeMode' | 'connectionId' | 'connectionLabel' | 'connectionLeftFor'
  >,
  currentLabel: (id: string) => string | undefined
): { id: string; label: string; exhausted: false } | null {
  if (!(record.piMode || record.opencodeMode) || !record.connectionId) return null
  // A tab whose process left the connection stops naming it (PRDCT-4540).
  if (providerConnectionLeft(record)) return null
  return {
    id: record.connectionId,
    label: currentLabel(record.connectionId) ?? record.connectionLabel ?? 'Removed connection',
    exhausted: false
  }
}

/** The shape of a provider id a tab's report may name (Pi's `kimi-coding`,
 *  Clave's `clave-deepseek`): anything else is not taken as one. */
export const REPORTED_PROVIDER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Why a tab's process is off its connection, read from its record's
 *  `connectionLeftFor` (`<provider>`, `<provider> credential`, `<provider>
 *  unchecked`); null for anything else. */
export function connectionLeftReason(
  left: string | undefined
): { provider: string; why: 'provider' | 'credential' | 'unchecked' } | null {
  const m = /^(\S+)(?: (credential|unchecked))?$/.exec(left ?? '')
  if (!m || !REPORTED_PROVIDER_RE.test(m[1])) return null
  return { provider: m[1], why: (m[2] as 'credential' | 'unchecked' | undefined) ?? 'provider' }
}

/**
 * The one rule of PRDCT-4540: the connection a tab names is the credential
 * its process uses, or the tab does not name it. A Pi tab whose own process
 * reported a request that did not go on its connection (Clave's Pi
 * extension, `connectionLeftFor`) names no connection, and says so in this
 * sentence, on the window's road and in `clave_list` alike: another
 * provider, the same provider with another credential, or a credential
 * Clave could not check. Null while the tab is on its connection, or on none.
 */
export function providerConnectionLeft(
  record: Pick<SessionRecord, 'piMode' | 'opencodeMode' | 'connectionId' | 'connectionLeftFor'>
): string | null {
  if (!(record.piMode || record.opencodeMode) || !record.connectionId) return null
  const left = connectionLeftReason(record.connectionLeftFor)
  if (!left) return null
  const harness = record.piMode ? 'Pi' : 'OpenCode'
  if (left.why === 'credential')
    return `${harness} runs on ${left.provider} with another credential now, not with this tab's connection.`
  if (left.why === 'unchecked')
    return `Clave could not check which credential ${harness} uses now, so this tab no longer names its connection.`
  return `${harness} runs on ${left.provider} now, not on this tab's connection.`
}
