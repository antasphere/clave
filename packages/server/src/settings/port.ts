/**
 * The settings port: what the server needs from whoever holds the accounts,
 * the launch profiles, the preferences and the workspaces. The shell
 * implements it over its managers while the server runs inside the app
 * (`src/main/settings/source.ts`); the standalone entry implements it over
 * the same managers on the standalone ports, and says `CapabilityUnavailable`
 * for what it cannot carry. The handlers (`handlers.ts`) are the same either
 * way, which is the point of the port.
 *
 * Every method may answer a value or a promise; a thrown or rejected
 * `CapabilityUnavailable` is the one declared failure, anything else is a
 * defect. A secret enters through exactly two methods (`setToken`, the token;
 * `startApiKey`, the key), as the plain string the payload carried redacted,
 * and is held nowhere on this side of the port.
 */
import { Context, Layer } from 'effect'
import type * as Settings from '@clave/contract/settings'
import { CapabilityUnavailable } from '@clave/contract/settings'

export type Unsubscribe = () => void
export type Awaitable<T> = T | Promise<T>

export type ClaudeAccount = typeof Settings.ClaudeAccountView.Type
export type CodexAccount = typeof Settings.CodexAccountView.Type
export type CodexAccountKind = typeof Settings.CodexAccountKind.Type
export type AccountProvider = typeof Settings.AccountProvider.Type
export type AccountLoginJob = typeof Settings.AccountLoginJobView.Type
export type UsageRead = typeof Settings.UsageReadView.Type
export type UsageSnapshot = typeof Settings.UsageSnapshotView.Type
export type PiUsageRange = typeof Settings.PiUsageRange.Type
export type PiUsageTotals = typeof Settings.PiUsageTotalsView.Type
export type LaunchProfile = typeof Settings.LaunchProfileView.Type
export type LauncherFamily = typeof Settings.LauncherFamily.Type
export type LaunchProfilePreferences = typeof Settings.LaunchProfilePreferencesView.Type
export type AppIcon = typeof Settings.AppIconSchema.Type
export type Workspace = typeof Settings.WorkspaceView.Type
export type WorkspaceState = typeof Settings.WorkspaceStateView.Type
export type RegistryWriteResult = typeof Settings.UpdateWorkspaceRegistry.success.Type
export type PinsWriteResult = typeof Settings.UpdateWorkspacePins.success.Type
export type SettingsEvent = Settings.SettingsEvent

export interface SettingsSourceService {
  readonly claudeAccounts: {
    readonly list: () => Awaitable<ReadonlyArray<ClaudeAccount>>
    /** Accounts whose config-dir shape was dropped at boot: they need a login. */
    readonly migrated: () => Awaitable<ReadonlyArray<string>>
    readonly add: (label: string) => Awaitable<ClaudeAccount>
    readonly rename: (id: string, label: string | undefined) => Awaitable<ClaudeAccount | undefined>
    readonly reorder: (ids: ReadonlyArray<string>) => Awaitable<void>
    readonly remove: (id: string) => Awaitable<boolean>
    /** Stores the token and reads the account's limits with it, in one call. */
    readonly setToken: (id: string, token: string) => Awaitable<UsageRead>
    readonly clearToken: (id: string) => Awaitable<void>
  }
  readonly codexAccounts: {
    readonly list: () => Awaitable<ReadonlyArray<CodexAccount>>
    readonly add: (label: string, kind: CodexAccountKind) => Awaitable<CodexAccount>
    readonly rename: (id: string, label: string | undefined) => Awaitable<CodexAccount | undefined>
    readonly reorder: (ids: ReadonlyArray<string>) => Awaitable<void>
    readonly remove: (id: string) => Awaitable<boolean>
    readonly clearCredential: (id: string) => Awaitable<void>
  }
  readonly logins: {
    readonly start: (provider: AccountProvider, accountId: string) => Awaitable<AccountLoginJob>
    readonly startApiKey: (accountId: string, apiKey: string) => Awaitable<AccountLoginJob>
    readonly input: (jobId: string, text: string) => Awaitable<void>
    readonly cancel: (jobId: string) => Awaitable<void>
    readonly list: () => Awaitable<ReadonlyArray<AccountLoginJob>>
  }
  readonly usage: {
    /** One account's windows; the machine login when the id is undefined. */
    readonly readClaude: (accountId: string | undefined, force: boolean) => Awaitable<UsageRead>
    readonly claudeSnapshot: () => Awaitable<UsageSnapshot>
    readonly readCodex: (accountId: string | undefined, force: boolean) => Awaitable<UsageRead>
    readonly codexSnapshot: () => Awaitable<UsageSnapshot>
    readonly readPi: (range: PiUsageRange) => Awaitable<PiUsageTotals>
  }
  readonly launchProfiles: {
    readonly list: () => Awaitable<LaunchProfilePreferences>
    readonly upsert: (profile: LaunchProfile) => Awaitable<LaunchProfilePreferences>
    readonly delete: (profileId: string) => Awaitable<LaunchProfilePreferences>
    readonly setGlobal: (
      family: LauncherFamily,
      profileId: string | null
    ) => Awaitable<LaunchProfilePreferences>
    readonly setWorkspace: (
      workspaceId: string,
      family: LauncherFamily,
      profileId: string | null
    ) => Awaitable<LaunchProfilePreferences>
  }
  readonly preferences: {
    readonly setAppIcon: (icon: AppIcon) => Awaitable<void>
  }
  readonly workspaces: {
    readonly load: () => Awaitable<WorkspaceState>
    /** `origin` is the writer's window key, carried back on the change event. */
    readonly updateRegistry: (
      workspaces: ReadonlyArray<Workspace>,
      origin: string | undefined
    ) => Awaitable<RegistryWriteResult>
    readonly updatePins: (
      scope: string | null,
      pins: ReadonlyArray<unknown>,
      origin: string | undefined
    ) => Awaitable<PinsWriteResult>
    readonly setLastActive: (workspaceId: string | null) => Awaitable<void>
  }
  /** Every change of the settings as it happens, wherever it came from (a
   *  command, the poller, a login job landing its token): the server
   *  publishes each one to every attached client (`events.ts`). */
  readonly subscribe: (listener: (event: SettingsEvent) => void) => Unsubscribe
}

