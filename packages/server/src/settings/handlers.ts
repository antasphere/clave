/**
 * The settings domains on the server: every command and query of
 * `@clave/contract/settings`, answered from the settings source. Each
 * handler is one call on the port; the bus has validated the payload, and
 * the source's own `CapabilityUnavailable` is the one failure that reaches
 * the wire as declared (422). Anything else the source throws is a defect.
 *
 * The two secrets (`SetClaudeAccountToken`, `StartCodexApiKeyLogin`) arrive
 * redacted; they are opened here, handed to the source, and appear in no
 * answer: the success schemas carry none, and the contract's own test keeps
 * it so.
 */
import { Effect, Redacted } from 'effect'
import { CommandHandler, QueryHandler } from '@structure-ai/cqrs'
import {
  AddClaudeAccount,
  AddCodexAccount,
  CancelAccountLogin,
  CapabilityUnavailable,
  ClearClaudeAccountToken,
  ClearCodexAccountCredential,
  DeleteLaunchProfile,
  ListAccountLogins,
  ListClaudeAccounts,
  ListCodexAccounts,
  ListLaunchProfiles,
  ListMigratedClaudeAccounts,
  LoadWorkspaceState,
  ReadClaudeUsage,
  ReadClaudeUsageSnapshot,
  ReadCodexUsage,
  ReadCodexUsageSnapshot,
  ReadPiUsage,
  RemoveClaudeAccount,
  RemoveCodexAccount,
  RenameClaudeAccount,
  RenameCodexAccount,
  ReorderClaudeAccounts,
  ReorderCodexAccounts,
  SendAccountLoginInput,
  SetAppIcon,
  SetClaudeAccountToken,
  SetGlobalLaunchProfile,
  SetLastActiveWorkspace,
  SetWorkspaceLaunchProfile,
  SettingsRefused,
  StartAccountLogin,
  StartCodexApiKeyLogin,
  UpdateWorkspacePins,
  UpdateWorkspaceRegistry,
  UpsertLaunchProfile
} from '@clave/contract/settings'
import { SettingsSource, type SettingsSourceService } from './port'

/** A refusal the source threw: the contract's class, or any error carrying
 *  its tag and fields (a source loaded by a process that must not load Effect
 *  at boot throws a plain error shaped like it, `src/main/settings/source.ts`). */
const asUnavailable = (error: unknown): CapabilityUnavailable | null => {
  if (error instanceof CapabilityUnavailable) return error
  if (
    typeof error === 'object' &&
    error !== null &&
    (error as { _tag?: unknown })._tag === 'CapabilityUnavailable' &&
    typeof (error as { capability?: unknown }).capability === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    const { capability, message } = error as { capability: string; message: string }
    return new CapabilityUnavailable({ capability, message })
  }
  return null
}

/** A manager's refusal: the managers say no with a plain `Error` carrying
 *  the sentence for the person (`src/main/claude-accounts.ts`,
 *  `launch-profile-manager.ts`, `account-login.ts`). A subclass (a TypeError,
 *  a system error) is a defect, not a refusal. */
const asRefused = (error: unknown): SettingsRefused | null =>
  error instanceof Error && error.constructor === Error
    ? new SettingsRefused({ message: error.message })
    : null

/** One call on the source for a command: a `CapabilityUnavailable` it throws
 *  or rejects with, or a manager's refusal, is the declared failure; anything
 *  else is a defect. */
const call = <A>(
  run: (source: SettingsSourceService) => A | Promise<A>
): Effect.Effect<A, CapabilityUnavailable | SettingsRefused, SettingsSource> =>
  Effect.flatMap(SettingsSource, (source) =>
    Effect.tryPromise({
      try: async () => await run(source),
      catch: (error) => error
    }).pipe(
      Effect.catchAll((error) => {
        const failure = asUnavailable(error) ?? asRefused(error)
        return failure ? Effect.fail(failure) : Effect.die(error)
      })
    )
  )

/** The same for a command that declares the refusal alone: a capability
 *  refusal there is a defect, since the wire has no shape for it. */
const must = <A>(
  run: (source: SettingsSourceService) => A | Promise<A>
): Effect.Effect<A, SettingsRefused, SettingsSource> =>
  call(run).pipe(Effect.catchTag('CapabilityUnavailable', (error) => Effect.die(error)))

/** A query: nothing a manager refuses, so any error is a defect. */
const ask = <A>(
  run: (source: SettingsSourceService) => A | Promise<A>
): Effect.Effect<A, never, SettingsSource> => call(run).pipe(Effect.orDie)

