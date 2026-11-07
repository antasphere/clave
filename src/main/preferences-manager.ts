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
  /**
   * The first-run walk (`onboarding.ts`): `pending` until it is finished or
   * skipped, then `done`. Decided once, on the first read, and written at
   * once when it is a first run: a machine where Clave has already
   * left its files was installed before the walk existed, so it is `done`
   * and an upgrade never shows the walk; only a data directory with none of
   * them is a first install.
   */
  onboarding: 'pending' | 'done'
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
  chatView: null,
  onboarding: 'pending'
}

/** The files an install of Clave leaves behind once it has run: any of them
 *  means this is not a first launch. */
const EARLIER_RUN_FILES = ['clave-preferences.json', 'claude-accounts.json', 'clave-server.json']

export class PreferencesManager {
  private cache: Preferences | null = null

  constructor(private readonly ports: SettingsPorts = lazySettingsPorts) {}

  private load(): Preferences {
    if (this.cache) return this.cache
    const storage = this.ports.storage
    const raw = readJson(storage, PREFERENCES_FILE)
    const stored =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Partial<Preferences>) : null
    this.cache = { ...DEFAULTS, ...(stored ?? {}) }
    if (stored?.onboarding !== 'pending' && stored?.onboarding !== 'done') {
      const firstRun = !stored && EARLIER_RUN_FILES.every((name) => storage.read(name) === null)
      this.cache.onboarding = firstRun ? 'pending' : 'done'
      // Written at once: a first run quit before anything else saved would
      // otherwise leave only the other managers' files behind, and the next
      // launch would read them as an earlier install and skip the walk.
      if (firstRun) this.save()
    }
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