export class SettingsSource extends Context.Tag('@clave/server/SettingsSource')<
  SettingsSource,
  SettingsSourceService
>() {
  static layer(service: SettingsSourceService): Layer.Layer<SettingsSource> {
    return Layer.succeed(SettingsSource, service)
  }
  /** A server with no settings behind it: every call says so, loudly, so a
   *  server started without a source never looks like one with an empty
   *  settings store: the declared failure (422) where the command declares
   *  `CapabilityUnavailable`, a defect (500) everywhere else. The tests' default. */
  static readonly none: SettingsSourceService = noneSource()
}

/** The failure a server answers for a command it cannot carry here. */
export const unavailable = (capability: string, message: string): CapabilityUnavailable =>
  new CapabilityUnavailable({ capability, message })

function noneSource(): SettingsSourceService {
  const refuse = (capability: string) => (): never => {
    throw unavailable(capability, 'This server holds no settings.')
  }
  return {
    claudeAccounts: {
      list: refuse('claudeAccounts'),
      migrated: refuse('claudeAccounts'),
      add: refuse('claudeAccounts'),
      rename: refuse('claudeAccounts'),
      reorder: refuse('claudeAccounts'),
      remove: refuse('claudeAccounts'),
      setToken: refuse('claudeAccounts'),
      clearToken: refuse('claudeAccounts')
    },
    codexAccounts: {
      list: refuse('codexAccounts'),
      add: refuse('codexAccounts'),
      rename: refuse('codexAccounts'),
      reorder: refuse('codexAccounts'),
      remove: refuse('codexAccounts'),
      clearCredential: refuse('codexAccounts')
    },
    logins: {
      start: refuse('login'),
      startApiKey: refuse('login'),
      input: refuse('login'),
      cancel: refuse('login'),
      list: refuse('login')
    },
    usage: {
      readClaude: refuse('usage'),
      claudeSnapshot: refuse('usage'),
      readCodex: refuse('usage'),
      codexSnapshot: refuse('usage'),
      readPi: refuse('usage')
    },
    launchProfiles: {
      list: refuse('launchProfiles'),
      upsert: refuse('launchProfiles'),
      delete: refuse('launchProfiles'),
      setGlobal: refuse('launchProfiles'),
      setWorkspace: refuse('launchProfiles')
    },
    preferences: { setAppIcon: refuse('appIcon') },
    workspaces: {
      load: refuse('workspaces'),
      updateRegistry: refuse('workspaces'),
      updatePins: refuse('workspaces'),
      setLastActive: refuse('workspaces')
    },
    subscribe: () => () => {}
  }
}
