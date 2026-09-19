import { ipcMain } from 'electron'
import { launchProfileManager } from '../launch-profile-manager'
import {
  isLauncherFamily,
  type LaunchProfile,
  type LauncherFamily
} from '../../shared/agent-launch'

function family(value: unknown): LauncherFamily {
  if (!isLauncherFamily(value)) throw new Error('Invalid launcher family')
  return value as LauncherFamily
}

export function registerLaunchProfileHandlers(): void {
  ipcMain.handle('launch-profiles:list', () => launchProfileManager.getPreferences())
  ipcMain.handle('launch-profiles:upsert', (_event, profile: LaunchProfile) =>
    launchProfileManager.upsert(profile)
  )
  ipcMain.handle('launch-profiles:delete', (_event, profileId: string) =>
    launchProfileManager.delete(profileId)
  )
  ipcMain.handle(
    'launch-profiles:set-global',
    (_event, value: { family: unknown; profileId: string | null }) =>
      launchProfileManager.setGlobalDefault(family(value.family), value.profileId)
  )
  ipcMain.handle(
    'launch-profiles:set-workspace',
    (_event, value: { workspaceId: string; family: unknown; profileId: string | null }) =>
      launchProfileManager.setWorkspaceDefault(
        value.workspaceId,
        family(value.family),
        value.profileId
      )
  )
}
