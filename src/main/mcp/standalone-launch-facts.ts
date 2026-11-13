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
import { modelsForProviderConnections } from '../../shared/launch-models'
import type { ModelsCatalogView } from '@clave/contract/settings/models-catalog-view'
import { PROVIDER_COMPANY_BY_ID, type ProviderCompanyId } from '../models-catalog-overlay'
import type { ModelOption } from '../../shared/session-model'
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
  now(): number
}

export interface StandaloneLaunchDeps {
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
  /** The catalogue of those models.dev provider ids (`modelsCatalog.view`);
   *  absent, no catalogue model is listed. */
  readonly catalog?: (providerIds: readonly string[]) => Promise<ModelsCatalogView>
  /** The stored connections of a Pi or OpenCode launch
   *  (`providerConnectionsForListing`); absent, none. */
  readonly providerConnections?: (
    harness: 'pi' | 'opencode'
  ) => readonly { id: string; label: string; company: ProviderCompanyId }[]
  readonly now?: () => number
}

const DEFAULT_MODEL: LaunchModel = { id: null, label: 'Default', family: 'Default' }

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
      if (harness === 'pi' || harness === 'opencode') {
        // The launcher menu's list (PRDCT-4496): the harness's own default
        // (whatever its own config names), the catalogue models of each
        // stored connection's company, then the models Pi's profiles pin.
        const pinned =
          harness === 'pi'
            ? [
                ...new Set(
                  profilesOf(facts, 'pi')
                    .map((profile) => profile.pi?.model)
                    .filter((model): model is string => !!model)
                )
              ]
            : []
        const connections = deps.providerConnections?.(harness) ?? []
        const providerIds = [
          ...new Set(
            connections
              .map((c) => PROVIDER_COMPANY_BY_ID[c.company]?.catalog)
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
        const rows = modelsForProviderConnections(view, connections, PROVIDER_COMPANY_BY_ID, pinned)
        // Never 'loading': the view is read or null by now.
        if (rows === 'loading')
          return [DEFAULT_MODEL, ...pinned.map((id) => ({ id, label: id, family: id }))]
        return rows.map((row) => ({ id: row.id ?? null, label: row.label, family: row.family }))
      }
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
    connections: (pool) => facts.accounts(pool as AccountProvider),
    selectedConnectionId: (pool) => facts.selectedAccountId(pool as AccountProvider),
    preferRecommended: facts.useRecommendedAccount?.() ?? false,
    launchModel: (pool, profileId) =>
      facts.launchModel?.(pool as AccountProvider, profileId, undefined),
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
