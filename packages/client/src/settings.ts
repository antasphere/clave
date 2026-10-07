/**
 * The settings calls of the typed client, lane D's module: every command
 * and query of `@clave/contract/settings` as a promise, derived from the
 * shared API the way `api.ts` derives the sessions and the clients. The
 * token and the API key go out as the plain strings the wire carries (the
 * encoded side of the contract's redacted fields) and come back in nothing.
 */
import type { Effect } from 'effect'
import type * as S from '@clave/contract/settings'
import type { Call, DerivedClient } from './call'

export type ClaudeAccount = typeof S.ClaudeAccountView.Type
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
export type Workspace = typeof S.WorkspaceView.Type
export type WorkspaceState = typeof S.WorkspaceStateView.Type
export type RegistryWriteResult = typeof S.UpdateWorkspaceRegistry.success.Type
export type PinsWriteResult = typeof S.UpdateWorkspacePins.success.Type

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
  readonly preferences: {
    readonly setAppIcon: (icon: AppIcon) => Promise<void>
  }
  readonly workspaces: {
    readonly load: () => Promise<WorkspaceState>
    readonly updateRegistry: (
      workspaces: ReadonlyArray<Workspace>,
      origin?: string
    ) => Promise<RegistryWriteResult>
    readonly updatePins: (
      scope: string | null,
      pins: ReadonlyArray<unknown>,
      origin?: string
    ) => Promise<PinsWriteResult>
    readonly setLastActive: (workspaceId: string | null) => Promise<void>
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
    preferences: {
      setAppIcon: (icon) => call((g) => g.setAppIcon({ payload: { icon } })).then(done)
    },
    workspaces: {
      load: () => call((g) => g.loadWorkspaceState({ payload: {} })),
      updateRegistry: (workspaces, from) =>
        call((g) => g.updateWorkspaceRegistry({ payload: { workspaces, ...origin(from) } })),
      updatePins: (scope, pins, from) =>
        call((g) => g.updateWorkspacePins({ payload: { scope, pins, ...origin(from) } })),
      setLastActive: (workspaceId) =>
        call((g) => g.setLastActiveWorkspace({ payload: { workspaceId } })).then(done)
    }
  }
}
