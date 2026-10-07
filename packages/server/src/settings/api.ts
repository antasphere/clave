/** The settings group of the HTTP API implemented, every endpoint of
 *  `@clave/contract/settings/api` through the CQRS bridge. */
import * as HttpApiBuilder from '@effect/platform/HttpApiBuilder'
import { HttpCqrs } from '@structure-ai/http'
import { ClaveApi } from '@clave/contract/api'
import * as S from '@clave/contract/settings'

export const SettingsLive = HttpApiBuilder.group(ClaveApi, 'settings', (handlers) =>
  handlers
    .handle('listClaudeAccounts', HttpCqrs.query(S.ListClaudeAccounts))
    .handle('listMigratedClaudeAccounts', HttpCqrs.query(S.ListMigratedClaudeAccounts))
    .handle('addClaudeAccount', HttpCqrs.command(S.AddClaudeAccount))
    .handle('renameClaudeAccount', HttpCqrs.command(S.RenameClaudeAccount))
    .handle('reorderClaudeAccounts', HttpCqrs.command(S.ReorderClaudeAccounts))
    .handle('removeClaudeAccount', HttpCqrs.command(S.RemoveClaudeAccount))
    .handle('setClaudeAccountToken', HttpCqrs.command(S.SetClaudeAccountToken))
    .handle('clearClaudeAccountToken', HttpCqrs.command(S.ClearClaudeAccountToken))
    .handle('listCodexAccounts', HttpCqrs.query(S.ListCodexAccounts))
    .handle('addCodexAccount', HttpCqrs.command(S.AddCodexAccount))
    .handle('renameCodexAccount', HttpCqrs.command(S.RenameCodexAccount))
    .handle('reorderCodexAccounts', HttpCqrs.command(S.ReorderCodexAccounts))
    .handle('removeCodexAccount', HttpCqrs.command(S.RemoveCodexAccount))
    .handle('clearCodexAccountCredential', HttpCqrs.command(S.ClearCodexAccountCredential))
    .handle('startAccountLogin', HttpCqrs.command(S.StartAccountLogin))
    .handle('startCodexApiKeyLogin', HttpCqrs.command(S.StartCodexApiKeyLogin))
    .handle('sendAccountLoginInput', HttpCqrs.command(S.SendAccountLoginInput))
    .handle('cancelAccountLogin', HttpCqrs.command(S.CancelAccountLogin))
    .handle('listAccountLogins', HttpCqrs.query(S.ListAccountLogins))
    .handle('readClaudeUsage', HttpCqrs.query(S.ReadClaudeUsage))
    .handle('readClaudeUsageSnapshot', HttpCqrs.query(S.ReadClaudeUsageSnapshot))
    .handle('readCodexUsage', HttpCqrs.query(S.ReadCodexUsage))
    .handle('readCodexUsageSnapshot', HttpCqrs.query(S.ReadCodexUsageSnapshot))
    .handle('readPiUsage', HttpCqrs.query(S.ReadPiUsage))
    .handle('listLaunchProfiles', HttpCqrs.query(S.ListLaunchProfiles))
    .handle('upsertLaunchProfile', HttpCqrs.command(S.UpsertLaunchProfile))
    .handle('deleteLaunchProfile', HttpCqrs.command(S.DeleteLaunchProfile))
    .handle('setGlobalLaunchProfile', HttpCqrs.command(S.SetGlobalLaunchProfile))
    .handle('setWorkspaceLaunchProfile', HttpCqrs.command(S.SetWorkspaceLaunchProfile))
    .handle('setAppIcon', HttpCqrs.command(S.SetAppIcon))
    .handle('loadWorkspaceState', HttpCqrs.query(S.LoadWorkspaceState))
    .handle('updateWorkspaceRegistry', HttpCqrs.command(S.UpdateWorkspaceRegistry))
    .handle('updateWorkspacePins', HttpCqrs.command(S.UpdateWorkspacePins))
    .handle('setLastActiveWorkspace', HttpCqrs.command(S.SetLastActiveWorkspace))
)
