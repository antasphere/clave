import { describe, expect, it, vi } from 'vitest'
import type { ServerLaunch } from '../server-boot'

/**
 * THE choke point (PRDCT-4330): with a server of its own behind the window
 * (separate or attached), the helpers' runner in main refuses every helper of
 * the catalog before any spawn, whoever calls it; in-process main is the
 * server and runs them. The CLI is a stub; nothing reaches a model.
 */
const launch = vi.hoisted(() => ({ current: { mode: 'in-process' } as ServerLaunch }))
const mocks = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('../server-launch', () => ({
  get serverLaunch() {
    return launch.current
  }
}))
vi.mock('electron', () => ({}))
vi.mock('child_process', () => ({ execFile: mocks.execFile }))
vi.mock('../sessions/adapters/pty-backend', () => ({
  getLoginShellEnv: () => ({ PATH: '/bin' }),
  getUserShell: () => '/bin/zsh',
  accountTokenForSpawn: async () => undefined
}))
vi.mock('../launch-profile-manager', () => ({
  launchProfileManager: {
    resolveClaudeCli: () => ({
      id: 'claude',
      name: 'Claude',
      family: 'claude',
      command: ['claude'],
      additionalArgs: []
    })
  }
}))
vi.mock('../shell-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../shell-launch')>()),
  findExecutable: (command: string) => command
}))
vi.mock('../antasphere-account', () => ({ AntasphereAccountManager: class {} }))
vi.mock('./source', () => ({ settingsSourceFromManagers: (managers: unknown) => ({ managers }) }))
vi.mock('../claude-accounts', () => ({ claudeAccountsManager: { get: () => undefined } }))
vi.mock('../codex-accounts', () => ({ codexAccountsManager: {} }))
vi.mock('../usage-manager', () => ({ usageManager: {} }))
vi.mock('../codex-usage', () => ({ codexUsageManager: {} }))
vi.mock('../pi-usage', () => ({ piUsageManager: {} }))
vi.mock('../preferences-manager', () => ({ preferencesManager: {} }))
vi.mock('../workspace-manager', () => ({ workspaceManager: {} }))
vi.mock('../app-icon', () => ({ applyAppIcon: () => {} }))

const INPUTS: Record<string, unknown> = {
  'tab-title': 'please name this tab',
  'exchange-digest': [{ from: 'Verifier', text: 'done' }],
  'work-digest': { notes: ['a'], tools: 1 },
  'commit-message': { diff: 'diff --git a/x b/x', recent: '' },
  'push-summary': { commitMessages: ['feat: a'], diffStats: '1 file' }
}

async function boot(mode: 'in-process' | 'separate' | 'attached'): Promise<{
  runner: typeof import('../helpers/runner')
  catalog: Array<{ id: string }>
}> {
  vi.resetModules()
  mocks.execFile.mockReset().mockImplementation(() => ({
    stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() },
    kill: vi.fn(),
    once: vi.fn()
  }))
  launch.current = mode === 'attached' ? { mode, url: 'http://127.0.0.1:1', token: 't' } : { mode }
  const { installSettingsPorts } = await import('../ports')
  const { electronTestPorts, tempDataDir } = await import('../ports/testing')
  installSettingsPorts(electronTestPorts(tempDataDir('clave-choke-')))
  await import('./shell-source')
  const runner = await import('../helpers/runner')
  const catalog = Object.values(await import('../helpers/catalog')) as Array<{ id: string }>
  return { runner, catalog }
}

describe("main's runner with a server of its own behind the window", () => {
  it.each(['separate', 'attached'] as const)(
    '%s: every helper of the catalog is refused in main, nothing spawned',
    async (mode) => {
      const { runner, catalog } = await boot(mode)
      expect(catalog.map((h) => h.id).sort()).toEqual(Object.keys(INPUTS).sort())
      for (const helper of catalog) {
        const outcome = await runner.runHelper(helper as never, INPUTS[helper.id] as never, {})
        expect(outcome).toEqual({
          ok: false,
          reason: 'failed',
          detail: "Helpers run on Clave's server."
        })
      }
      expect(mocks.execFile).not.toHaveBeenCalled()
    },
    30_000
  )

  it('in-process: main is the server and runs them', async () => {
    const { runner, catalog } = await boot('in-process')
    for (const helper of catalog)
      void runner.runHelper(helper as never, INPUTS[helper.id] as never, {})
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(mocks.execFile).toHaveBeenCalled()
    runner.cancelAll()
  }, 30_000)
})
