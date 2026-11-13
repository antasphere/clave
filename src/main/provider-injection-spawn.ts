import os from 'os'
import path from 'path'
import type { AgentKind } from '../shared/agent-launch'
import type { CatalogModel } from './models-catalog'
import { modelsCatalog } from './models-catalog'
import {
  providerCompany,
  type ProviderCompanyId
} from '@clave/contract/settings/provider-catalogue'
import { PROVIDER_ROAD_BY_ID, piProviderOf } from './models-catalog-overlay'
import { lazySettingsPorts } from './ports/registry'
import { providerInjection, type ConnectionForSpawn } from './provider-injection'
import { readPiOwnDefault, syncPiConnectionDir } from './provider-injection-pi-dir'
import { piStartModel, type PiOwnDefault, type PiStartModel } from '../shared/pi-start-model'
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
  /** Reads the person's Pi default from their agent directory. */
  ownDefault?: (homeAgentDir: string) => PiOwnDefault | null
}

export interface ProviderSpawnFields {
  providerEnv?: Record<string, string>
  piProvider?: string
  opencodeStandalone?: boolean
  /** The model a Pi tab on a connection starts on when none was picked
   *  (`piStartModel`): set only then, so a picked model is never replaced. */
  model?: string
}

/** The person's own Pi agent directory, as their Pi finds it: the login
 *  shell's `PI_CODING_AGENT_DIR`, else `~/.pi/agent`. */
export function piHomeAgentDir(
  deps: Pick<ProviderInjectionSpawnDeps, 'loginEnv' | 'homedir'> = {}
): string {
  const loginEnv = (deps.loginEnv ?? getLoginShellEnv)()
  return (
    loginEnv.PI_CODING_AGENT_DIR?.trim() ||
    path.join((deps.homedir ?? os.homedir)(), '.pi', 'agent')
  )
}

/** The person's own Pi default, read where their Pi keeps it. */
export function piOwnDefault(
  deps: Pick<ProviderInjectionSpawnDeps, 'loginEnv' | 'homedir' | 'ownDefault'> = {}
): PiOwnDefault | null {
  return (deps.ownDefault ?? readPiOwnDefault)(piHomeAgentDir(deps))
}

/** The model a Pi tab on this connection starts on when the open names none
 *  (`piStartModel`): the person's default when it is the connection's
 *  provider's, else the first catalogue model the launcher lists for it. */
export async function piConnectionStartModel(
  connection: { label: string; company: ProviderCompanyId },
  deps: Pick<ProviderInjectionSpawnDeps, 'catalog' | 'loginEnv' | 'homedir' | 'ownDefault'> = {}
): Promise<PiStartModel> {
  const catalogId = PROVIDER_ROAD_BY_ID[connection.company]?.catalog
  let listed: string[] = []
  if (catalogId) {
    try {
      listed = (await (deps.catalog ?? ((id) => modelsCatalog.modelsOf(id)))(catalogId)).map(
        (m) => m.id
      )
    } catch {
      listed = []
    }
  }
  return piStartModel({
    provider: piProviderOf(connection.company),
    ownDefault: piOwnDefault(deps),
    listed,
    label: connection.label
  })
}

/** The environment Pi's session files are looked up in for a tab on this
 *  connection (or on none): the connection's own directory over the login
 *  shell's, as its process runs. The directory links `sessions` to the
 *  person's own only when the person had one at its first sync; a person
 *  whose first Pi ran on a connection has its sessions there alone. */
export function piSessionLookupEnv(
  connectionId: string | undefined,
  deps: Pick<ProviderInjectionSpawnDeps, 'root' | 'loginEnv'> = {}
): Record<string, string | undefined> {
  const loginEnv = (deps.loginEnv ?? getLoginShellEnv)()
  if (!connectionId || connectionId === '.' || connectionId === '..' || /[/\\]/.test(connectionId))
    return loginEnv
  const root = (deps.root ?? (() => lazySettingsPorts.storage.pathOf(PI_CONNECTIONS_DIR)))()
  return { ...loginEnv, PI_CODING_AGENT_DIR: path.join(root, connectionId) }
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
  // Pi refuses `--provider` without `--model` and exits before it speaks
  // (Pi 1.5.2): a Pi tab on a connection that names no model starts on the
  // one `piStartModel` picks, the same for both forms and every road, or is
  // refused in its one sentence before any process starts.
  let model = options.model
  let startModel: string | undefined
  if (kind === 'pi' && connection && !model) {
    const start = await piConnectionStartModel(connection, deps)
    if (!start.ok) throw new Error(start.reason)
    model = startModel = start.model
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
    model,
    catalogModels
  })
  const providerEnv: Record<string, string> = { ...injection.env }
  if (kind === 'pi' && connection && injection.piEntry) {
    const homeAgentDir = piHomeAgentDir(deps)
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
  if (startModel) out.model = startModel
  return out
}
