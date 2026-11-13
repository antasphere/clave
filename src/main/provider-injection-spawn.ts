import os from 'os'
import path from 'path'
import type { AgentKind } from '../shared/agent-launch'
import type { CatalogModel } from './models-catalog'
import { modelsCatalog } from './models-catalog'
import {
  providerCompany,
  type ProviderCompanyId
} from '@clave/contract/settings/provider-catalogue'
import { PROVIDER_ROAD_BY_ID } from './models-catalog-overlay'
import { lazySettingsPorts } from './ports/registry'
import { providerInjection, type ConnectionForSpawn } from './provider-injection'
import { syncPiConnectionDir } from './provider-injection-pi-dir'
import { getLoginShellEnv } from './sessions/adapters/pty-backend'

/**
 * The spawn's half of a connection (PRDCT-4496), the way
 * `accountTokenForSpawn` is a Claude account's: for a Pi or an OpenCode tab
 * only, the stored connection it names is opened here, where the spawn is
 * already asynchronous, and turned into the variables its process starts
 * with. What comes back is never written on the record.
 */

/** Where a Pi connection's agent directories live, beside the Codex homes. */
const PI_CONNECTIONS_DIR = 'pi-connections'

type ConnectionSource = (id: string) => Promise<ConnectionForSpawn | null>

let connectionSource: ConnectionSource | null = null

/** The store of connections plugs itself in here; none until it does. */
export function setConnectionSource(fn: ConnectionSource): void {
  connectionSource = fn
}

/** A stored connection as the daemon's model listing reads it: no value. */
export interface ProviderConnectionListing {
  id: string
  label: string
  company: ProviderCompanyId
}

type ConnectionListingSource = (harness: 'pi' | 'opencode') => readonly ProviderConnectionListing[]

let connectionListingSource: ConnectionListingSource | null = null

/** The store of connections plugs its `forHarness` in here; none until it does. */
export function setConnectionListingSource(fn: ConnectionListingSource | null): void {
  connectionListingSource = fn
}

/** The stored connections a Pi or OpenCode launch can run on, in the store's
 *  order, for the daemon's `clave_launch_options` (PRDCT-4496); none until
 *  the store plugs in. */
export function providerConnectionsForListing(
  harness: 'pi' | 'opencode'
): readonly ProviderConnectionListing[] {
  return connectionListingSource ? connectionListingSource(harness) : []
}

export interface ProviderInjectionSpawnDeps {
  source?: ConnectionSource | null
  catalog?: (providerId: string) => Promise<CatalogModel[]>
  sync?: typeof syncPiConnectionDir
  /** The parent of every connection's Pi directory. */
  root?: () => string
  loginEnv?: () => Record<string, string | undefined>
  homedir?: () => string
}

export interface ProviderSpawnFields {
  providerEnv?: Record<string, string>
  piProvider?: string
  opencodeStandalone?: boolean
}

export async function providerInjectionForSpawn(
  kind: AgentKind | null,
  options: { connectionId?: string; model?: string },
  deps: ProviderInjectionSpawnDeps = {}
): Promise<ProviderSpawnFields> {
  // The two process-only fields are always present, so the spread over a
  // caller's options replaces whatever a client put there: `pty:spawn` passes
  // the renderer's options through, and no client chooses a process's
  // environment. `piProvider` is a client's choice and is only ever set.
  const out: ProviderSpawnFields = { providerEnv: undefined, opencodeStandalone: undefined }
  if (kind !== 'pi' && kind !== 'opencode') return out
  let connection: ConnectionForSpawn | null = null
  if (options.connectionId) {
    const source = deps.source !== undefined ? deps.source : connectionSource
    connection = source ? await source(options.connectionId) : null
    if (!connection) throw new Error('The selected connection is no longer available.')
    // A company that takes a key starts nowhere without one: never on a
    // placeholder, never on the harness's own login in its place.
    if (connection.value === null && providerCompany(connection.company).needsKey)
      throw new Error('The connection has no key yet.')
  }
  // Catalogue models matter only for a provider Clave declares in full.
  const road = connection ? PROVIDER_ROAD_BY_ID[connection.company] : undefined
  const catalogModels =
    connection && road && road[kind] === null && road.catalog
      ? await (deps.catalog ?? ((id) => modelsCatalog.modelsOf(id)))(road.catalog)
      : undefined
  const injection = providerInjection({
    harness: kind,
    connection,
    model: options.model,
    catalogModels
  })
  const providerEnv: Record<string, string> = { ...injection.env }
  if (kind === 'pi' && connection && injection.piEntry) {
    const loginEnv = (deps.loginEnv ?? getLoginShellEnv)()
    const homeAgentDir =
      loginEnv.PI_CODING_AGENT_DIR?.trim() ||
      path.join((deps.homedir ?? os.homedir)(), '.pi', 'agent')
    const root = (deps.root ?? (() => lazySettingsPorts.storage.pathOf(PI_CONNECTIONS_DIR)))()
    providerEnv.PI_CODING_AGENT_DIR = (deps.sync ?? syncPiConnectionDir)({
      root,
      homeAgentDir,
      connectionId: connection.id,
      providerId: injection.piEntry.providerId,
      entry: injection.piEntry.entry
    })
  }
  if (Object.keys(providerEnv).length > 0) out.providerEnv = providerEnv
  if (injection.piProvider) out.piProvider = injection.piProvider
  if (injection.opencodeStandalone) out.opencodeStandalone = true
  return out
}
