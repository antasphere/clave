import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import {
  DEFAULT_LAUNCH_PROFILE_PREFERENCES,
  resolveLaunchProfile,
  sanitizeLaunchProfilePreferences,
  type LaunchProfile,
  type LaunchProfilePreferences,
  type LauncherFamily
} from '../shared/agent-launch'

const echoEnabled = process.argv.includes('--dev-echo-adapter')

export class LaunchProfileManager {
  private preferences: LaunchProfilePreferences

  constructor(private readonly filePath: string) {
    this.preferences = this.load()
  }

  private load(): LaunchProfilePreferences {
    try {
      return sanitizeLaunchProfilePreferences(JSON.parse(fs.readFileSync(this.filePath, 'utf-8')))
    } catch {
      return { ...DEFAULT_LAUNCH_PROFILE_PREFERENCES }
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tempPath = `${this.filePath}.tmp`
    fs.writeFileSync(tempPath, JSON.stringify(this.preferences, null, 2), {
      encoding: 'utf-8',
      mode: 0o600
    })
    fs.renameSync(tempPath, this.filePath)
  }

  getPreferences(): LaunchProfilePreferences {
    const preferences = structuredClone(this.preferences)
    preferences.customProfiles = preferences.customProfiles.filter(
      (profile) => profile.id !== 'dev-echo-adapter'
    )
    if (echoEnabled) preferences.customProfiles.push(DEV_ECHO_PROFILE)
    return preferences
  }

  replace(raw: unknown): LaunchProfilePreferences {
    this.preferences = sanitizeLaunchProfilePreferences(raw)
    this.save()
    return this.getPreferences()
  }

  upsert(profile: LaunchProfile): LaunchProfilePreferences {
    if (profile.id === 'dev-echo-adapter') throw new Error('Reserved development profile')
    const parsed = sanitizeLaunchProfilePreferences({
      ...this.preferences,
      customProfiles: [
        ...this.preferences.customProfiles.filter((item) => item.id !== profile.id),
        profile
      ]
    })
    if (!parsed.customProfiles.some((item) => item.id === profile.id)) {
      throw new Error('Invalid launch profile')
    }
    this.preferences = parsed
    this.save()
    return this.getPreferences()
  }

  delete(profileId: string): LaunchProfilePreferences {
    const customProfiles = this.preferences.customProfiles.filter(
      (profile) => profile.id !== profileId
    )
    const globalDefaults = Object.fromEntries(
      Object.entries(this.preferences.globalDefaults).filter(([, id]) => id !== profileId)
    ) as LaunchProfilePreferences['globalDefaults']
    const workspaceOverrides = Object.fromEntries(
      Object.entries(this.preferences.workspaceOverrides).map(([workspaceId, defaults]) => [
        workspaceId,
        Object.fromEntries(Object.entries(defaults).filter(([, id]) => id !== profileId))
      ])
    )
    this.preferences = { version: 1, customProfiles, globalDefaults, workspaceOverrides }
    this.save()
    return this.getPreferences()
  }

  setGlobalDefault(family: LauncherFamily, profileId: string | null): LaunchProfilePreferences {
    const globalDefaults = { ...this.preferences.globalDefaults }
    if (profileId) globalDefaults[family] = this.assertProfile(family, profileId).id
    else delete globalDefaults[family]
    this.preferences = { ...this.preferences, globalDefaults }
    this.save()
    return this.getPreferences()
  }

  setWorkspaceDefault(
    workspaceId: string,
    family: LauncherFamily,
    profileId: string | null
  ): LaunchProfilePreferences {
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(workspaceId)) throw new Error('Invalid workspace id')
    const defaults = { ...(this.preferences.workspaceOverrides[workspaceId] ?? {}) }
    if (profileId) defaults[family] = this.assertProfile(family, profileId).id
    else delete defaults[family]
    this.preferences = {
      ...this.preferences,
      workspaceOverrides: { ...this.preferences.workspaceOverrides, [workspaceId]: defaults }
    }
    this.save()
    return this.getPreferences()
  }

  resolve(
    family: LauncherFamily,
    workspaceId?: string | null,
    profileId?: string | null
  ): LaunchProfile {
    if (isEchoLaunchProfile(profileId)) return DEV_ECHO_PROFILE
    const customProfiles = this.preferences.customProfiles.filter(
      (profile) => profile.id !== 'dev-echo-adapter'
    )
    if (echoEnabled) customProfiles.push(DEV_ECHO_PROFILE)
    return resolveLaunchProfile(
      { ...this.preferences, customProfiles },
      family,
      workspaceId,
      profileId
    )
  }

  private assertProfile(family: LauncherFamily, profileId: string): LaunchProfile {
    if (isEchoLaunchProfile(profileId) && family === 'claude') return DEV_ECHO_PROFILE
    const profile = resolveLaunchProfile(this.preferences, family, null, profileId)
    if (profile.id !== profileId) throw new Error('Unknown launch profile')
    return profile
  }
}

export const launchProfileManager = new LaunchProfileManager(
  path.join(app.getPath('userData'), 'agent-launch-profiles.json')
)

/** Development fixture exposed through the existing profile picker only. */
const DEV_ECHO_PROFILE: LaunchProfile = {
  id: 'dev-echo-adapter',
  name: 'Echo (development)',
  family: 'claude',
  command: ['echo'],
  additionalArgs: []
}
export function isEchoLaunchProfile(id?: string | null): boolean {
  return id === 'dev-echo-adapter' && echoEnabled
}
