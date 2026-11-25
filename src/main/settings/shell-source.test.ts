import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ServerLaunch } from '../server-boot'

/**
 * What the shell's settings source builds for the Antasphere account
 * (PRDCT-3259) follows the one launch decision (`server-launch.ts`): a
 * manager while the server runs in this process, none when the server runs
 * elsewhere, attached or the shell's own separate child. The managers around
 * it are stood in, since they capture Electron's paths at import; the
 * decision and the composition are the real ones.
 */
const launch = vi.hoisted(() => ({ current: { mode: 'in-process' } as ServerLaunch }))
const built = vi.hoisted(() => ({ managers: 0 }))
vi.mock('../server-launch', () => ({
  get serverLaunch() {
    return launch.current
  }
}))
vi.mock('../antasphere-account', () => ({
  AntasphereAccountManager: class {
    constructor() {
      built.managers += 1
    }
  }
}))
vi.mock('./source', () => ({
  settingsSourceFromManagers: (managers: unknown) => ({ managers })
}))
vi.mock('../claude-accounts', () => ({ claudeAccountsManager: {} }))
vi.mock('../codex-accounts', () => ({ codexAccountsManager: {} }))
vi.mock('../usage-manager', () => ({ usageManager: {} }))
vi.mock('../codex-usage', () => ({ codexUsageManager: {} }))
vi.mock('../antigravity-cli', () => ({ antigravityUsageManager: {} }))
vi.mock('../pi-usage', () => ({ piUsageManager: {} }))
vi.mock('../launch-profile-manager', () => ({ launchProfileManager: {} }))
vi.mock('../preferences-manager', () => ({ preferencesManager: {} }))
vi.mock('../workspace-manager', () => ({ workspaceManager: {} }))
vi.mock('../app-icon', () => ({ applyAppIcon: () => {} }))

async function load(mode: 'in-process' | 'attached' | 'separate'): Promise<{
  shellAntasphereAccount: unknown
  shellSettingsSource: { managers: { antasphere?: unknown } }
}> {
  vi.resetModules()
  built.managers = 0
  launch.current = mode === 'attached' ? { mode, url: 'http://127.0.0.1:1', token: 't' } : { mode }
  return (await import('./shell-source')) as never
}

afterEach(() => {
  launch.current = { mode: 'in-process' }
})

describe('the shell builds an Antasphere account manager only for the in-process server', () => {
  it('in-process: one manager, handed to the source', async () => {
    const m = await load('in-process')
    expect(built.managers).toBe(1)
    expect(m.shellAntasphereAccount).not.toBeNull()
    expect(m.shellSettingsSource.managers.antasphere).toBe(m.shellAntasphereAccount)
  })

  it('separate (the packaged default): no manager, nothing handed to the source', async () => {
    const m = await load('separate')
    expect(built.managers).toBe(0)
    expect(m.shellAntasphereAccount).toBeNull()
    expect('antasphere' in m.shellSettingsSource.managers).toBe(false)
  })

  it('attached: the same as separate', async () => {
    const m = await load('attached')
    expect(built.managers).toBe(0)
    expect(m.shellAntasphereAccount).toBeNull()
    expect('antasphere' in m.shellSettingsSource.managers).toBe(false)
  })
})

/**
 * The helpers (PRDCT-4330): main owns this Mac's preference and runs helpers
 * only while the server runs in its process. With a server behind the window
 * main keeps no preference, offers none on its IPC route, installs no source,
 * and never reaches the server for one.
 */
const asked = vi.hoisted(() => ({ client: 0 }))
vi.mock('../mcp/server-client', () => {
  asked.client += 1
  return { serverClient: { api: async () => ({}) } }
})

describe('main owns the helpers only when it is the server', () => {
  it('in-process: the runner reads main’s own store, written through the source', async () => {
    await load('in-process')
    const { installSettingsPorts, resetSettingsPorts } = await import('../ports')
    const { tempDataDir, electronTestPorts } = await import('../ports/testing')
    installSettingsPorts(electronTestPorts(tempDataDir('clave-shell-helpers-')))
    try {
      const prefs = await import('../helpers/preferences')
      const registry = await import('../helpers/registry')
      const m = (await import('./shell-source')) as unknown as {
        shellSettingsSource: { managers: { helpers?: unknown } }
      }
      expect(m.shellSettingsSource.managers.helpers).toBe(prefs.helperPreferences)
      prefs.helperPreferences.set('tab-title', { enabled: false, model: 'sonnet' })
      expect(registry.helperConfig(registry.helperById('tab-title')!)).toMatchObject({
        enabled: false,
        model: 'sonnet'
      })
    } finally {
      resetSettingsPorts()
    }
  })

  it.each(['separate', 'attached'] as const)(
    '%s: no preference in main, no source installed, the server never asked',
    async (mode) => {
      asked.client = 0
      const m = (await load(mode)) as unknown as {
        shellSettingsSource: { managers: { helpers?: unknown } }
      }
      expect('helpers' in m.shellSettingsSource.managers).toBe(false)
      const registry = await import('../helpers/registry')
      // A source answering "off" for everything would show through here.
      expect(registry.helperConfig(registry.helperById('tab-title')!)).toMatchObject({
        enabled: true,
        model: 'haiku'
      })
      expect(asked.client).toBe(0)
    }
  )
})

/**
 * The writing styles (PRDCT-5166) follow the helpers: main keeps this Mac's
 * styles and its spawns read them only while the server runs in its process.
 * With a server behind the window main keeps none and installs no source.
 */
describe('main owns the writing styles only when it is the server', () => {
  it('in-process: the store is handed to the source and is what a spawn reads', async () => {
    await load('in-process')
    const { installSettingsPorts, resetSettingsPorts } = await import('../ports')
    const { tempDataDir, electronTestPorts } = await import('../ports/testing')
    installSettingsPorts(electronTestPorts(tempDataDir('clave-shell-styles-')))
    try {
      const store = await import('../writing-styles/store')
      const source = await import('../writing-styles/source')
      const m = (await import('./shell-source')) as unknown as {
        shellSettingsSource: { managers: { writingStyles?: unknown } }
      }
      expect(m.shellSettingsSource.managers.writingStyles).toBe(store.writingStylesStore)
      store.writingStylesStore.setDefault('quiet')
      expect(source.writingStylesView().defaultStyleId).toBe('quiet')
      source.setWritingStylesSource(null)
    } finally {
      resetSettingsPorts()
    }
  })

  it.each(['separate', 'attached'] as const)(
    '%s: no styles in main, no source installed',
    async (mode) => {
      const m = (await load(mode)) as unknown as {
        shellSettingsSource: { managers: { writingStyles?: unknown } }
      }
      expect('writingStyles' in m.shellSettingsSource.managers).toBe(false)
      // No store installed: a spawn here reads the built-in styles alone.
      const source = await import('../writing-styles/source')
      expect(source.writingStylesView().styles.every((style) => style.builtIn)).toBe(true)
      expect(source.writingStylesView().defaultStyleId).toBeNull()
    }
  )
})
