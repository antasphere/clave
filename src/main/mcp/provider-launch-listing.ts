/**
 * What Pi's and OpenCode's launcher rows list (PRDCT-4496), read the same way
 * by the daemon's `clave_launch_options` (`standalone-launch-facts.ts`) and the
 * Mac's served one (`served-tools.ts`): a person and an agent read the same
 * lists. Pure over its inputs; nothing here imports Electron or a store.
 */
import type { ModelsCatalogView } from '@clave/contract/settings/models-catalog-view'
import type { ProviderConnectionView } from '@clave/contract/settings/connections'
import type { LaunchProfile } from '../../shared/agent-launch'
import type { LaunchModel } from '../../shared/launch-options'
import { modelsForProviderConnections } from '../../shared/launch-models'
import { isAccountPoolId, type Connection, type ConnectionPoolId } from '../../shared/connection'
import { providerConnection } from '../../shared/provider-connection'
import { PROVIDER_LISTING_FACTS, type ProviderCompanyId } from '../models-catalog-overlay'

/** The launcher's DEFAULT_MODEL: the harness's own default, no flag passed. */
const DEFAULT_MODEL: LaunchModel = { id: null, label: 'Default', family: 'Default' }

export interface ProviderListingDeps {
  /** The catalogue of those models.dev provider ids (`modelsCatalog.view`);
   *  absent, no catalogue model is listed. */
  readonly catalog?: (providerIds: readonly string[]) => Promise<ModelsCatalogView>
  /** The stored connections of a Pi or OpenCode launch
   *  (`providerConnectionsForListing`); absent, none. */
  readonly providerConnections?: (
    harness: 'pi' | 'opencode'
  ) => readonly { id: string; label: string; company: ProviderCompanyId }[]
}

/** The models Pi's launch profiles pin, each once, in the profiles' order. */
export function pinnedPiModels(profiles: readonly LaunchProfile[]): string[] {
  return [
    ...new Set(
      profiles
        .filter((profile) => profile.family === 'pi')
        .map((profile) => profile.pi?.model)
        .filter((model): model is string => !!model)
    )
  ]
}

/** The launcher menu's list for Pi or OpenCode: the harness's own default
 *  (whatever its own config names), the catalogue models of each stored
 *  connection's company, then the `pinned` models (Pi's profiles pin them). */
export async function providerHarnessModels(
  harness: 'pi' | 'opencode',
  pinned: readonly string[],
  deps: ProviderListingDeps
): Promise<LaunchModel[]> {
  const connections = deps.providerConnections?.(harness) ?? []
  const providerIds = [
    ...new Set(
      connections
        .map((c) => PROVIDER_LISTING_FACTS[c.company]?.catalog)
        .filter((id): id is string => !!id)
    )
  ]
  // A failed read lists no catalogue model, never 'unavailable': the
  // harness's own login is always a row.
  let view: ModelsCatalogView | null = null
  if (providerIds.length > 0 && deps.catalog) {
    try {
      view = await deps.catalog(providerIds)
    } catch {
      view = null
    }
  }
  const rows = modelsForProviderConnections(view, connections, PROVIDER_LISTING_FACTS, pinned)
  // Never 'loading': the view is read or null by now.
  if (rows === 'loading')
    return [DEFAULT_MODEL, ...pinned.map((id) => ({ id, label: id, family: id }))]
  return rows.map((row) => ({ id: row.id ?? null, label: row.label, family: row.family }))
}

/** A provider pool's stored connections: that company's, in the store's
 *  order, as the one shape of a connection. An account pool has none here. */
export function providerPoolConnections(
  pool: ConnectionPoolId,
  views: readonly ProviderConnectionView[]
): Connection[] {
  return isAccountPoolId(pool)
    ? []
    : views.filter((view) => view.company === pool).map(providerConnection)
}
