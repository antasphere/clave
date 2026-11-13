/**
 * The settings calls of the typed client, lane D's module: every command
 * and query of `@clave/contract/settings` as a promise, derived from the
 * shared API the way `api.ts` derives the sessions and the clients. The
 * token and the API key go out as the plain strings the wire carries (the
 * encoded side of the contract's redacted fields) and come back in nothing.
 */
import { Schema, type Effect } from 'effect'
import { NotFoundProblem } from '@structure-ai/http'
import type * as S from '@clave/contract/settings'
import type { Call, DerivedClient } from './call'

export type ClaudeAccount = typeof S.ClaudeAccountView.Type

/** A server released before the helpers' settings (PRDCT-4330): its router
 *  answers their routes with its own 404. Said as the fix, an update. */
export const HELPERS_NEED_UPDATE = 'This server needs an update to show its helpers.'
export class HelperPreferencesMissing extends Error {
  readonly _tag = 'HelperPreferencesMissing'
  constructor() {
    super(HELPERS_NEED_UPDATE)
    this.name = 'HelperPreferencesMissing'
  }
}
const helpersMissing = <T>(run: Promise<T>): Promise<T> =>
  run.catch((error: unknown) => {
    throw error instanceof Error && Schema.is(NotFoundProblem)(error.cause)
      ? new HelperPreferencesMissing()
      : error
  })

/** A server released before the integrations (PRDCT-4410): the same 404,
 *  said as the update it needs. */
export const INTEGRATIONS_NEED_UPDATE = 'This server needs an update to show its integrations.'
export class IntegrationsMissing extends Error {
  readonly _tag = 'IntegrationsMissing'
  constructor() {
    super(INTEGRATIONS_NEED_UPDATE)
    this.name = 'IntegrationsMissing'
  }
}
const integrationsMissing = <T>(run: Promise<T>): Promise<T> =>
  run.catch((error: unknown) => {
    throw error instanceof Error && Schema.is(NotFoundProblem)(error.cause)
      ? new IntegrationsMissing()
      : error
  })
export type CodexAccount = typeof S.CodexAccountView.Type
export type CodexAccountKind = typeof S.CodexAccountKind.Type
export type AccountProvider = typeof S.AccountProvider.Type
export type AccountLoginJob = typeof S.AccountLoginJobView.Type
export type UsageRead = typeof S.UsageReadView.Type
export type UsageSnapshot = typeof S.UsageSnapshotView.Type
export type PiUsageRange = typeof S.PiUsageRange.Type
export type PiUsageTotals = typeof S.PiUsageTotalsView.Type
export type LaunchProfile = typeof S.LaunchProfileView.Type
export type LauncherFamily = typeof S.LauncherFamily.Type
export type LaunchProfilePreferences = typeof S.LaunchProfilePreferencesView.Type
export type AppIcon = typeof S.AppIconSchema.Type
export type HelperPreference = typeof S.HelperPreferenceView.Type
export type HelperAccount = typeof S.HelperAccountView.Type
export interface HelperPreferencePatch {
  readonly enabled?: boolean
  readonly model?: string | null
  readonly account?: HelperAccount
}
export type IntegrationsStatus = typeof S.IntegrationsView.Type
export type ElevenLabsModelId = typeof S.ElevenLabsModelId.Type
export type ElevenLabsVoices = typeof S.ElevenLabsVoicesView.Type
export type Workspace = typeof S.WorkspaceView.Type
export type WorkspaceState = typeof S.WorkspaceStateView.Type
export type RegistryWriteResult = typeof S.UpdateWorkspaceRegistry.success.Type
export type PinsWriteResult = typeof S.UpdateWorkspacePins.success.Type
export type AntasphereAccountStatus = typeof S.AntasphereAccountStatusView.Type
export type AntasphereSignInResult = typeof S.SignInWithAntasphere.success.Type
export type AntasphereHandoff = typeof S.AntasphereHandoffView.Type
// ── Lane B (harness wave): provider connections ──
export type ProviderConnection = typeof S.ProviderConnectionView.Type
export type ProviderCompanyId = typeof S.ProviderCompanyId.Type
export type ProviderWireFormat = typeof S.ProviderWireFormat.Type
export interface ProviderConnectionAddInput {
  readonly company: ProviderCompanyId
  readonly label?: string
  readonly baseUrl?: string
  readonly wireFormat?: ProviderWireFormat
}

/** A server released before the provider connections (PRDCT-4426): the same
 *  404, said as the update it needs. */
export const PROVIDER_CONNECTIONS_NEED_UPDATE =
  'This server needs an update to show its provider connections.'
