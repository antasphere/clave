import { describe, expect, it, vi } from 'vitest'
import type { AgentUpdateDeps, RunResult } from './agent-update-manager'

const loginShellEnvAsync = vi.fn(async () => ({ PATH: '/login/bin', HOME: '/home' }))
vi.mock('../sessions/adapters/pty-backend', () => ({
  loginShellEnvAsync: () => loginShellEnvAsync()
}))

import { standaloneHarnessDetection } from './standalone-detection'

/** A fake machine: Pi installed under /bin at 0.85.1, nothing else, a clock
 *  the test moves, and every command run and registry ask counted. */
function machine(): {
  deps: Partial<AgentUpdateDeps>
  runs: string[]
  tagsAsked: string[]
  clock: { t: number }
  failNextRun: () => void
} {
  const runs: string[] = []
  const tagsAsked: string[] = []
  const clock = { t: 1_000 }
  let fail = false
  const bins = new Map([
    [
      '/bin/pi',
      {
        real: '/home/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
        version: '0.85.1'
      }
    ]
  ])
  const deps: Partial<AgentUpdateDeps> = {
    loginEnv: async () => ({ PATH: '/nowhere:/bin', HOME: '/home' }),
    run: async (file, args): Promise<RunResult> => {
      runs.push([file, ...args].join(' '))
      if (fail) {
        fail = false
        throw new Error('spawn exploded')
      }
      const bin = bins.get(file)
      return bin
        ? { code: 0, stdout: `${bin.version}\n`, stderr: '' }
        : { code: null, stdout: '', stderr: '', failure: 'ENOENT' }
    },
    fetchDistTag: async (pkg, tag) => {
      tagsAsked.push(`${pkg}@${tag}`)
      return '9.9.9'
    },
    realpath: async (file) => bins.get(file)?.real ?? file,
    isExecutable: async (file) => bins.has(file),
    claudeChannel: async () => null,
    now: () => clock.t
  }
  return {
    deps,
    runs,
    tagsAsked,
    clock,
    failNextRun: () => {
      fail = true
    }
  }
}

describe('harness detection on a Clave server', () => {
  it('lists an installed harness with its version and an absent one as not installed', async () => {
    const { deps } = machine()
    const withoutRegistry = { ...deps }
    delete withoutRegistry.fetchDistTag
    const agents = await standaloneHarnessDetection({
      env: {},
      testMode: false,
      platform: 'darwin',
      deps: withoutRegistry
    }).detect()
    const pi = agents.find((a) => a.id === 'pi')!
    expect(pi.installed).toBe(true)
    expect(pi.currentVersion).toBe('0.85.1')
    expect(pi.path).toBe('/bin/pi')
    const codex = agents.find((a) => a.id === 'codex')!
    expect(codex.installed).toBe(false)
    expect(codex.currentVersion).toBeNull()
    expect(agents.map((a) => a.id).sort()).toEqual(
      ['antigravity', 'claude', 'codex', 'opencode', 'pi'].sort()
    )
  })

  it('never asks the npm registry: the latest version stays unknown', async () => {
    const m = machine()
    const withoutRegistry = { ...m.deps }
    delete withoutRegistry.fetchDistTag
    const agents = await standaloneHarnessDetection({
      env: {},
      testMode: false,
      platform: 'darwin',
      deps: withoutRegistry
    }).detect()
    expect(m.tagsAsked).toEqual([])
    for (const agent of agents) {
      expect(agent.latestVersion).toBeNull()
      expect(agent.updateAvailable).toBe(false)
    }
  })

  it('runs no command again within the minute, and runs again after it', async () => {
    const m = machine()
    const detection = standaloneHarnessDetection({
      env: {},
      testMode: false,
      platform: 'darwin',
      deps: m.deps
    })
    await detection.detect()
    const afterFirst = m.runs.length
    expect(afterFirst).toBe(1) // only Pi is on the PATH

    m.clock.t += 59_999
    await detection.detect()
    expect(m.runs.length).toBe(afterFirst)

    m.clock.t += 1
    await detection.detect()
    expect(m.runs.length).toBe(afterFirst * 2)
  })

  it('joins a detection already running rather than starting another', async () => {
    const m = machine()
    const detection = standaloneHarnessDetection({
      env: {},
      testMode: false,
      platform: 'darwin',
      deps: m.deps
    })
    const [a, b] = [detection.detect(), detection.detect()]
    expect(b).toBe(a)
    await a
    expect(m.runs.length).toBe(1)
  })

  it('keeps no failed detection: the next call runs again', async () => {
    const m = machine()
    const detection = standaloneHarnessDetection({
      env: {},
      testMode: false,
      platform: 'darwin',
      deps: m.deps
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    m.failNextRun()
    await expect(detection.detect()).rejects.toThrow('spawn exploded')
    const agents = await detection.detect()
    expect(m.runs.length).toBe(2)
    expect(agents.find((a) => a.id === 'pi')!.currentVersion).toBe('0.85.1')
    logged.mockRestore()
  })

  it('searches the test PATH in test mode, over the login shell', async () => {
    const m = machine()
    const rest = { ...m.deps }
    delete rest.loginEnv
    const seen: string[] = []
    const agents = await standaloneHarnessDetection({
      env: { CLAVE_TEST_AGENT_PATH: '/bin' },
      testMode: true,
      platform: 'darwin',
      deps: {
        ...rest,
        isExecutable: async (file) => {
          seen.push(file)
          return file === '/bin/pi'
        }
      }
    }).detect()
    expect(loginShellEnvAsync).toHaveBeenCalled()
    expect(seen.every((f) => f.startsWith('/bin/'))).toBe(true)
    expect(agents.find((a) => a.id === 'pi')!.installed).toBe(true)
  })

  it('detects nothing on Windows and runs no command', async () => {
    const m = machine()
    const agents = await standaloneHarnessDetection({
      env: {},
      testMode: false,
      platform: 'win32',
      deps: m.deps
    }).detect()
    expect(m.runs).toEqual([])
    expect(agents.every((a) => !a.installed)).toBe(true)
  })
})
