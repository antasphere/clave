/**
 * The input of `launchOptions` (`src/shared/launch-options.ts`) as the window
 * assembles it, for `clave_launch_options` (PRDCT-4485): a connected server's
 * from the settings this Mac keeps of it (`serverLaunchSource`), and this
 * Mac's own from the local stores when the call reaches the window without a
 * server (an old client, a road where the window answers). Pure but for the
 * stores `localLaunchOptionsInput` reads, so the server's assembly is tested
 * without the dispatcher.
 *
 * The rules are the shared function's; this file only says where each fact
 * comes from: the launcher's sources for the profiles and the selected
 * connection, the account views `connectionsForModel` builds the pools from
 * (`ownerViewFrom`, `poolOf`) for the connections, the launcher's
 * `modelsFor` for the models.
 */
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import type { AgentUpdateStatus } from '../../../shared/agent-updates'
import { CLAUDE_MODELS } from '../../../shared/claude-models'
import {
  HARNESSES,
  HARNESS_BY_ID,
  type HarnessId,
  type HarnessSettingsById,
  type InteractionMode
} from '../../../shared/harness'
import type {
  HarnessPresence,
  LaunchModel,
  LaunchOptionsInput,
  PooledConnection
} from '../../../shared/launch-options'
import { modelsForProviderConnections } from '../../../shared/launch-models'
import { PROVIDER_LISTING_FACTS } from '../../../main/models-catalog-overlay'
import { isAccountPoolId, isConnectionPoolId } from '../../../shared/connection'
import { providerConnection } from '../../../shared/provider-connection'
import type { ProviderConnectionView } from '@clave/contract/settings/connections'
import { useProviderConnectionsStore } from '../store/provider-connections-store'
import type { ServerSettings } from '../store/server-settings-state'
import { localLaunchSource, serverLaunchSource, type LaunchSource } from './launch-source'
import { localOpenProfileId } from './launch-model'
import {
  currentAccountSources,
  ownerViewFrom,
  poolOf,
  type AccountProvider,
  type AccountSources
} from './session-accounts'

/** The launcher's DEFAULT_MODEL: the harness's own default, no flag passed. */
const DEFAULT_MODEL: LaunchModel = { id: null, label: 'Default', family: 'Default' }

/** Codex's list as `adapters:models` answers it, or 'unavailable' when the
 *  read failed or came back empty. */
export type CodexModels = readonly { id: string; label: string }[] | 'unavailable'

/** What the window passes in: the launch settings store's two facts, the
 *  Codex list it read, the clock. */
export interface WindowLaunchFacts {
  readonly harnessSettings: HarnessSettingsById
  readonly interactionMode: InteractionMode
  readonly codexModels: CodexModels
  readonly now: number
}

/** The launcher's `modelsFor`, on a source: Claude's from the table, Codex's
 *  from the list read (unavailable when it failed or was empty); Pi's and
 *  OpenCode's the menu's own list (PRDCT-4496): the default, the catalogue
 *  models of each stored connection's company, then, for Pi, the models the
 *  machine's Pi profiles pin; none for the rest. */
export function launchModelsOf(
  source: Pick<LaunchSource, 'profilesFor' | 'catalog' | 'providerConnections'>,
  harness: HarnessId,
  codexModels: CodexModels
): readonly LaunchModel[] | 'unavailable' {
  if (harness === 'claude')
    return CLAUDE_MODELS.map((model) => ({
      id: model.id,
      label: model.name,
      family: model.alias.charAt(0).toUpperCase() + model.alias.slice(1)
    }))
  if (harness === 'codex')
    return codexModels === 'unavailable' || codexModels.length === 0
      ? 'unavailable'
      : codexModels.map((model) => ({ id: model.id, label: model.label, family: model.label }))
  if (harness === 'pi' || harness === 'opencode') {
    const pinned =
      harness === 'pi'
        ? [
            ...new Set(
              source
                .profilesFor('pi')
                .map((profile) => profile.pi?.model)
                .filter((model): model is string => !!model)
            )
          ]
        : []
    const rows = modelsForProviderConnections(
      source.catalog(),
      source.providerConnections(harness),
      PROVIDER_LISTING_FACTS,
      pinned
    )
    // The listing is synchronous and must answer something: while the
    // catalogue is still being read, the default and the pinned models.
    if (rows === 'loading')
      return [DEFAULT_MODEL, ...pinned.map((id) => ({ id, label: id, family: id }))]
    return rows.map((row) => ({ id: row.id ?? null, label: row.label, family: row.family }))
  }
  return []
}

/** One owner's pool as the shared function reads it: the pool's order, who
 *  can sign in, the API keys as fallback, each account's own usage. A
 *  provider pool (PRDCT-4496) is the owner's stored connections of that
 *  company, as the one shape of a connection (`providerConnection`), from
 *  lane B's store unless `providers` is given. */
