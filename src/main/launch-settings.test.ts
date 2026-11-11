import { beforeEach, describe, expect, it, vi } from 'vitest'

const prefs = new Map<string, unknown>()
const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      handlers.set(channel, fn)
    }
  },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('./preferences-manager', () => ({
  preferencesManager: {
    get: (key: string) => prefs.get(key),
    set: (key: string, value: unknown) => {
      prefs.set(key, value)
    }
  }
}))
import {
  LAUNCH_SETTINGS_IPC,
  getLaunchSettings,
  registerLaunchSettingsHandlers,
  setLaunchSettings
} from './launch-settings'
import { rememberChatModel } from './sessions/chat-model-default'

/**
 * The launch settings over IPC, and the one read of the remembered chat model
 * (PRDCT-4420): the launcher asks main, by adapter id, for what the composer
 * wrote through `rememberChatModel`, so the suggested connection is judged on
 * the model the chat will run. Until 11 November 2026 the renderer read a key
 * of its own preference file, which main never writes.
 */
describe('the launch settings', () => {
  beforeEach(() => {
    prefs.clear()
    prefs.set('interactionMode', 'chat')
    prefs.set('harnessSettings', {})
    prefs.set('chatModels', {})
    prefs.set('chatView', null)
    handlers.clear()
    registerLaunchSettingsHandlers()
  })
  it('answers the defaults, then what was set, a null field cleared, an unknown rung dropped', () => {
    expect(getLaunchSettings()).toEqual({ interactionMode: 'chat', harnesses: {} })
    expect(
      setLaunchSettings({
        interactionMode: 'folio',
        harnesses: { claude: { preferredModel: 'claude-fable-5-1[1m]', permissionDefault: 'auto' } }
      })
    ).toEqual({
      interactionMode: 'folio',
      harnesses: { claude: { preferredModel: 'claude-fable-5-1[1m]', permissionDefault: 'auto' } }
    })
    expect(
      setLaunchSettings({ harnesses: { claude: { permissionDefault: null } } }).harnesses
    ).toEqual({
      claude: { preferredModel: 'claude-fable-5-1[1m]' }
    })
    expect(
      setLaunchSettings({ harnesses: { codex: { permissionDefault: 'bypassPermissions' } } })
        .harnesses.codex
    ).toBeUndefined()
    expect(() => setLaunchSettings({ interactionMode: 'tv' })).toThrow('Unknown interaction mode')
  })
  it("the remembered-model handler answers the composer's pick by adapter, from the file main writes", async () => {
    rememberChatModel('claude-chat', 'claude-opus-5-5')
    const handler = handlers.get(LAUNCH_SETTINGS_IPC.rememberedModel)!
    expect(await handler({}, 'claude-chat')).toBe('claude-opus-5-5')
    expect(await handler({}, 'codex-chat')).toBeNull()
    expect(await handler({}, 42)).toBeNull()
    // The default alias is never a remembered model (PRDCT-4256).
    rememberChatModel('claude-chat', 'default')
    expect(await handler({}, 'claude-chat')).toBeNull()
  })
  it('migrates an old chatView into the mode once, at registration', () => {
    prefs.set('chatView', 'clave.chat-view/lab')
    registerLaunchSettingsHandlers()
    expect(getLaunchSettings().interactionMode).toBe('folio')
    expect(prefs.get('chatView')).toBeNull()
  })
})
