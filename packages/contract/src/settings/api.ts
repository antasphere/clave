/**
 * The settings domains as one group of the HTTP API (`../api.ts` adds it to
 * `ClaveApi`): commands as POST endpoints, queries as GET endpoints, through
 * the framework's CQRS bridge, so the bus validates, authorizes and traces
 * every call whatever transport brought it. The paths name the resource;
 * every definition is the one the module files export.
 */
import { ApiGroup, HttpCqrs } from '@structure-ai/http'
import {
  AddClaudeAccount,
  AddCodexAccount,
  CancelAccountLogin,
  ClearClaudeAccountToken,
  ClearCodexAccountCredential,
  ListAccountLogins,
  ListClaudeAccounts,
  ListCodexAccounts,
  ListMigratedClaudeAccounts,
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
  SetClaudeAccountToken,
  StartAccountLogin,
  StartCodexApiKeyLogin
} from './accounts'
import {
  DeleteLaunchProfile,
  ListLaunchProfiles,
  SetGlobalLaunchProfile,
  SetWorkspaceLaunchProfile,
  UpsertLaunchProfile
} from './launch-profiles'
import { GetPreference, SetAppIcon, SetPreference } from './preferences'
import {
  LoadWorkspaceState,
  SetLastActiveWorkspace,
  UpdateWorkspacePins,
  UpdateWorkspaceRegistry
} from './workspaces'

export const settingsGroup = ApiGroup.make('settings')
  // Claude accounts
  .add(HttpCqrs.queryEndpoint('listClaudeAccounts', '/accounts/claude', ListClaudeAccounts))
  .add(
    HttpCqrs.queryEndpoint(
      'listMigratedClaudeAccounts',
      '/accounts/claude/migrated',
      ListMigratedClaudeAccounts
    )
  )
  .add(HttpCqrs.commandEndpoint('addClaudeAccount', '/accounts/claude', AddClaudeAccount))
  .add(
    HttpCqrs.commandEndpoint('renameClaudeAccount', '/accounts/claude/rename', RenameClaudeAccount)
  )
  .add(
    HttpCqrs.commandEndpoint(
      'reorderClaudeAccounts',
      '/accounts/claude/reorder',
      ReorderClaudeAccounts
    )
  )
  .add(
    HttpCqrs.commandEndpoint('removeClaudeAccount', '/accounts/claude/remove', RemoveClaudeAccount)
  )
  .add(
    HttpCqrs.commandEndpoint(
      'setClaudeAccountToken',
      '/accounts/claude/token',
      SetClaudeAccountToken
    )
  )
  .add(
    HttpCqrs.commandEndpoint(
      'clearClaudeAccountToken',
      '/accounts/claude/token/clear',
      ClearClaudeAccountToken
    )
  )
  // Codex accounts
  .add(HttpCqrs.queryEndpoint('listCodexAccounts', '/accounts/codex', ListCodexAccounts))
  .add(HttpCqrs.commandEndpoint('addCodexAccount', '/accounts/codex', AddCodexAccount))
  .add(HttpCqrs.commandEndpoint('renameCodexAccount', '/accounts/codex/rename', RenameCodexAccount))
  .add(
    HttpCqrs.commandEndpoint(
      'reorderCodexAccounts',
      '/accounts/codex/reorder',
      ReorderCodexAccounts
    )
  )
  .add(HttpCqrs.commandEndpoint('removeCodexAccount', '/accounts/codex/remove', RemoveCodexAccount))
  .add(
    HttpCqrs.commandEndpoint(
      'clearCodexAccountCredential',
      '/accounts/codex/credential/clear',
      ClearCodexAccountCredential
    )
  )
  // Login jobs
  .add(HttpCqrs.commandEndpoint('startAccountLogin', '/accounts/login', StartAccountLogin))
  .add(
    HttpCqrs.commandEndpoint(
      'startCodexApiKeyLogin',
      '/accounts/login/api-key',
      StartCodexApiKeyLogin
    )
  )
  .add(
    HttpCqrs.commandEndpoint(
      'sendAccountLoginInput',
      '/accounts/login/input',
      SendAccountLoginInput
    )
  )
  .add(HttpCqrs.commandEndpoint('cancelAccountLogin', '/accounts/login/cancel', CancelAccountLogin))
  .add(HttpCqrs.queryEndpoint('listAccountLogins', '/accounts/login', ListAccountLogins))
  // Usage
  .add(HttpCqrs.queryEndpoint('readClaudeUsage', '/usage/claude', ReadClaudeUsage))
  .add(
    HttpCqrs.queryEndpoint(
      'readClaudeUsageSnapshot',
      '/usage/claude/snapshot',
      ReadClaudeUsageSnapshot
    )
  )
  .add(HttpCqrs.queryEndpoint('readCodexUsage', '/usage/codex', ReadCodexUsage))
  .add(
    HttpCqrs.queryEndpoint(
      'readCodexUsageSnapshot',
      '/usage/codex/snapshot',
      ReadCodexUsageSnapshot
    )
  )
  .add(HttpCqrs.queryEndpoint('readPiUsage', '/usage/pi', ReadPiUsage))
  // Launch profiles
  .add(HttpCqrs.queryEndpoint('listLaunchProfiles', '/launch-profiles', ListLaunchProfiles))
  .add(HttpCqrs.commandEndpoint('upsertLaunchProfile', '/launch-profiles', UpsertLaunchProfile))
  .add(
    HttpCqrs.commandEndpoint('deleteLaunchProfile', '/launch-profiles/delete', DeleteLaunchProfile)
  )
  .add(
    HttpCqrs.commandEndpoint(
      'setGlobalLaunchProfile',
      '/launch-profiles/global',
      SetGlobalLaunchProfile
    )
  )
  .add(
    HttpCqrs.commandEndpoint(
      'setWorkspaceLaunchProfile',
      '/launch-profiles/workspace',
      SetWorkspaceLaunchProfile
    )
  )
  // Preferences
  .add(HttpCqrs.queryEndpoint('getPreference', '/preferences', GetPreference))
  .add(HttpCqrs.commandEndpoint('setPreference', '/preferences', SetPreference))
  .add(HttpCqrs.commandEndpoint('setAppIcon', '/preferences/app-icon', SetAppIcon))
  // Workspaces
  .add(HttpCqrs.queryEndpoint('loadWorkspaceState', '/workspaces', LoadWorkspaceState))
  .add(
    HttpCqrs.commandEndpoint(
      'updateWorkspaceRegistry',
      '/workspaces/registry',
      UpdateWorkspaceRegistry
    )
  )
  .add(HttpCqrs.commandEndpoint('updateWorkspacePins', '/workspaces/pins', UpdateWorkspacePins))
  .add(
    HttpCqrs.commandEndpoint(
      'setLastActiveWorkspace',
      '/workspaces/last-active',
      SetLastActiveWorkspace
    )
  )