export function poolConnections(
  sources: AccountSources,
  owner: string,
  pool: string,
  providers?: readonly ProviderConnectionView[]
): PooledConnection[] {
  if (isConnectionPoolId(pool) && !isAccountPoolId(pool))
    return (
      providers ??
      (useProviderConnectionsStore.getState().byMachine[owner]?.connections as
        | readonly ProviderConnectionView[]
        | undefined) ??
      []
    )
      .filter((view) => view.company === pool)
      .map(providerConnection)
  if (pool !== 'claude' && pool !== 'codex') return []
  const view = ownerViewFrom(sources, owner, pool as AccountProvider)
  return poolOf(view).map((a) => ({
    id: a.id,
    usable: a.usable,
    ...(a.fallback ? { fallback: true } : {}),
    label: view.accounts.find((account) => account.id === a.id)?.label ?? a.id,
    usage: view.usage[a.id]
  }))
}

const isPool = (pool: string): pool is AccountProvider => pool === 'claude' || pool === 'codex'

/** A connected server, from the settings this Mac read of it. The Mac never
 *  checks a server's harnesses: every one is listed, installed unknown, as
 *  the launcher shows a server. Its pool makes its own pick, so no
 *  recommendation and no remembered model are read here. */
export function serverLaunchOptionsInput(
  serverId: string,
  name: string,
  settings: ServerSettings,
  facts: WindowLaunchFacts
): LaunchOptionsInput {
  const source = serverLaunchSource(serverId, name, settings)
  const sources: AccountSources = {
    claude: [],
    codex: [],
    claudeUsage: {},
    codexUsage: {},
    servers: { [serverId]: settings }
  }
  return {
    machine: { id: serverId, name },
    harnesses: HARNESSES,
    presence: () => undefined,
    profiles: (family) => source.profilesFor(family),
    defaultProfileId: (family) => source.selectedProfileId(family),
    // What the server's open resolves with no profile and no chat flag: its
    // chat default under a chat interaction mode, else its default profile.
    openProfileId: (family) =>
      facts.interactionMode !== 'terminal' && HARNESS_BY_ID[family].chatAdapterId !== null
        ? source.chatProfileId(family)
        : source.selectedProfileId(family),
    models: (harness) => launchModelsOf(source, harness, facts.codexModels),
    harnessSettings: facts.harnessSettings,
    interactionMode: facts.interactionMode,
    connections: (pool) => poolConnections(sources, serverId, pool),
    selectedConnectionId: (pool) =>
      isPool(pool) ? (source.selectedAccountId(pool) ?? undefined) : undefined,
    preferRecommended: false,
    // The Mac does not know a server's remembered chat model (it lives in
    // the server's own preferences): the open profile names no model here.
    launchModel: () => undefined,
    now: facts.now
  }
}

/** This Mac, from the local stores, with the harness detection's last word
 *  and the account policy the window knows. */
export function localLaunchOptionsInput(
  facts: WindowLaunchFacts & {
    readonly agents: readonly Pick<
      AgentUpdateStatus,
      'id' | 'installed' | 'currentVersion' | 'lastCheckedAt'
    >[]
    readonly preferRecommended: boolean
    /** The model a launch naming none runs, per pool, on the profile its
     *  open resolves (`localOpenProfileId`). */
    readonly launchModels?: Partial<Record<AccountProvider, string | undefined>>
  }
): LaunchOptionsInput {
  const source = localLaunchSource(null)
  const openProfileId = (family: HarnessId): string =>
    localOpenProfileId(family, facts.interactionMode, null)
  const sources = currentAccountSources()
  return {
    machine: { id: LOCAL_SERVER_ID, name: source.name },
    harnesses: HARNESSES,
    presence: (id): HarnessPresence | undefined => {
      const status = facts.agents.find((a) => a.id === id)
      return status
        ? {
            installed: status.installed,
            version: status.currentVersion,
            checkedAt: status.lastCheckedAt
          }
        : undefined
    },
    profiles: (family) => source.profilesFor(family),
    defaultProfileId: (family) => source.selectedProfileId(family),
    openProfileId,
    models: (harness) => launchModelsOf(source, harness, facts.codexModels),
    harnessSettings: facts.harnessSettings,
    interactionMode: facts.interactionMode,
    connections: (pool) => poolConnections(sources, LOCAL_SERVER_ID, pool),
    selectedConnectionId: (pool) =>
      isPool(pool) ? (source.selectedAccountId(pool) ?? undefined) : undefined,
    preferRecommended: facts.preferRecommended,
    launchModel: (pool) => (isPool(pool) ? facts.launchModels?.[pool] : undefined),
    now: facts.now
  }
}