export class ProviderConnectionsMissing extends Error {
  readonly _tag = 'ProviderConnectionsMissing'
  constructor() {
    super(PROVIDER_CONNECTIONS_NEED_UPDATE)
    this.name = 'ProviderConnectionsMissing'
  }
}
const providerConnectionsMissing = <T>(run: Promise<T>): Promise<T> =>
  run.catch((error: unknown) => {
    throw error instanceof Error && Schema.is(NotFoundProblem)(error.cause)
      ? new ProviderConnectionsMissing()
      : error
  })

export interface SettingsClient {
  readonly claudeAccounts: {
    readonly list: () => Promise<ReadonlyArray<ClaudeAccount>>
    readonly migrated: () => Promise<ReadonlyArray<string>>
    readonly add: (label: string) => Promise<ClaudeAccount>
    readonly rename: (id: string, updates: { label?: string }) => Promise<ClaudeAccount | undefined>
    readonly reorder: (ids: ReadonlyArray<string>) => Promise<void>
    readonly remove: (id: string) => Promise<boolean>
    readonly setToken: (id: string, token: string) => Promise<UsageRead>
    readonly clearToken: (id: string) => Promise<void>
  }
  readonly codexAccounts: {
    readonly list: () => Promise<ReadonlyArray<CodexAccount>>
    readonly add: (label: string, kind?: CodexAccountKind) => Promise<CodexAccount>
    readonly rename: (id: string, updates: { label?: string }) => Promise<CodexAccount | undefined>
    readonly reorder: (ids: ReadonlyArray<string>) => Promise<void>
    readonly remove: (id: string) => Promise<boolean>
    readonly clearCredential: (id: string) => Promise<void>
  }
  readonly logins: {
    readonly start: (provider: AccountProvider, accountId: string) => Promise<AccountLoginJob>
    readonly startApiKey: (accountId: string, apiKey: string) => Promise<AccountLoginJob>
    readonly input: (jobId: string, text: string) => Promise<void>
    readonly cancel: (jobId: string) => Promise<void>
    readonly list: () => Promise<ReadonlyArray<AccountLoginJob>>
  }
  readonly usage: {
    readonly readClaude: (accountId?: string, options?: { force?: boolean }) => Promise<UsageRead>
    readonly claudeSnapshot: () => Promise<UsageSnapshot>
    readonly readCodex: (accountId?: string, options?: { force?: boolean }) => Promise<UsageRead>
    readonly codexSnapshot: () => Promise<UsageSnapshot>
    readonly readPi: (range: PiUsageRange) => Promise<PiUsageTotals>
  }
  readonly launchProfiles: {
    readonly list: () => Promise<LaunchProfilePreferences>
    readonly upsert: (profile: LaunchProfile) => Promise<LaunchProfilePreferences>
    readonly delete: (profileId: string) => Promise<LaunchProfilePreferences>
    readonly setGlobal: (
      family: LauncherFamily,
      profileId: string | null
    ) => Promise<LaunchProfilePreferences>
    readonly setWorkspace: (
      workspaceId: string,
      family: LauncherFamily,
      profileId: string | null
    ) => Promise<LaunchProfilePreferences>
  }
  /** The helpers' preference on that server (PRDCT-4330); both answer the list. */
  readonly helpers: {
    readonly list: () => Promise<ReadonlyArray<HelperPreference>>
    readonly set: (
      helperId: string,
      patch: HelperPreferencePatch
    ) => Promise<ReadonlyArray<HelperPreference>>
  }
  /** The integrations of that server (PRDCT-4410): the ElevenLabs key goes
   *  in once, as the redacted field's plain string, and comes back in no
   *  answer; every write answers the status. */
  readonly integrations: {
    readonly read: () => Promise<IntegrationsStatus>
    readonly setElevenLabsKey: (apiKey: string) => Promise<IntegrationsStatus>
    readonly checkElevenLabs: () => Promise<IntegrationsStatus>
    readonly removeElevenLabsKey: () => Promise<IntegrationsStatus>
    readonly setElevenLabsVoice: (
      voiceId: string,
      voiceName: string,
      modelId?: ElevenLabsModelId
    ) => Promise<IntegrationsStatus>
    readonly listElevenLabsVoices: () => Promise<ElevenLabsVoices>
  }
  readonly preferences: {
    readonly setAppIcon: (icon: AppIcon) => Promise<void>
  }
  /** The Antasphere account (PRDCT-3259): the status, and the four commands
   *  that move it. The sign-in's answer carries the browser handoff to this
   *  client; whoever calls it opens the browser and keeps the URL to itself. */
  readonly antasphere: {
    readonly status: () => Promise<AntasphereAccountStatus>
    readonly signIn: () => Promise<AntasphereSignInResult>
    /** Whether a handoff is the one issued for the login in flight, right now. */
    readonly confirmHandoff: (handoff: AntasphereHandoff) => Promise<boolean>
    readonly cancel: () => Promise<AntasphereAccountStatus>
    readonly signOut: () => Promise<AntasphereAccountStatus>
    readonly dismiss: () => Promise<AntasphereAccountStatus>
  }
  readonly workspaces: {
    readonly load: () => Promise<WorkspaceState>
    readonly updateRegistry: (
      workspaces: ReadonlyArray<Workspace>,
      origin?: string,
      base?: { revision: number; instance: string }
    ) => Promise<RegistryWriteResult>
    readonly updatePins: (
      scope: string | null,
      pins: ReadonlyArray<unknown>,
      origin?: string
    ) => Promise<PinsWriteResult>
    readonly setLastActive: (workspaceId: string | null) => Promise<void>
  }
  // ── Lane B (harness wave): provider connections ──
  /** The provider connections of that server (PRDCT-4426): the key goes out
   *  in `setKey` alone and comes back in nothing; every answer says `hasKey`. */
  readonly providerConnections: {
    readonly list: () => Promise<ReadonlyArray<ProviderConnection>>
    readonly add: (input: ProviderConnectionAddInput) => Promise<ProviderConnection>
    readonly rename: (id: string, label: string) => Promise<ProviderConnection>
    readonly remove: (id: string) => Promise<boolean>
    readonly setKey: (id: string, apiKey: string) => Promise<ProviderConnection>
  }
}

