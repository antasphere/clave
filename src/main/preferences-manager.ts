import { lazySettingsPorts, type SettingsPorts } from './ports/registry'
import { readJson, writeJson } from './ports/storage'

export type AppIcon = 'dark' | 'light' | 'claude'

export interface Preferences {
  activeSkinId: string | null
  appIcon: AppIcon
  telemetryEnabled: boolean
  telemetryInstallId: string | null
  telemetryLastPingAt: string | null
  telemetryNoticeShown: boolean
  feedbackPromptCollapsed: boolean
  missionControlOverlayEnabled: boolean
  /**
   * "Receive pre-release builds". Off by default, and off it must stay for
   * anyone who did not ask: a stable install must never be offered a beta.
   * Applied to electron-updater by `auto-updater.ts` (`allowPrerelease`, and
   * `allowDowngrade` for the way back).
   */
  prereleaseUpdates: boolean
  /**
   * Keep the agent CLIs on their latest release on their own (on by default);
   * off, Clave only says an upgrade exists (`agent-updates/`).
   */
  agentAutoUpdate: boolean
  /**
   * The model the reader last picked in a chat composer, by chat adapter id.
   * A fresh chat that names no model starts on it (`sessions/chat-model-default.ts`).
   */
  chatModels: Record<string, string>
  /**
   * The reasoning effort the reader last picked in a chat composer, per chat
   * adapter. A fresh chat starts on it (`sessions/chat-model-default.ts`);
   * the adapter drops it for a model that does not take it.
   */
  chatEfforts: Record<string, string>
  /**
   * The view the reader last picked in a chat pane (`<pluginId>/<viewId>`).
   * A fresh chat opens in it (`sessions/chat-view-default.ts`).
   */
  chatView: string | null
}

const PREFERENCES_FILE = 'preferences.json'

const DEFAULTS: Preferences = {
  activeSkinId: null,
  appIcon: 'dark',
  telemetryEnabled: true,
  telemetryInstallId: null,
  telemetryLastPingAt: null,
  telemetryNoticeShown: false,
  feedbackPromptCollapsed: false,
  missionControlOverlayEnabled: true,
  prereleaseUpdates: false,
  agentAutoUpdate: true,
  chatModels: {},
  chatEfforts: {},
  chatView: null
}

export class PreferencesManager {
  private cache: Preferences | null = null

  constructor(private readonly ports: SettingsPorts = lazySettingsPorts) {}

  private load(): Preferences {
    if (this.cache) return this.cache
    const raw = readJson(this.ports.storage, PREFERENCES_FILE)
    this.cache =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? { ...DEFAULTS, ...(raw as Partial<Preferences>) }
        : { ...DEFAULTS }
    return this.cache
  }

  private save(): void {
    writeJson(this.ports.storage, PREFERENCES_FILE, this.cache)
  }

  get<K extends keyof Preferences>(key: K): Preferences[K] {
    return this.load()[key]
  }

  set<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
    this.load()[key] = value
    this.save()
  }
}

export const preferencesManager = new PreferencesManager()
