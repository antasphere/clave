import os from 'os'
import path from 'path'
import type { AgentKind } from '../shared/agent-launch'
import type { CatalogModel } from './models-catalog'
import { modelsCatalog } from './models-catalog'
import { PROVIDER_COMPANY_BY_ID, type ProviderCompanyId } from './models-catalog-overlay'
import { lazySettingsPorts } from './ports/registry'
import { providerInjection, type ConnectionForSpawn } from './provider-injection'
import { syncPiConnectionDir } from './provider-injection-pi-dir'
import { setConnectionRefSource, setConnectionValueSource } from './provider-usage'
import { getLoginShellEnv } from './sessions/adapters/pty-backend'
import { TEST_NO_ACTIVATE } from './test-mode'

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

// The test hooks' namespace (`--test-no-activate` only): a spec plugs made-up
// connections here until the connection store exists. Consulted by the
// in-process server alone, as the settings hook is (settings/shell-source.ts).
if (TEST_NO_ACTIVATE) {
  const hooks = ((globalThis as { __claveE2E?: Record<string, unknown> }).__claveE2E ??= {})
  hooks.providerInjection = { setConnectionSource, setConnectionListingSource }
  hooks.providerUsage = { setConnectionRefSource, setConnectionValueSource }
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
  }
  // Catalogue models matter only for a provider Clave declares in full.
  const company = connection ? PROVIDER_COMPANY_BY_ID[connection.company] : undefined
  const catalogModels =
    connection && company && company[kind] === null && company.catalog
      ? await (deps.catalog ?? ((id) => modelsCatalog.modelsOf(id)))(company.catalog)
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
