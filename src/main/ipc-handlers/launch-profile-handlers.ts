import { ipcMain } from 'electron'
import { shellSettingsSource as settings } from '../settings/shell-source'
import type { LaunchProfile, LauncherFamily } from '../../shared/agent-launch'

const FAMILIES = new Set<LauncherFamily>(['claude', 'antigravity', 'codex', 'pi'])
function family(value: unknown): LauncherFamily {
  if (!FAMILIES.has(value as LauncherFamily)) throw new Error('Invalid launcher family')
  return value as LauncherFamily
}

/** The launch profiles over IPC, from the same settings source the server
 *  answers from. */
export function registerLaunchProfileHandlers(): void {
  ipcMain.handle('launch-profiles:list', () => settings.launchProfiles.list())
  ipcMain.handle('launch-profiles:upsert', (_event, profile: LaunchProfile) =>
    settings.launchProfiles.upsert(profile)
  )
  ipcMain.handle('launch-profiles:delete', (_event, profileId: string) =>
    settings.launchProfiles.delete(profileId)
  )
  ipcMain.handle(
    'launch-profiles:set-global',
    (_event, value: { family: unknown; profileId: string | null }) =>
      settings.launchProfiles.setGlobal(family(value.family), value.profileId)
  )
  ipcMain.handle(
    'launch-profiles:set-workspace',
    (_event, value: { workspaceId: string; family: unknown; profileId: string | null }) =>
      settings.launchProfiles.setWorkspace(value.workspaceId, family(value.family), value.profileId)
  )
}
