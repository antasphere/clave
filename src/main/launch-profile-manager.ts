import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import {
  DEFAULT_LAUNCH_PROFILE_PREFERENCES,
  chatProfileSource,
  resolveLaunchProfile,
  sanitizeLaunchProfilePreferences,
  type LaunchProfile,
  type LaunchProfilePreferences,
  type LauncherFamily
} from '../shared/agent-launch'

import { sessionManager } from './sessions/session-manager'
import { pluginAdapterProfiles, unavailablePluginAdapter } from './sessions/plugin-adapters'

/** An events profile names its adapter and, optionally, the view its sessions
 *  open in (`<pluginId>/<viewId>`). Absent means the host picks the first view
 *  that renders the transport, exactly as before profiles could name one. */
export type EventsLaunchProfile = LaunchProfile & { adapterId: string; viewId?: string }
/** Any family with two built-in profiles renders a submenu (terminal + chat), including Claude and Codex. */
const CHAT_PROFILES: EventsLaunchProfile[] = [
  {
    id: 'claude-chat',
    name: 'Claude (chat)',
    family: 'claude',
    command: ['claude'],
    additionalArgs: [],
    adapterId: 'claude-chat',
    viewId: 'clave.chat-view/chat',
    builtIn: true
  },
  {
    id: 'codex-chat',
    name: 'Codex (chat)',
    family: 'codex',
    command: ['codex'],
    additionalArgs: [],
    adapterId: 'codex-chat',
    viewId: 'clave.chat-view/chat',
    builtIn: true
  }
]
/**
 * A plugin's adapter becomes an ordinary events profile: the manifest names it
 * and supplies the command, and the host puts it beside Claude (chat) and
 * Codex (chat). Plugin providers have no launcher family of their own, so they
 * join the Claude one, as the echo development fixture already does.
 */
function pluginProfiles(): EventsLaunchProfile[] {
  return pluginAdapterProfiles().map((profile) => ({
    id: profile.id,
    name: profile.name,
    family: 'claude',
    command: [...profile.command],
    additionalArgs: [],
    adapterId: profile.id
  }))
}

/**
 * Resolves a launch id to its events profile, INCLUDING a disabled plugin's.
 * A disabled plugin must not silently launch a shell instead of its provider:
 * the spawn resolves the adapter, which then refuses the launch by name.
 */
export function eventsProfile(id?: string | null): EventsLaunchProfile | undefined {
  const source = chatProfileSource(id)
  if (source) {
    const template = CHAT_PROFILES.find((p) => p.family === source.family)!
    return { ...template, id: id!, sourceProfileId: source.id }
  }
  return CHAT_PROFILES.find((p) => p.id === id) ?? pluginProfiles().find((p) => p.id === id)
}

