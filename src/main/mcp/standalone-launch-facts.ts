/**
 * What a Clave server (`clave-server --daemon`) knows of its own launcher,
 * for its agent tools (PRDCT-4485): the routines' launch facts (the pools,
 * the selected connection, the profiles, the remembered model) plus what the
 * launcher menu reads beside them: the harnesses installed and at which
 * version, each harness's models, the launch settings and the switch mode.
 *
 * `clave_launch_options` assembles `launchOptionsInput` from these and calls
 * the shared `launchOptions`; `clave_open_session` resolves through the
 * routines' `resolveLaunch` over the same facts; `clave_list` and
 * `clave_switch_account` read a tab's connection with `accountOf`. Nothing
 * here imports Electron.
 */
import type { SessionRecord } from '@clave/contract/sessions'
import type { AgentUpdateStatus } from '../../shared/agent-updates'
import { BUILT_IN_LAUNCH_PROFILES, type LaunchProfile } from '../../shared/agent-launch'
import { isExhausted } from '../../shared/account-pool'
import { CLAUDE_MODELS } from '../../shared/claude-models'
import {
  DEFAULT_INTERACTION_MODE,
  HARNESSES,
  isInteractionMode,
  sanitizeHarnessSettings,
  type HarnessId,
  type HarnessSettingsById,
  type InteractionMode
} from '../../shared/harness'
import type { LaunchModel, LaunchOptionsInput } from '../../shared/launch-options'
import type { ProviderConnectionView } from '@clave/contract/settings/connections'
import { isAccountPoolId, type Connection, type ConnectionPoolId } from '../../shared/connection'
import type { ModelOption } from '../../shared/session-model'
import {
  pinnedPiModels,
  providerHarnessModels,
  providerPoolConnections,
  type ProviderListingDeps
} from './provider-launch-listing'
import { usageSummaryForModel } from '../../shared/usage-summary'
import type { HarnessDetection } from '../agent-updates/standalone-detection'
import { openProfileIdFor, type LaunchFacts } from '../routines/launch'
import type { AccountProvider, AccountSwitchMode, ServedAccount } from './served-core'

export interface StandaloneLaunchFacts extends LaunchFacts {
  /** This server, as a client names it. */
  machine(): { id: string; name: string }
  /** What detection says of each harness on this machine; rejects when a
   *  step of the pass failed (never a half-run reported as fact). */
  harnesses(): Promise<ReadonlyArray<AgentUpdateStatus>>
  /** The models a harness's launcher row offers; 'unavailable' when the list could not be read. */
  models(harness: HarnessId): Promise<readonly LaunchModel[] | 'unavailable'>
  /** The profile a click on the harness's row launches; undefined when it cannot be resolved. */
  defaultProfileId(harness: HarnessId): string | undefined
  harnessSettings(): HarnessSettingsById
  interactionMode(): InteractionMode
  /** The server's own account switch mode (it has no workspace of its own). */
  switchMode(): AccountSwitchMode
  /** A provider pool's stored connections (PRDCT-4496): that company's, in
   *  the store's order, as the one shape of a connection. */
  providerPool?(pool: ConnectionPoolId): readonly Connection[]
  now(): number
}

/** `catalog` and `providerConnections` (`ProviderListingDeps`) feed Pi's
 *  and OpenCode's model lists; absent, no catalogue model is listed. */
export interface StandaloneLaunchDeps extends ProviderListingDeps {
  readonly facts: LaunchFacts
  readonly detection: HarnessDetection
  readonly identity: () => { id: string; name: string }
  /** A preference by key, as `preferencesManager.get` answers it. */
  readonly preferences: (key: string) => unknown
  /** Codex's models (`providerModels('codex-chat', cwd)`). */
  readonly codexModels: (cwd: string) => Promise<ModelOption[]>
  readonly homeDir: string
  /** `launchProfileManager.resolve(family)`: the family's default profile; may throw. */
  readonly defaultProfile: (family: HarnessId) => { id: string }
  /** Every stored provider connection of this server, never a key
   *  (`providerConnectionsManager.list`); absent, none. */
  readonly providerConnectionViews?: () => readonly ProviderConnectionView[]
  readonly now?: () => number
}

/** The launcher's `modelsFor` (`SessionLauncher.tsx`): Claude's own list. */
const CLAUDE_LAUNCH_MODELS: readonly LaunchModel[] = CLAUDE_MODELS.map((model) => ({
  id: model.id,
  label: model.name,
  family: model.alias.charAt(0).toUpperCase() + model.alias.slice(1)
}))

/** Built-ins and the person's, of one family. */
export function profilesOf(facts: LaunchFacts, family: HarnessId): LaunchProfile[] {
  return [...BUILT_IN_LAUNCH_PROFILES, ...(facts.preferences().customProfiles ?? [])].filter(
    (profile) => profile.family === family
  )
}

const switchModeOf = (raw: unknown): AccountSwitchMode | null =>
  raw === 'propose' || raw === 'automatic' ? raw : null