/** The settings group of the derived client (`call.ts`), so every payload
 *  below is checked against the endpoint it goes to: a GET's parameters as
 *  strings, the token as the plain string of the redacted field. */
export type SettingsGroup = DerivedClient['settings']
type SettingsCall = <A>(run: (group: SettingsGroup) => Effect.Effect<A, unknown>) => Promise<A>

/** A GET's parameters: only what is set, as the strings the wire carries. */
const usageParams = (
  accountId: string | undefined,
  options: { force?: boolean } | undefined
): { accountId?: string; force?: 'true' | 'false' } => ({
  ...(accountId !== undefined && { accountId }),
  ...(options?.force !== undefined && {
    force: options.force ? ('true' as const) : ('false' as const)
  })
})

const origin = (value: string | undefined): { origin?: string } =>
  value === undefined ? {} : { origin: value }

export function settingsClient(callApi: Call): SettingsClient {
  const call: SettingsCall = (run) => callApi((c) => run(c.settings))
  const done = (): undefined => undefined
  return {
    claudeAccounts: {
      list: () => call((g) => g.listClaudeAccounts({ payload: {} })),
      migrated: () => call((g) => g.listMigratedClaudeAccounts({ payload: {} })),
      add: (label) => call((g) => g.addClaudeAccount({ payload: { label } })),
      rename: (id, updates) => call((g) => g.renameClaudeAccount({ payload: { id, updates } })),
      reorder: (ids) => call((g) => g.reorderClaudeAccounts({ payload: { ids } })).then(done),
      remove: (id) => call((g) => g.removeClaudeAccount({ payload: { id } })),
      setToken: (id, token) => call((g) => g.setClaudeAccountToken({ payload: { id, token } })),
      clearToken: (id) => call((g) => g.clearClaudeAccountToken({ payload: { id } })).then(done)
    },
    codexAccounts: {
      list: () => call((g) => g.listCodexAccounts({ payload: {} })),
      add: (label, kind) =>
        call((g) => g.addCodexAccount({ payload: { label, ...(kind !== undefined && { kind }) } })),
      rename: (id, updates) => call((g) => g.renameCodexAccount({ payload: { id, updates } })),
      reorder: (ids) => call((g) => g.reorderCodexAccounts({ payload: { ids } })).then(done),
      remove: (id) => call((g) => g.removeCodexAccount({ payload: { id } })),
      clearCredential: (id) =>
        call((g) => g.clearCodexAccountCredential({ payload: { id } })).then(done)
    },
    logins: {
      start: (provider, accountId) =>
        call((g) => g.startAccountLogin({ payload: { provider, accountId } })),
      startApiKey: (accountId, apiKey) =>
        call((g) => g.startCodexApiKeyLogin({ payload: { accountId, apiKey } })),
      input: (jobId, text) =>
        call((g) => g.sendAccountLoginInput({ payload: { jobId, text } })).then(done),
      cancel: (jobId) => call((g) => g.cancelAccountLogin({ payload: { jobId } })).then(done),
      list: () => call((g) => g.listAccountLogins({ payload: {} }))
    },
    usage: {
      readClaude: (accountId, options) =>
        call((g) => g.readClaudeUsage({ payload: usageParams(accountId, options) })),
      claudeSnapshot: () => call((g) => g.readClaudeUsageSnapshot({ payload: {} })),
      readCodex: (accountId, options) =>
        call((g) => g.readCodexUsage({ payload: usageParams(accountId, options) })),
      codexSnapshot: () => call((g) => g.readCodexUsageSnapshot({ payload: {} })),
      readPi: (range) => call((g) => g.readPiUsage({ payload: { range } }))
    },
    launchProfiles: {
      list: () => call((g) => g.listLaunchProfiles({ payload: {} })),
      upsert: (profile) => call((g) => g.upsertLaunchProfile({ payload: { profile } })),
      delete: (profileId) => call((g) => g.deleteLaunchProfile({ payload: { profileId } })),
      setGlobal: (family, profileId) =>
        call((g) => g.setGlobalLaunchProfile({ payload: { family, profileId } })),
      setWorkspace: (workspaceId, family, profileId) =>
        call((g) => g.setWorkspaceLaunchProfile({ payload: { workspaceId, family, profileId } }))
    },
    helpers: {
      list: () =>
        helpersMissing(call((g) => g.listHelperPreferences({ payload: {} }))).then(
          (v) => v.helpers
        ),
      set: (helperId, patch) =>
        helpersMissing(
          call((g) => g.setHelperPreference({ payload: { helperId, ...patch } }))
        ).then((v) => v.helpers)
    },
    integrations: {
      read: () => integrationsMissing(call((g) => g.readIntegrations({ payload: {} }))),
      setElevenLabsKey: (apiKey) =>
        integrationsMissing(call((g) => g.setElevenLabsKey({ payload: { apiKey } }))),
      checkElevenLabs: () => integrationsMissing(call((g) => g.checkElevenLabs({ payload: {} }))),
      removeElevenLabsKey: () =>
        integrationsMissing(call((g) => g.removeElevenLabsKey({ payload: {} }))),
      setElevenLabsVoice: (voiceId, voiceName, modelId) =>
        integrationsMissing(
          call((g) =>
            g.setElevenLabsVoice({
              payload: { voiceId, voiceName, ...(modelId !== undefined && { modelId }) }
            })
          )
        ),
      listElevenLabsVoices: () =>
        integrationsMissing(call((g) => g.listElevenLabsVoices({ payload: {} })))
    },
    preferences: {
      setAppIcon: (icon) => call((g) => g.setAppIcon({ payload: { icon } })).then(done)
    },
    antasphere: {
      status: () => call((g) => g.readAntasphereAccount({ payload: {} })),
      signIn: () => call((g) => g.signInWithAntasphere({ payload: {} })),
      confirmHandoff: (handoff) =>
        call((g) => g.confirmAntasphereHandoff({ payload: handoff })).then((r) => r.current),
      cancel: () => call((g) => g.cancelAntasphereSignIn({ payload: {} })),
      signOut: () => call((g) => g.signOutOfAntasphere({ payload: {} })),
      dismiss: () => call((g) => g.dismissAntasphereFailure({ payload: {} }))
    },
    workspaces: {
      load: () => call((g) => g.loadWorkspaceState({ payload: {} })),
      updateRegistry: (workspaces, from, base) =>
        call((g) =>
          g.updateWorkspaceRegistry({
            payload: { workspaces, ...origin(from), ...(base ? { base } : {}) }
          })
        ),
      updatePins: (scope, pins, from) =>
        call((g) => g.updateWorkspacePins({ payload: { scope, pins, ...origin(from) } })),
      setLastActive: (workspaceId) =>
        call((g) => g.setLastActiveWorkspace({ payload: { workspaceId } })).then(done)
    },
    // ── Lane B (harness wave): provider connections ──
    providerConnections: {
      list: () =>
        providerConnectionsMissing(call((g) => g.listProviderConnections({ payload: {} }))),
      add: (input) =>
        providerConnectionsMissing(
          call((g) =>
            g.addProviderConnection({
              payload: {
                company: input.company,
                ...(input.label !== undefined && { label: input.label }),
                ...(input.baseUrl !== undefined && { baseUrl: input.baseUrl }),
                ...(input.wireFormat !== undefined && { wireFormat: input.wireFormat })
              }
            })
          )
        ),
      rename: (id, label) =>
        providerConnectionsMissing(
          call((g) => g.renameProviderConnection({ payload: { id, label } }))
        ),
      remove: (id) =>
        providerConnectionsMissing(call((g) => g.removeProviderConnection({ payload: { id } }))),
      setKey: (id, apiKey) =>
        providerConnectionsMissing(
          call((g) => g.setProviderConnectionKey({ payload: { id, apiKey } }))
        )
    }
  }
}
