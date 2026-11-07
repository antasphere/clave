import { create } from 'zustand'
import {
  BUILT_IN_LAUNCH_PROFILES,
  DEFAULT_LAUNCH_PROFILE_PREFERENCES,
  resolveLaunchProfile,
  type LaunchProfile,
  type LaunchProfilePreferences,
  type LauncherFamily
} from '../../../../../../packages/shared/src/agent-launch'
import { chatDefaultFor } from '../../../../../../packages/shared/src/open-session-modes'

interface LaunchProfileState {
  preferences: LaunchProfilePreferences
  loaded: boolean
}

export const useLaunchProfileStore = create<LaunchProfileState>(() => ({
  preferences: DEFAULT_LAUNCH_PROFILE_PREFERENCES,
  loaded: false
}))

function replace(preferences: LaunchProfilePreferences): void {
  useLaunchProfileStore.setState({ preferences, loaded: true })
}

export async function loadLaunchProfiles(): Promise<void> {
  try {
    replace(await window.electronAPI.launchProfilesList())
  } catch {
    useLaunchProfileStore.setState({ loaded: true })
  }
}

export function profilesFor(family: LauncherFamily): LaunchProfile[] {
  const preferences = useLaunchProfileStore.getState().preferences
  return [...BUILT_IN_LAUNCH_PROFILES, ...preferences.customProfiles].filter(
    (profile) => profile.family === family
  )
}

export function selectedLaunchProfile(
  family: LauncherFamily,
  workspaceId: string | null,
  requestedId?: string
): LaunchProfile {
  return resolveLaunchProfile(
    useLaunchProfileStore.getState().preferences,
    family,
    workspaceId,
    requestedId
  )
}

/** The chat profile the launcher would open a family's chat on in a
 *  workspace, as `chatDefaultFor` reads the loaded preferences. */
export function selectedChatProfile(
  family: LauncherFamily,
  workspaceId: string | null | undefined
): string | undefined {
  return chatDefaultFor(useLaunchProfileStore.getState().preferences, family, workspaceId)
}

export async function saveLaunchProfile(profile: LaunchProfile): Promise<void> {
  replace(await window.electronAPI.launchProfileUpsert(profile))
}

export async function deleteLaunchProfile(profileId: string): Promise<void> {
  replace(await window.electronAPI.launchProfileDelete(profileId))
}

export async function setGlobalLaunchProfile(
  family: LauncherFamily,
  profileId: string | null
): Promise<void> {
  replace(await window.electronAPI.launchProfileSetGlobal(family, profileId))
}

export async function setWorkspaceLaunchProfile(
  workspaceId: string,
  family: LauncherFamily,
  profileId: string | null
): Promise<void> {
  replace(await window.electronAPI.launchProfileSetWorkspace(workspaceId, family, profileId))
}