export function standaloneLaunchFacts(deps: StandaloneLaunchDeps): StandaloneLaunchFacts {
  const { facts } = deps
  return {
    accounts: (provider) => facts.accounts(provider),
    selectedAccountId: (provider) => facts.selectedAccountId(provider),
    ...(facts.useRecommendedAccount
      ? { useRecommendedAccount: () => facts.useRecommendedAccount!() }
      : {}),
    preferences: () => facts.preferences(),
    ...(facts.launchModel ? { launchModel: facts.launchModel } : {}),
    machine: () => deps.identity(),
    harnesses: () => deps.detection.detect(),
    models: async (harness) => {
      if (harness === 'claude') return CLAUDE_LAUNCH_MODELS
      if (harness === 'codex') {
        try {
          const listed = await deps.codexModels(deps.homeDir)
          if (listed.length === 0) return 'unavailable'
          return listed.map((m) => ({ id: m.id, label: m.label, family: m.label }))
        } catch {
          return 'unavailable'
        }
      }
      if (harness === 'pi' || harness === 'opencode')
        // The launcher menu's list (PRDCT-4496), the Mac's served road's too.
        return providerHarnessModels(
          harness,
          harness === 'pi' ? pinnedPiModels(profilesOf(facts, 'pi')) : [],
          deps
        )
      return []
    },
    defaultProfileId: (harness) => {
      try {
        return deps.defaultProfile(harness).id
      } catch {
        return undefined
      }
    },
    // The keys `launch-settings.ts` reads on the Mac, read here on the server's own store.
    harnessSettings: () => sanitizeHarnessSettings(deps.preferences('harnessSettings')),
    interactionMode: () => {
      const mode = deps.preferences('interactionMode')
      return isInteractionMode(mode) ? mode : DEFAULT_INTERACTION_MODE
    },
    // The Mac's shell `switchMode(workspaceId)` with no workspace: the global one, else propose.
    switchMode: () => switchModeOf(deps.preferences('accountSwitchMode')) ?? 'propose',
    providerPool: (pool) => providerPoolConnections(pool, deps.providerConnectionViews?.() ?? []),
    now: deps.now ?? (() => Date.now())
  }
}

/** The pool a record's tab runs on, or null for a harness with none. */
export function poolOfRecord(record: SessionRecord): AccountProvider | null {
  if (record.codexMode) return 'codex'
  if (record.claudeMode || record.claudeAgentsMode) return 'claude'
  return null
}

/** The connection a tab runs on, the daemon's twin of the Mac's `accountOf`
 *  (`mcp-server.ts`): its id (else `default`), its label, and whether it is
 *  about to stop for the tab's own model. Null for a tab with no pool. */
export function accountOf(facts: LaunchFacts, record: SessionRecord): ServedAccount | null {
  const pool = poolOfRecord(record)
  if (!pool) return null
  const id = (pool === 'codex' ? record.codexAccountId : record.claudeProfileId) ?? 'default'
  const account = facts.accounts(pool).find((a) => a.id === id)
  const recorded = pool === 'codex' ? record.codexAccountLabel : record.claudeProfileLabel
  return {
    id,
    label: account?.label ?? recorded ?? 'Removed account',
    exhausted: isExhausted(usageSummaryForModel(account?.usage, record.model ?? undefined))
  }
}

/** The shared function's input for this server: detection's statuses
 *  (none when the detection failed: every harness listed, presence unknown),
 *  the models read ahead (the input is synchronous), the facts for the rest. */
export function launchOptionsInput(
  facts: StandaloneLaunchFacts,
  statuses: ReadonlyArray<AgentUpdateStatus> | undefined,
  models: Partial<Record<HarnessId, readonly LaunchModel[] | 'unavailable'>>
): LaunchOptionsInput {
  return {
    machine: facts.machine(),
    harnesses: HARNESSES,
    presence: (id) => {
      const status = statuses?.find((s) => s.id === id)
      return status
        ? {
            installed: status.installed,
            version: status.currentVersion,
            checkedAt: status.lastCheckedAt
          }
        : undefined
    },
    profiles: (id) => profilesOf(facts, id),
    defaultProfileId: (id) => facts.defaultProfileId(id),
    // What `clave_open_session` with no profile and no chat flag resolves,
    // by the same two steps (`openFormOf`, `resolveLaunch`'s profile step);
    // a terminal names none, and main runs the family's default profile.
    openProfileId: (id) =>
      openProfileIdFor(facts.preferences(), id, facts.interactionMode()) ??
      facts.defaultProfileId(id),
    models: (id) => models[id] ?? [],
    harnessSettings: facts.harnessSettings(),
    interactionMode: facts.interactionMode(),
    // A provider pool lists the server's stored connections of that company
    // (PRDCT-4496); an account pool its accounts.
    connections: (pool) =>
      isAccountPoolId(pool) ? facts.accounts(pool) : (facts.providerPool?.(pool) ?? []),
    selectedConnectionId: (pool) =>
      isAccountPoolId(pool) ? facts.selectedAccountId(pool) : undefined,
    preferRecommended: facts.useRecommendedAccount?.() ?? false,
    launchModel: (pool, profileId) =>
      isAccountPoolId(pool as ConnectionPoolId)
        ? facts.launchModel?.(pool as AccountProvider, profileId, undefined)
        : undefined,
    now: facts.now()
  }
}

/** Every model list of the table's harnesses that take one, read in parallel. */
export async function modelsOfHarnesses(
  facts: StandaloneLaunchFacts
): Promise<Partial<Record<HarnessId, readonly LaunchModel[] | 'unavailable'>>> {
  const entries = await Promise.all(
    HARNESSES.filter((h) => h.takesModel).map(
      async (h) => [h.id, await facts.models(h.id).catch(() => 'unavailable' as const)] as const
    )
  )
  return Object.fromEntries(entries)
}
