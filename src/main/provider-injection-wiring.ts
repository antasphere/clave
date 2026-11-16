/**
 * Lane B's store of provider connections plugged into lane C's sources
 * (PRDCT-4496): the spawn step, the daemon's model listing and the usage line
 * read a stored connection through here and nowhere else. Called once at boot
 * by each process that spawns tabs (`index.ts`, `server-entry.ts`).
 *
 * The key is opened by the manager at the moment a spawn or a usage read asks
 * for it, and handed straight on: nothing here keeps it.
 */
import type { ProviderWireFormat } from '@clave/contract/settings/provider-catalogue'
import type { ProviderConnectionView } from '@clave/contract/settings/connections'
import type { ConnectionForSpawn } from './provider-injection'
import {
  setConnectionListingSource,
  setConnectionSource,
  type ProviderConnectionListing
} from './provider-injection-spawn'
import { providerConnectionsManager } from './provider-connections'
import { providerUsage, setConnectionRefSource, setConnectionValueSource } from './provider-usage'

/** What the wiring reads of lane B's manager. */
export type ProviderConnectionsSource = Pick<
  typeof providerConnectionsManager,
  'get' | 'forHarness' | 'openKey' | 'onChange'
>

/** The endpoint a provider Clave declares is pointed at, in this order of
 *  preference: the wire every OpenAI-compatible server speaks first. */
const ENDPOINT_PREFERENCE: readonly ProviderWireFormat[] = [
  'openai-chat',
  'anthropic-messages',
  'openai-responses'
]

export function endpointForSpawn(
  endpoints: ProviderConnectionView['endpoints']
): ConnectionForSpawn['endpoint'] {
  for (const format of ENDPOINT_PREFERENCE) {
    const found = endpoints.find((e) => e.wireFormat === format)
    if (found) return { wireFormat: found.wireFormat, baseUrl: found.baseUrl }
  }
  return null
}

/** A stored connection as the spawn reads it, its key opened now; null when
 *  the store has no such connection. A connection that needs a key and has
 *  none comes back with a null value, which the spawn refuses. */
export async function connectionForSpawn(
  manager: Pick<ProviderConnectionsSource, 'get' | 'openKey'>,
  id: string
): Promise<ConnectionForSpawn | null> {
  const view = manager.get(id)
  if (!view) return null
  const value = view.needsKey ? ((await manager.openKey(id)) ?? null) : null
  return {
    id: view.id,
    label: view.label,
    company: view.company,
    endpoint: endpointForSpawn(view.endpoints),
    value
  }
}

/** The connections a Pi or OpenCode launch can run on: those serving the
 *  harness that hold their key or need none. */
export function connectionsForListing(
  manager: Pick<ProviderConnectionsSource, 'forHarness'>,
  harness: 'pi' | 'opencode'
): ProviderConnectionListing[] {
  return manager
    .forHarness(harness)
    .filter((c) => c.hasKey || !c.needsKey)
    .map((c) => ({ id: c.id, label: c.label, company: c.company }))
}

export function wireProviderConnections(
  manager: ProviderConnectionsSource = providerConnectionsManager,
  usage: Pick<typeof providerUsage, 'invalidate'> = providerUsage
): void {
  setConnectionSource((id) => connectionForSpawn(manager, id))
  setConnectionListingSource((harness) => connectionsForListing(manager, harness))
  setConnectionRefSource(async (id) => {
    const view = manager.get(id)
    return view ? { id: view.id, company: view.company } : null
  })
  setConnectionValueSource(async (id) => (await manager.openKey(id)) ?? null)
  // A key set, replaced or forgotten, or a connection removed: its cached
  // usage line said something about the old key. The change carries the
  // whole list, so the key's moment (`keySetAt`) tells which moved; the
  // first change, with nothing to compare to, drops every line.
  let known: Map<string, number | null> | null = null
  manager.onChange((connections) => {
    const next = new Map(connections.map((c) => [c.id, c.keySetAt] as const))
    for (const [id, setAt] of next)
      if (!known || !known.has(id) || known.get(id) !== setAt) usage.invalidate(id)
    if (known) for (const id of known.keys()) if (!next.has(id)) usage.invalidate(id)
    known = next
  })
}
