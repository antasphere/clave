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
  record: Pick<SessionRecord, 'piMode' | 'opencodeMode' | 'connectionId' | 'connectionLabel'>,
  currentLabel: (id: string) => string | undefined
): { id: string; label: string; exhausted: false } | null {
  if (!(record.piMode || record.opencodeMode) || !record.connectionId) return null
  return {
    id: record.connectionId,
    label: currentLabel(record.connectionId) ?? record.connectionLabel ?? 'Removed connection',
    exhausted: false
  }
}
