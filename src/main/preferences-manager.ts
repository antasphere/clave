import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

export type AppIcon = 'dark' | 'light' | 'claude'

interface Preferences {
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
}

const DEFAULTS: Preferences = {
  appIcon: 'dark',
  telemetryEnabled: true,
  telemetryInstallId: null,
  telemetryLastPingAt: null,
  telemetryNoticeShown: false,
  feedbackPromptCollapsed: false,
  missionControlOverlayEnabled: true,
  prereleaseUpdates: false
}

class PreferencesManager {
  private filePath: string
  private cache: Preferences

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'preferences.json')
    this.cache = this.load()
  }

  private load(): Preferences {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8')
      return { ...DEFAULTS, ...JSON.parse(raw) }
    } catch {
      return { ...DEFAULTS }
    }
  }

  private save(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), 'utf-8')
  }

  get<K extends keyof Preferences>(key: K): Preferences[K] {
    return this.cache[key]
  }

  set<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
    this.cache[key] = value
    this.save()
  }
}

export const preferencesManager = new PreferencesManager()