/** The events profiles the launcher offers: built-ins with a live adapter, plugins that are enabled. */
function offeredChatProfiles(customProfiles: LaunchProfile[] = []): EventsLaunchProfile[] {
  const enabled = new Set(
    pluginAdapterProfiles()
      .filter((profile) => profile.enabled)
      .map((profile) => profile.id)
  )
  const builtIns = CHAT_PROFILES.filter(
    (p) =>
      (p.id !== 'claude-chat' || process.platform !== 'win32') &&
      sessionManager.getAdapter(p.adapterId)
  )
  return [
    ...builtIns,
    ...customProfiles.flatMap((profile): EventsLaunchProfile[] => {
      const template = builtIns.find((p) => p.family === profile.family)
      if (
        !template ||
        profile.builtIn ||
        eventsProfile(profile.id) ||
        profile.id === 'dev-echo-adapter'
      )
        return []
      return [
        {
          ...profile,
          id: `chat:${profile.family}:${profile.id}`,
          name: `${profile.name} (chat)`,
          sourceProfileId: profile.id,
          adapterId: template.adapterId,
          viewId: template.viewId
        }
      ]
    }),
    ...pluginProfiles().filter((p) => enabled.has(p.id))
  ]
}

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
      (profile) => profile.id !== 'dev-echo-adapter' && !eventsProfile(profile.id)
    )
    if (echoEnabled) preferences.customProfiles.push(DEV_ECHO_PROFILE)
    preferences.customProfiles.push(...offeredChatProfiles(preferences.customProfiles))
    return preferences
  }

  replace(raw: unknown): LaunchProfilePreferences {
    this.preferences = sanitizeLaunchProfilePreferences(raw)
    this.save()
    return this.getPreferences()
  }

  upsert(profile: LaunchProfile): LaunchProfilePreferences {
    if (eventsProfile(profile.id)) throw new Error('Reserved events profile')
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
    const belongsToProfile = (id: string): boolean =>
      id === profileId || chatProfileSource(id)?.id === profileId
    const customProfiles = this.preferences.customProfiles.filter(
      (profile) => profile.id !== profileId
    )
    const globalDefaults = Object.fromEntries(
      Object.entries(this.preferences.globalDefaults).filter(([, id]) => !belongsToProfile(id))
    ) as LaunchProfilePreferences['globalDefaults']
    const workspaceOverrides = Object.fromEntries(
      Object.entries(this.preferences.workspaceOverrides).map(([workspaceId, defaults]) => [
        workspaceId,
        Object.fromEntries(Object.entries(defaults).filter(([, id]) => !belongsToProfile(id)))
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
      (profile) => profile.id !== 'dev-echo-adapter' && !eventsProfile(profile.id)
    )
    if (echoEnabled) customProfiles.push(DEV_ECHO_PROFILE)
    customProfiles.push(...offeredChatProfiles(customProfiles))
    const resolved = resolveLaunchProfile(
      { ...this.preferences, customProfiles },
      family,
      workspaceId,
      profileId
    )
    // A launch that asked for a plugin's agent must never quietly become a
    // terminal. The shared resolver falls back to the family's built-in when the
    // id it was given is not on offer, which is right for a deleted custom
    // profile and wrong for a plugin that is merely switched off: the stored
    // default is the common case, and it is not passed an explicit id.
    const asked = this.requestedId(family, workspaceId, profileId)
    if (asked && resolved.id !== asked) {
      if (chatProfileSource(asked))
        throw new Error('Chat launch profile no longer exists or is unavailable')
      const refusal = unavailablePluginAdapter(asked)
      if (refusal) throw new Error(refusal)
    }
    return resolved
  }

  /**
   * The profile id this call actually asked for: the first of explicit id,
   * workspace override, then global default that is PRESENT.
   *
   * The shared resolver instead falls through each one that fails to MATCH, and
   * the two differ in one narrow case: an explicit id that no longer resolves,
   * such as a deleted custom profile, passed while a switched-off plugin is the
   * stored default. Then this returns the explicit id, which is nobody's plugin,
   * the refusal below does not fire, and the built-in fallback answers — which is
   * the right answer for a deleted custom profile anyway. Reaching it needs both
   * halves at once, so it is left as it is rather than made more clever.
   */
  private requestedId(
    family: LauncherFamily,
    workspaceId?: string | null,
    profileId?: string | null
  ): string | undefined {
    return (
      profileId ??
      (workspaceId ? this.preferences.workspaceOverrides[workspaceId]?.[family] : undefined) ??
      this.preferences.globalDefaults[family]
    )
  }

  private assertProfile(family: LauncherFamily, profileId: string): LaunchProfile {
    if (isEchoLaunchProfile(profileId)) {
      if (family !== 'claude') throw new Error('Echo is a Claude-family development profile')
      return DEV_ECHO_PROFILE
    }
    const profile = this.resolve(family, null, profileId)
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
/** The development fixture may be told to name a default view, so the path from
 *  a profile to the session record is exercised by the end-to-end suite rather
 *  than left to inspection: `--dev-echo-view=<pluginId>/<viewId>`. */
const ECHO_VIEW_FLAG = '--dev-echo-view='
const echoDefaultView = process.argv
  .find((argument) => argument.startsWith(ECHO_VIEW_FLAG))
  ?.slice(ECHO_VIEW_FLAG.length)
/** The view a session launched from this profile opens in, when its profile
 *  names one; absent means the host picks the first view that renders it. */
export function defaultViewFor(profileId?: string | null): string | undefined {
  if (isEchoLaunchProfile(profileId)) return echoDefaultView || undefined
  return eventsProfile(profileId)?.viewId
}