export const settingsHandlers = [
  // Claude accounts
  QueryHandler.make(ListClaudeAccounts, () => ask((s) => s.claudeAccounts.list())),
  QueryHandler.make(ListMigratedClaudeAccounts, () => ask((s) => s.claudeAccounts.migrated())),
  CommandHandler.make(AddClaudeAccount, (p) => must((s) => s.claudeAccounts.add(p.label))),
  CommandHandler.make(RenameClaudeAccount, (p) =>
    must((s) => s.claudeAccounts.rename(p.id, p.updates.label))
  ),
  CommandHandler.make(ReorderClaudeAccounts, (p) => must((s) => s.claudeAccounts.reorder(p.ids))),
  CommandHandler.make(RemoveClaudeAccount, (p) => must((s) => s.claudeAccounts.remove(p.id))),
  CommandHandler.make(SetClaudeAccountToken, (p) =>
    must((s) => s.claudeAccounts.setToken(p.id, Redacted.value(p.token)))
  ),
  CommandHandler.make(ClearClaudeAccountToken, (p) =>
    must((s) => s.claudeAccounts.clearToken(p.id))
  ),
  // Codex accounts
  QueryHandler.make(ListCodexAccounts, () => ask((s) => s.codexAccounts.list())),
  CommandHandler.make(AddCodexAccount, (p) =>
    must((s) => s.codexAccounts.add(p.label, p.kind ?? 'chatgpt'))
  ),
  CommandHandler.make(RenameCodexAccount, (p) =>
    must((s) => s.codexAccounts.rename(p.id, p.updates.label))
  ),
  CommandHandler.make(ReorderCodexAccounts, (p) => must((s) => s.codexAccounts.reorder(p.ids))),
  CommandHandler.make(RemoveCodexAccount, (p) => must((s) => s.codexAccounts.remove(p.id))),
  CommandHandler.make(ClearCodexAccountCredential, (p) =>
    must((s) => s.codexAccounts.clearCredential(p.id))
  ),
  // Login jobs: the two that run a login may be refused by this server.
  CommandHandler.make(StartAccountLogin, (p) =>
    call((s) => s.logins.start(p.provider, p.accountId))
  ),
  CommandHandler.make(StartCodexApiKeyLogin, (p) =>
    call((s) => s.logins.startApiKey(p.accountId, Redacted.value(p.apiKey)))
  ),
  CommandHandler.make(SendAccountLoginInput, (p) => must((s) => s.logins.input(p.jobId, p.text))),
  CommandHandler.make(CancelAccountLogin, (p) => must((s) => s.logins.cancel(p.jobId))),
  QueryHandler.make(ListAccountLogins, () => ask((s) => s.logins.list())),
  // Usage
  QueryHandler.make(ReadClaudeUsage, (p) =>
    ask((s) => s.usage.readClaude(p.accountId, p.force === true))
  ),
  QueryHandler.make(ReadClaudeUsageSnapshot, () => ask((s) => s.usage.claudeSnapshot())),
  QueryHandler.make(ReadCodexUsage, (p) =>
    ask((s) => s.usage.readCodex(p.accountId, p.force === true))
  ),
  QueryHandler.make(ReadCodexUsageSnapshot, () => ask((s) => s.usage.codexSnapshot())),
  QueryHandler.make(ReadPiUsage, (p) => ask((s) => s.usage.readPi(p.range))),
  // Launch profiles
  QueryHandler.make(ListLaunchProfiles, () => ask((s) => s.launchProfiles.list())),
  CommandHandler.make(UpsertLaunchProfile, (p) => must((s) => s.launchProfiles.upsert(p.profile))),
  CommandHandler.make(DeleteLaunchProfile, (p) =>
    must((s) => s.launchProfiles.delete(p.profileId))
  ),
  CommandHandler.make(SetGlobalLaunchProfile, (p) =>
    must((s) => s.launchProfiles.setGlobal(p.family, p.profileId))
  ),
  CommandHandler.make(SetWorkspaceLaunchProfile, (p) =>
    must((s) => s.launchProfiles.setWorkspace(p.workspaceId, p.family, p.profileId))
  ),
  // Preferences: the icon needs a Dock, which this server may not have.
  CommandHandler.make(SetAppIcon, (p) => call((s) => s.preferences.setAppIcon(p.icon))),
  // Workspaces
  QueryHandler.make(LoadWorkspaceState, () => ask((s) => s.workspaces.load())),
  CommandHandler.make(UpdateWorkspaceRegistry, (p) =>
    must((s) => s.workspaces.updateRegistry(p.workspaces, p.origin))
  ),
  CommandHandler.make(UpdateWorkspacePins, (p) =>
    must((s) => s.workspaces.updatePins(p.scope, p.pins, p.origin))
  ),
  CommandHandler.make(SetLastActiveWorkspace, (p) =>
    must(async (s) => {
      await s.workspaces.setLastActive(p.workspaceId)
      return { ok: true as const }
    })
  )
] as const
