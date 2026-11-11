/**
 * The launch settings (PRDCT-4423, PRDCT-4424, PRDCT-4425): the interaction
 * mode and the per-harness settings, one record the renderer reads and
 * writes over IPC, kept in `preferences.json` through the typed
 * `PreferencesManager`. Every window hears a change.
 *
 * Also the one read of the remembered chat model (PRDCT-4420): the launcher
 * used to ask `preferences:get`, which answers from `clave-preferences.json`,
 * while `rememberChatModel` writes `preferences.json`, so the launch never
 * knew its model and the suggested account was judged on the shared caps
 * alone. The answer now comes from the manager that holds it.
 */
import { BrowserWindow, ipcMain } from 'electron'
import {
  isInteractionMode,
  sanitizeHarnessSettings,
  type HarnessSettingsById,
  type LaunchSettings
} from '../shared/harness'
import { preferencesManager } from './preferences-manager'
import { rememberedChatModel } from './sessions/chat-model-default'
import { migrateChatView } from './sessions/chat-view-default'

export const LAUNCH_SETTINGS_IPC = {
  get: 'launch-settings:get',
  set: 'launch-settings:set',
  changed: 'launch-settings:changed',
  rememberedModel: 'launch-settings:remembered-model'
} as const

export function getLaunchSettings(): LaunchSettings {
  // An old `chatView` becomes the interaction mode on the first read, once
  // (the migration clears it; verifier, F5: Settings showed Chat until a chat
  // opened). On a READ, never at registration: the handlers are registered
  // before the app is ready, and a preference read there runs on a store
  // the boot has not finished placing (round 2 of the e2e).
  migrateChatView()
  const mode = preferencesManager.get('interactionMode')
  return {
    interactionMode: isInteractionMode(mode) ? mode : 'chat',
    harnesses: sanitizeHarnessSettings(preferencesManager.get('harnessSettings'))
  }
}

/** A partial write: the mode when given, and for each harness named the
 *  settings given, a harness's missing field left as it was, an explicit
 *  `null` field cleared. Returns the record as stored. */
export function setLaunchSettings(patch: {
  interactionMode?: unknown
  harnesses?: Record<string, { preferredModel?: unknown; permissionDefault?: unknown }>
}): LaunchSettings {
  if (patch.interactionMode !== undefined) {
    if (!isInteractionMode(patch.interactionMode)) throw new Error('Unknown interaction mode')
    preferencesManager.set('interactionMode', patch.interactionMode)
  }
  if (patch.harnesses && typeof patch.harnesses === 'object') {
    const current = sanitizeHarnessSettings(preferencesManager.get('harnessSettings'))
    const merged: Record<string, Record<string, unknown>> = {
      ...(current as Record<string, Record<string, unknown>>)
    }
    for (const [id, value] of Object.entries(patch.harnesses)) {
      if (!value || typeof value !== 'object') continue
      const next: Record<string, unknown> = { ...(merged[id] ?? {}) }
      for (const key of ['preferredModel', 'permissionDefault'] as const) {
        if (!(key in value)) continue
        if (value[key] === null || value[key] === undefined || value[key] === '') delete next[key]
        else next[key] = value[key]
      }
      merged[id] = next
    }
    const clean: HarnessSettingsById = sanitizeHarnessSettings(merged)
    preferencesManager.set('harnessSettings', clean)
  }
  const settings = getLaunchSettings()
  for (const win of BrowserWindow.getAllWindows())
    win.webContents.send(LAUNCH_SETTINGS_IPC.changed, settings)
  return settings
}

export function registerLaunchSettingsHandlers(): void {
  ipcMain.handle(LAUNCH_SETTINGS_IPC.get, () => getLaunchSettings())
  ipcMain.handle(LAUNCH_SETTINGS_IPC.set, (_event, patch: unknown) => {
    if (!patch || typeof patch !== 'object') throw new Error('Bad launch settings')
    return setLaunchSettings(patch as Parameters<typeof setLaunchSettings>[0])
  })
  ipcMain.handle(LAUNCH_SETTINGS_IPC.rememberedModel, (_event, adapterId: unknown) =>
    typeof adapterId === 'string' ? (rememberedChatModel(adapterId) ?? null) : null
  )
}
