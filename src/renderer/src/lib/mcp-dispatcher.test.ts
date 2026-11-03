import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
/* The stores the dispatcher imports read localStorage and window as they load
   (the unit suite runs in node, with no DOM package), so both exist before the
   first import; the preload bridge is the one thing a test supplies. */
const globals = vi.hoisted(() => {
  const store = new Map<string, string>()
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size
    }
  }
  const window = { localStorage, electronAPI: {} as Record<string, unknown> }
  Object.assign(globalThis, { localStorage, window })
  return { window }
})
import { useLaunchProfileStore } from '../store/launch-profile-store'
import type { LaunchProfilePreferences } from '../../../shared/agent-launch'

/* The window road of clave_open_session: the renderer's own executor, the one
   a Mac with a saved server connection runs every open through (and the only
   one FileTree reaches). It is reached by no end-to-end spec (the per-tab
   endpoint serves the open in main unless a fleet server is saved), so the
   chat it picks is pinned here: the chat the launcher would open, the
   workspace's or global default's chat form, read from the Mac's own store. */

vi.mock('./switch-account', () => ({
  resolveAccountForSpawn: () => ({ id: 'default', label: 'Default' }),
  resolveAccountRef: () => ({ id: 'default', label: 'Default' }),
  claudeProfileSpawnFields: () => ({}),
  codexAccountSpawnFields: () => ({ codexAccountId: 'default', codexAccountLabel: 'Default' }),
  sessionAccountExhausted: () => false,
  switchSessionAccount: vi.fn()
}))
import { openSessionProgrammatically } from './mcp-dispatcher'

const codex = (id: string, name: string, flags: string[] = []) => ({
  id,
  name,
  family: 'codex' as const,
  command: ['codex', ...flags],
  additionalArgs: []
})
/** The preferences as the host lists them: the saved profiles and their
 *  chat forms, the built-in chat beside them. */
const preferences = (over: Partial<LaunchProfilePreferences>): LaunchProfilePreferences => ({
  version: 1,
  customProfiles: [
    codex('yolo', 'yolo codex', ['--yolo']),
    { ...codex('chat:codex:yolo', 'yolo codex (chat)', ['--yolo']), sourceProfileId: 'yolo' },
    { ...codex('codex-chat', 'Codex (chat)'), builtIn: true }
  ],
  globalDefaults: {},
  workspaceOverrides: {},
  ...over
})

let spawnSession: ReturnType<typeof vi.fn>
beforeEach(() => {
  spawnSession = vi.fn(async (cwd: string, options: Record<string, unknown>) => ({
    id: `tab-${spawnSession.mock.calls.length}`,
    cwd,
    folderName: 'repo',
    alive: true,
    launchProfileId: options.launchProfileId
  }))
  globals.window.electronAPI = { spawnSession }
})
afterEach(() => {
  globals.window.electronAPI = {}
  useLaunchProfileStore.setState({ preferences: preferences({}), loaded: true })
})

const spawned = (): Record<string, unknown> => spawnSession.mock.calls.at(-1)![1]

describe('clave_open_session on the window road', () => {
  it("opens a chat on the global default's chat form, the one the launcher would open", async () => {
    useLaunchProfileStore.setState({
      preferences: preferences({ globalDefaults: { codex: 'yolo' } }),
      loaded: true
    })
    await openSessionProgrammatically({ cwd: '/repo', mode: 'codex', chat: true })
    expect(spawned()).toMatchObject({
      codexMode: true,
      dangerousMode: false,
      launchProfileId: 'chat:codex:yolo'
    })
  })
  it('opens the built-in chat when nothing is set, and an explicit chat profile wins', async () => {
    useLaunchProfileStore.setState({ preferences: preferences({}), loaded: true })
    await openSessionProgrammatically({ cwd: '/repo', mode: 'codex', chat: true })
    expect(spawned()).toMatchObject({ launchProfileId: 'codex-chat' })
    useLaunchProfileStore.setState({
      preferences: preferences({ globalDefaults: { codex: 'yolo' } }),
      loaded: true
    })
    await openSessionProgrammatically({
      cwd: '/repo',
      mode: 'codex',
      chat: true,
      profile: 'codex-chat',
      dangerous: true
    })
    expect(spawned()).toMatchObject({ launchProfileId: 'codex-chat', dangerousMode: true })
  })
  it('refuses a terminal profile beside chat, and leaves a terminal open untouched by the chat rule', async () => {
    useLaunchProfileStore.setState({
      preferences: preferences({ globalDefaults: { codex: 'yolo' } }),
      loaded: true
    })
    await expect(
      openSessionProgrammatically({ cwd: '/repo', mode: 'codex', chat: true, profile: 'yolo' })
    ).rejects.toThrow(/drop profile/)
    await openSessionProgrammatically({ cwd: '/repo', mode: 'codex', profile: 'yolo' })
    expect(spawned()).toMatchObject({ launchProfileId: 'yolo', codexMode: true })
  })
})
