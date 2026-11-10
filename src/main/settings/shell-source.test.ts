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
 * The helpers' preference (PRDCT-4330): ONE per machine, owned by the process
 * that holds the machine's settings. In-process, main owns it and its runner
 * reads its own store; with the server elsewhere, main's runner and its IPC
 * route ask the server, never a file of main's.
 */
const owner = vi.hoisted(() => ({
  asked: 0,
  list: [] as Array<Record<string, unknown>>
}))
vi.mock('../mcp/server-client', () => ({
  serverClient: {
    api: async () => ({
      settings: {
        helpers: {
          list: async () => {
            owner.asked += 1
            return owner.list
          },
          set: async () => owner.list
        }
      }
    })
  }
}))

describe("main's helpers read the machine's one preference", () => {
  const view = (over: Record<string, unknown>): Record<string, unknown> => ({
    id: 'tab-title',
    label: 'Tab titles',
    enabled: true,
    model: 'haiku',
    defaultModel: 'haiku',
    account: { kind: 'session' },
    ...over
  })

  it('in-process: the runner reads main’s own store, written through the source', async () => {
    await load('in-process')
    const { installSettingsPorts, resetSettingsPorts } = await import('../ports')
    const { tempDataDir, electronTestPorts } = await import('../ports/testing')
    installSettingsPorts(electronTestPorts(tempDataDir('clave-shell-helpers-')))
    try {
      const prefs = await import('../helpers/preferences')
      const registry = await import('../helpers/registry')
      prefs.helperPreferences.set('tab-title', { enabled: false, model: 'sonnet' })
      const config = registry.resolveHelperConfig(registry.helperById('tab-title')!)
      expect(config).toMatchObject({ enabled: false, model: 'sonnet' })
      expect(owner.asked).toBe(0)
    } finally {
      resetSettingsPorts()
    }
  })

  it.each(['separate', 'attached'] as const)(
    '%s: the runner asks the server at each call, and nothing of main’s is read',
    async (mode) => {
      owner.asked = 0
      owner.list = [view({ enabled: false, model: 'opus', account: { kind: 'machine' } })]
      const m = (await load(mode)) as unknown as {
        shellSettingsSource: { managers: { helpers: { list: () => Promise<unknown[]> } } }
      }
      const registry = await import('../helpers/registry')
      const title = registry.helperById('tab-title')!
      await expect(registry.resolveHelperConfig(title)).resolves.toMatchObject({
        enabled: false,
        model: 'opus',
        claudeProfileId: null
      })
      owner.list = [view({})]
      await expect(registry.resolveHelperConfig(title)).resolves.toMatchObject({
        enabled: true,
        model: 'haiku',
        claudeProfileId: undefined
      })
      expect(owner.asked).toBe(2)
      // The IPC route of this Mac's page reaches the same owner.
      await m.shellSettingsSource.managers.helpers.list()
      expect(owner.asked).toBe(3)
    }
  )
})
