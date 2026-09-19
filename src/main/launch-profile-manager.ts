import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { runtimePluginRegistry } from './runtime-plugins/registry-runtime'
import {
  BUILT_IN_LAUNCH_PROFILES,
  DEFAULT_LAUNCH_PROFILE_PREFERENCES,
  resolveLaunchProfile,
  sanitizeLaunchProfilePreferences,
  type LaunchProfile,
  type LaunchProfilePreferences,
  type LauncherFamily
} from '../shared/agent-launch'

export class LaunchProfileManager {
  private preferences: LaunchProfilePreferences

  constructor(
    private readonly filePath: string,
    private readonly defaultProfiles: () => readonly LaunchProfile[] = () =>
      BUILT_IN_LAUNCH_PROFILES
  ) {
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
    return structuredClone({ ...this.preferences, defaultProfiles: [...this.defaultProfiles()] })
  }

  replace(raw: unknown): LaunchProfilePreferences {
    this.preferences = sanitizeLaunchProfilePreferences(raw)
    this.save()
    return this.getPreferences()
  }

  upsert(profile: LaunchProfile): LaunchProfilePreferences {
    if (this.defaultProfiles().some((item) => item.id === profile.id)) {
      throw new Error('Invalid launch profile: built-in profiles cannot be replaced')
    }
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
    profileId?: string | null,
    providerDefault?: { name: string; command: string[] }
  ): LaunchProfile {
    // A conversation's provider revision owns its default command. The settings
    // catalog describes current enabled providers, not a previously pinned one.
    const preferences = providerDefault
      ? {
          ...this.preferences,
          defaultProfiles: [
            {
              id: `builtin-${family}`,
              name: providerDefault.name,
              family,
              command: providerDefault.command,
              additionalArgs: [],
              builtIn: true
            }
          ]
        }
      : this.getPreferences()
    return resolveLaunchProfile(preferences, family, workspaceId, profileId)
  }

  private assertProfile(family: LauncherFamily, profileId: string): LaunchProfile {
    return resolveLaunchProfile(this.getPreferences(), family, null, profileId)
  }
}

export const launchProfileManager = new LaunchProfileManager(
  path.join(app.getPath('userData'), 'agent-launch-profiles.json'),
  () => [
    ...BUILT_IN_LAUNCH_PROFILES.filter((profile) => profile.family === 'antigravity'),
    ...runtimePluginRegistry()
      .providers()
      .map((provider) => ({
        id: `builtin-${provider.id}`,
        name: provider.name,
        family: provider.id,
        command: runtimePluginRegistry().resolveProvider(provider.id, provider.plugin).command,
        additionalArgs: [],
        builtIn: true
      }))
  ]
)
