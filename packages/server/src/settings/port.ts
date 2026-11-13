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
 * defect. A secret enters through exactly four methods (`setToken`, the
 * token; `startApiKey`, the key; `integrations.setElevenLabsKey`, the
 * ElevenLabs key; and `providerConnections.setKey`, a provider key, lane B
 * of the harness wave), as the plain string the payload carried redacted, and is
 * held nowhere on this side of the port.
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
export type HelperPreference = typeof Settings.HelperPreferenceView.Type
export type HelperAccount = typeof Settings.HelperAccountView.Type
export interface HelperPreferencePatch {
  readonly enabled?: boolean
  readonly model?: string | null
  readonly account?: HelperAccount
}
export type IntegrationsStatus = typeof Settings.IntegrationsView.Type
export type ElevenLabsStatus = typeof Settings.ElevenLabsStatusView.Type
export type ElevenLabsModelId = typeof Settings.ElevenLabsModelId.Type
export type ElevenLabsVoices = typeof Settings.ElevenLabsVoicesView.Type
export type Workspace = typeof Settings.WorkspaceView.Type
export type WorkspaceState = typeof Settings.WorkspaceStateView.Type
export type WorkspaceStamp = typeof Settings.WorkspaceStamp.Type
export type RegistryWriteResult = typeof Settings.UpdateWorkspaceRegistry.success.Type
export type PinsWriteResult = typeof Settings.UpdateWorkspacePins.success.Type
export type AntasphereAccountStatus = typeof Settings.AntasphereAccountStatusView.Type
export type AntasphereSignInResult = typeof Settings.SignInWithAntasphere.success.Type
export type AntasphereHandoff = typeof Settings.AntasphereHandoffView.Type
export type SettingsEvent = Settings.SettingsEvent
// ── Lane B (harness wave): provider connections ──
export type ProviderConnection = typeof Settings.ProviderConnectionView.Type
export type ProviderCompanyId = typeof Settings.ProviderCompanyId.Type
export type ProviderWireFormat = typeof Settings.ProviderWireFormat.Type
export interface ProviderConnectionAddInput {
  readonly company: ProviderCompanyId
  readonly label?: string
  readonly baseUrl?: string
  readonly wireFormat?: ProviderWireFormat
}
// Lane C of the harness wave (PRDCT-4496): the models catalogue
export type ModelsCatalogView = typeof Settings.ModelsCatalogView.Type
// Lane C of the harness wave (PRDCT-4496): a connection's usage line
export type ProviderUsageLineView = typeof Settings.ProviderUsageLineView.Type

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
  /** The helpers' preference on this host (PRDCT-4330): every declared
   *  helper with its switch, model and account; a write answers the list. */
  readonly helpers: {
    readonly list: () => Awaitable<ReadonlyArray<HelperPreference>>
    readonly set: (
      helperId: string,
      patch: HelperPreferencePatch
    ) => Awaitable<ReadonlyArray<HelperPreference>>
  }
  /** The integrations of this host (PRDCT-4410): the ElevenLabs key sealed
   *  by the host's secret port, its account check, and the voice and model
   *  the agents speak with. Every write answers the status; none carries the
   *  key. A host with none behind it answers `CapabilityUnavailable`. */
  readonly integrations: {
    readonly read: () => Awaitable<IntegrationsStatus>
    readonly setElevenLabsKey: (apiKey: string) => Awaitable<IntegrationsStatus>
    readonly checkElevenLabs: () => Awaitable<IntegrationsStatus>
    readonly removeElevenLabsKey: () => Awaitable<IntegrationsStatus>
    readonly setElevenLabsVoice: (
      voiceId: string,
      voiceName: string,
      modelId: ElevenLabsModelId | undefined
    ) => Awaitable<IntegrationsStatus>
    readonly listElevenLabsVoices: () => Awaitable<ElevenLabsVoices>
  }
  readonly preferences: {
    readonly setAppIcon: (icon: AppIcon) => Awaitable<void>
  }
  /** The Antasphere account (PRDCT-3259): the login the server owns. A
   *  server with no login manager behind it answers `CapabilityUnavailable`
   *  on every one of these, the status read included: nothing local may
   *  stand in for it. */
  readonly antasphere: {
    readonly status: () => Awaitable<AntasphereAccountStatus>
    /** The status once the page is built, and the handoff for the caller alone. */
    readonly signIn: () => Awaitable<AntasphereSignInResult>
    /** Whether the handoff is the one issued for the login in flight, now. A read. */
    readonly confirmHandoff: (handoff: AntasphereHandoff) => Awaitable<boolean>
    readonly cancel: () => Awaitable<AntasphereAccountStatus>
    readonly signOut: () => Awaitable<AntasphereAccountStatus>
    readonly dismiss: () => Awaitable<AntasphereAccountStatus>
  }
  readonly workspaces: {
    readonly load: () => Awaitable<WorkspaceState>
    /** `origin` is the writer's window key, carried back on the change event;
     *  `base`, when given, is the stamp the write was made against. */
    readonly updateRegistry: (
      workspaces: ReadonlyArray<Workspace>,
      origin: string | undefined,
      base?: WorkspaceStamp
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
  // ── Lane B (harness wave): provider connections ──
  /** The provider connections of this host (PRDCT-4426): a key enters
   *  through `setKey` alone, sealed by the host's secret port; every answer
   *  says `hasKey` and never carries the key. */
  readonly providerConnections: {
    readonly list: () => Awaitable<ReadonlyArray<ProviderConnection>>
    readonly add: (input: ProviderConnectionAddInput) => Awaitable<ProviderConnection>
    /** Refuses (a plain Error) when the connection is unknown. */
    readonly rename: (id: string, label: string) => Awaitable<ProviderConnection>
    readonly remove: (id: string) => Awaitable<boolean>
    /** Stores the key sealed; the view returned says hasKey and never carries the key. */
    readonly setKey: (id: string, apiKey: string) => Awaitable<ProviderConnection>
  }
  // Lane C of the harness wave (PRDCT-4496): the models catalogue
  /** The models catalogue of this host: models.dev read and cached a day, the
   *  providers of those ids in their order (all when none is named), fetched
   *  again first with `force`. A host with none answers `CapabilityUnavailable`. */
  readonly modelsCatalog: {
    readonly read: (input: {
      readonly providerIds?: ReadonlyArray<string>
      readonly force?: boolean
    }) => Awaitable<ModelsCatalogView>
  }
  // Lane C of the harness wave (PRDCT-4496): a connection's usage line
  /** The usage line of that stored provider connection on this host, read
   *  again first with `force`; a connection it does not know is the unknown
   *  line. A host with no connections answers `CapabilityUnavailable`. */
  readonly providerUsage: {
    readonly read: (input: {
      readonly connectionId: string
      readonly force?: boolean
    }) => Awaitable<ProviderUsageLineView>
  }
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
    helpers: { list: refuse('helpers'), set: refuse('helpers') },
    integrations: {
      read: refuse('integrations'),
      setElevenLabsKey: refuse('integrations'),
      checkElevenLabs: refuse('integrations'),
      removeElevenLabsKey: refuse('integrations'),
      setElevenLabsVoice: refuse('integrations'),
      listElevenLabsVoices: refuse('integrations')
    },
    preferences: { setAppIcon: refuse('appIcon') },
    antasphere: {
      status: refuse('antasphereAccount'),
      signIn: refuse('antasphereAccount'),
      confirmHandoff: refuse('antasphereAccount'),
      cancel: refuse('antasphereAccount'),
      signOut: refuse('antasphereAccount'),
      dismiss: refuse('antasphereAccount')
    },
    workspaces: {
      load: refuse('workspaces'),
      updateRegistry: refuse('workspaces'),
      updatePins: refuse('workspaces'),
      setLastActive: refuse('workspaces')
    },
    subscribe: () => () => {},
    // ── Lane B (harness wave): provider connections ──
    providerConnections: {
      list: refuse('providerConnections'),
      add: refuse('providerConnections'),
      rename: refuse('providerConnections'),
      remove: refuse('providerConnections'),
      setKey: refuse('providerConnections')
    },
    // Lane C of the harness wave (PRDCT-4496): the models catalogue
    modelsCatalog: { read: refuse('modelsCatalog') },
    // Lane C of the harness wave (PRDCT-4496): a connection's usage line
    providerUsage: { read: refuse('providerUsage') }
  }
}
