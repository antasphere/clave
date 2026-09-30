import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AgentUpdateManager,
  CHECK_INTERVAL_MS,
  HELD_BACK_RETRY_MS,
  INITIAL_DELAY_MS,
  failureText,
  type AgentUpdateDeps,
  type RunResult
} from './agent-update-manager'
import type { AgentUpdatesState } from '../../shared/agent-updates'

/**
 * A fake machine: binaries on a PATH, the file each resolves to, the version
 * each prints, the latest release each registry answers, and installers that
 * move a version (or do not). Every command run is recorded, with how many
 * ran at once.
 */
interface Machine {
  runs: string[]
  tagsAsked: string[]
  notes: string[]
  states: AgentUpdatesState[]
  readonly maxRunning: number
  setVersion: (cmd: string, version: string) => void
}

function machine(opts: {
  installed?: Record<string, { real: string; version: string }>
  latest?: Record<string, string>
  claudeChannel?: string | null
  upgrade?: (file: string, args: string[], m: Machine) => RunResult
  autoUpdate?: boolean
}): { m: Machine; deps: AgentUpdateDeps } {
  const bins = new Map(
    Object.entries(opts.installed ?? {}).map(([cmd, v]) => [`/bin/${cmd}`, { ...v }])
  )
  const runs: string[] = []
  const tagsAsked: string[] = []
  const notes: string[] = []
  const states: AgentUpdatesState[] = []
  let running = 0
  let maxRunning = 0
  let auto = opts.autoUpdate ?? true
  const m: Machine = {
    runs,
    tagsAsked,
    notes,
    states,
    get maxRunning(): number {
      return maxRunning
    },
    setVersion(cmd: string, version: string): void {
      bins.get(`/bin/${cmd}`)!.version = version
    }
  }
  const deps: AgentUpdateDeps = {
    loginEnv: async () => ({ PATH: '/nowhere:/bin', HOME: '/home' }),
    run: async (file, args) => {
      running++
      maxRunning = Math.max(maxRunning, running)
      runs.push([file, ...args].join(' '))
      await new Promise((r) => setTimeout(r, 1))
      try {
        if (args[0] === '--version') {
          const bin = bins.get(file)
          return bin
            ? { code: 0, stdout: `${bin.version}\n`, stderr: '' }
            : { code: null, stdout: '', stderr: '', failure: 'ENOENT' }
        }
        return opts.upgrade ? opts.upgrade(file, args, m) : { code: 0, stdout: '', stderr: '' }
      } finally {
        running--
      }
    },
    fetchDistTag: async (pkg, tag) => {
      tagsAsked.push(`${pkg}@${tag}`)
      return opts.latest?.[pkg] ?? null
    },
    realpath: async (file) => bins.get(file)?.real ?? file,
    isExecutable: async (file) =>
      bins.has(file) || file === '/bin/brew' || file === '/bin/bun' || file === '/bin/npm',
    claudeChannel: async () => opts.claudeChannel ?? null,
    getAutoUpdate: () => auto,
    setAutoUpdate: (value) => {
      auto = value
    },
    scheduled: false,
    supported: true,
    broadcast: (state) => states.push(state),
    notify: (title, body) => notes.push(`${title} | ${body}`),
    now: () => 1_000
  }
  return { m, deps }
}

const PI = {
  pi: {
    real: '/home/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/cli.js',
    version: '0.85.1'
  }
}
const PI_LATEST = { '@earendil-works/pi-coding-agent': '0.99.1' }

afterEach(() => {
  vi.useRealTimers()
})

describe('a check with automatic updates on', () => {
  it('upgrades an agent that is behind, with its own installer, and says so once', async () => {
    const { m, deps } = machine({
      installed: PI,
      latest: PI_LATEST,
      upgrade: (file, args, mm) => {
        mm.setVersion('pi', '0.99.1')
        expect([file, ...args]).toEqual([
          '/bin/bun',
          'add',
          '-g',
          '@earendil-works/pi-coding-agent@latest'
        ])
        return { code: 0, stdout: '', stderr: '' }
      }
    })
    const manager = new AgentUpdateManager(deps)
    const state = await manager.checkAll()
    const pi = state.agents.find((a) => a.id === 'pi')!
    expect(pi.currentVersion).toBe('0.99.1')
    expect(pi.updatedFrom).toBe('0.85.1')
    expect(pi.lastUpdatedAt).toBe(1_000)
    expect(pi.updateAvailable).toBe(false)
    expect(pi.error).toBeNull()
    expect(m.notes).toEqual([
      'Pi updated to 0.99.1 | New Pi sessions start on it. Open tabs stay on 0.85.1 until restarted.'
    ])
    expect(m.runs.filter((r) => r.includes('add -g'))).toHaveLength(1)
  })

  it('reports an agent that is not on the PATH as not installed and runs nothing for it', async () => {
    const { m, deps } = machine({ installed: PI, latest: PI_LATEST })
    const state = await new AgentUpdateManager(deps).checkAll()
    const claude = state.agents.find((a) => a.id === 'claude')!
    expect(claude.installed).toBe(false)
    expect(claude.lastCheckedAt).toBe(1_000)
    expect(m.runs.some((r) => r.includes('claude'))).toBe(false)
  })

  it('never touches an install it cannot identify, however far behind', async () => {
    const { m, deps } = machine({
      installed: { codex: { real: '/opt/tools/codex', version: '0.1.0' } },
      latest: { '@openai/codex': '9.9.9' }
    })
    const state = await new AgentUpdateManager(deps).checkAll()
    const codex = state.agents.find((a) => a.id === 'codex')!
    expect(codex.install).toEqual({ kind: 'unknown' })
    expect(codex.updateAvailable).toBe(false)
    expect(codex.note).toMatch(/leaves its updates to it/)
    expect(m.runs).toEqual(['/bin/codex --version'])
  })

  it("asks Claude's own channel for the latest release", async () => {
    const { m, deps } = machine({
      installed: {
        claude: { real: '/home/.local/share/claude/versions/2.1.285', version: '2.1.285' }
      },
      latest: { '@anthropic-ai/claude-code': '2.1.280' },
      claudeChannel: 'stable'
    })
    const state = await new AgentUpdateManager(deps).checkAll()
    expect(m.tagsAsked).toEqual(['@anthropic-ai/claude-code@stable'])
    expect(state.agents.find((a) => a.id === 'claude')!.updateAvailable).toBe(false)
    expect(m.runs).toEqual(['/bin/claude --version'])
  })
})

describe('a check with automatic updates off', () => {
  it('only says an update exists, and the button installs it', async () => {
    const { m, deps } = machine({
      installed: PI,
      latest: PI_LATEST,
      autoUpdate: false,
      upgrade: (_f, _a, mm) => {
        mm.setVersion('pi', '0.99.1')
        return { code: 0, stdout: '', stderr: '' }
      }
    })
    const manager = new AgentUpdateManager(deps)
    const checked = await manager.checkAll()
    expect(checked.agents.find((a) => a.id === 'pi')!.updateAvailable).toBe(true)
    expect(m.runs.some((r) => r.includes('add -g'))).toBe(false)
    expect(m.notes).toEqual([])

    const updated = await manager.update('pi')
    expect(updated.agents.find((a) => a.id === 'pi')!.currentVersion).toBe('0.99.1')
    expect(m.runs.filter((r) => r.includes('add -g'))).toHaveLength(1)
  })

  it('turning it back on installs what the last check found', async () => {
    const { m, deps } = machine({
      installed: PI,
      latest: PI_LATEST,
      autoUpdate: false,
      upgrade: (_f, _a, mm) => {
        mm.setVersion('pi', '0.99.1')
        return { code: 0, stdout: '', stderr: '' }
      }
    })
    const manager = new AgentUpdateManager(deps)
    await manager.checkAll()
    manager.setAutoUpdate(true)
    await vi.waitFor(() => expect(m.notes).toHaveLength(1))
  })
})

describe('what an upgrade can come back with', () => {
  it('a clean run that moved nothing holds the release back, and the automatic pass waits a day', async () => {
    const { m, deps } = machine({
      installed: {
        codex: { real: '/opt/homebrew/Caskroom/codex/0.159.0/bin/codex', version: '0.159.0' }
      },
      latest: { '@openai/codex': '0.159.1' }
    })
    let clock = 1_000
    deps.now = () => clock
    const manager = new AgentUpdateManager(deps)
    const brewRuns = (): number => m.runs.filter((r) => r.includes('brew upgrade')).length

    const first = (await manager.checkAll()).agents.find((a) => a.id === 'codex')!
    expect(brewRuns()).toBe(1)
    expect(first.heldBack).toBe('0.159.1')
    expect(first.heldBackAt).toBe(1_000)
    expect(first.updateAvailable).toBe(true)
    expect(first.error).toBeNull()
    expect(first.lastUpdatedAt).toBeNull()
    expect(m.notes).toEqual([])

    clock += HELD_BACK_RETRY_MS - 1
    await manager.checkAll()
    expect(brewRuns()).toBe(1)

    // The button does not wait.
    await manager.update('codex')
    expect(brewRuns()).toBe(2)

    clock += HELD_BACK_RETRY_MS
    await manager.checkAll()
    expect(brewRuns()).toBe(3)
  })

  it('a newer latest release than the one held back is tried at once', async () => {
    const tags: Record<string, string> = { '@openai/codex': '0.159.1' }
    const { m, deps } = machine({
      installed: {
        codex: { real: '/opt/homebrew/Caskroom/codex/0.159.0/bin/codex', version: '0.159.0' }
      }
    })
    deps.fetchDistTag = async (pkg) => tags[pkg] ?? null
    const manager = new AgentUpdateManager(deps)
    await manager.checkAll()
    tags['@openai/codex'] = '0.160.0'
    const state = await manager.checkAll()
    expect(m.runs.filter((r) => r.includes('brew upgrade'))).toHaveLength(2)
    expect(state.agents.find((a) => a.id === 'codex')!.heldBack).toBe('0.160.0')
  })

  it('finds brew where Homebrew puts it when the login PATH lacks it', async () => {
    const { m, deps } = machine({
      installed: {
        codex: { real: '/opt/homebrew/Caskroom/codex/0.159.0/bin/codex', version: '0.159.0' }
      },
      latest: { '@openai/codex': '0.159.1' }
    })
    deps.isExecutable = async (file) => file === '/bin/codex' || file === '/opt/homebrew/bin/brew'
    await new AgentUpdateManager(deps).checkAll()
    expect(m.runs).toContain('/opt/homebrew/bin/brew upgrade --cask codex')
  })

  it('reads a version a CLI prints on stderr', async () => {
    const { deps } = machine({ installed: PI, latest: {} })
    const run = deps.run
    deps.run = async (file, args, opts) =>
      args[0] === '--version'
        ? { code: 0, stdout: '', stderr: 'pi v0.85.1\n' }
        : run(file, args, opts)
    const state = await new AgentUpdateManager(deps).checkAll()
    expect(state.agents.find((a) => a.id === 'pi')!.currentVersion).toBe('0.85.1')
  })

  it('a failed run keeps the version and shows the tail of what the installer said', async () => {
    const { m, deps } = machine({
      installed: PI,
      latest: PI_LATEST,
      upgrade: () => ({ code: 1, stdout: '', stderr: 'resolving\nerror: EACCES permission denied' })
    })
    const state = await new AgentUpdateManager(deps).checkAll()
    const pi = state.agents.find((a) => a.id === 'pi')!
    expect(pi.currentVersion).toBe('0.85.1')
    expect(pi.error).toBe('resolving\nerror: EACCES permission denied')
    expect(pi.updateAvailable).toBe(true)
    expect(m.notes).toEqual([])
  })

  it('a run that exits non-zero after the version moved counts as the upgrade it was', async () => {
    const { m, deps } = machine({
      installed: PI,
      latest: PI_LATEST,
      upgrade: (_f, _a, mm) => {
        mm.setVersion('pi', '0.99.1')
        return { code: 1, stdout: '', stderr: 'warning: cleanup failed' }
      }
    })
    const state = await new AgentUpdateManager(deps).checkAll()
    expect(state.agents.find((a) => a.id === 'pi')!.error).toBeNull()
    expect(m.notes).toHaveLength(1)
  })

  it('an installer missing from the PATH is said by name', async () => {
    const { deps } = machine({ installed: PI, latest: PI_LATEST })
    deps.isExecutable = async (file) => file === '/bin/pi'
    const state = await new AgentUpdateManager(deps).checkAll()
    expect(state.agents.find((a) => a.id === 'pi')!.error).toBe('bun is not on your login PATH.')
  })

  it('failureText prefers the process failure, then the last lines of stderr', () => {
    expect(failureText({ code: null, stdout: '', stderr: 'x', failure: 'timed out' })).toBe(
      'timed out'
    )
    expect(failureText({ code: 2, stdout: 'only stdout', stderr: '' })).toBe('only stdout')
    expect(failureText({ code: 3, stdout: '', stderr: '' })).toBe('Exited with code 3')
  })
})

describe('never two at once', () => {
  it('runs one command at a time across a check and a manual update, and joins a second check', async () => {
    const { m, deps } = machine({
      installed: {
        ...PI,
        codex: { real: '/opt/homebrew/Caskroom/codex/0.159.0/bin/codex', version: '0.159.0' }
      },
      latest: { ...PI_LATEST, '@openai/codex': '0.159.1' },
      upgrade: (_f, args, mm) => {
        if (args.includes('--cask')) mm.setVersion('codex', '0.159.1')
        else mm.setVersion('pi', '0.99.1')
        return { code: 0, stdout: '', stderr: '' }
      }
    })
    const manager = new AgentUpdateManager(deps)
    const first = manager.checkAll()
    const second = manager.checkAll()
    expect(second).toBe(first)
    const manual = manager.update('pi')
    await Promise.all([first, manual])
    expect(m.maxRunning).toBe(1)
    // The manual update and the automatic pass do not both install Pi.
    expect(m.runs.filter((r) => r.includes('add -g'))).toHaveLength(1)
    expect(m.notes).toHaveLength(2)
  })

  it('says it is busy while work is queued, and idle after', async () => {
    const { m, deps } = machine({ installed: PI, latest: {} })
    const manager = new AgentUpdateManager(deps)
    const pass = manager.checkAll()
    expect(manager.getState().busy).toBe(true)
    await pass
    expect(manager.getState().busy).toBe(false)
    expect(m.states.at(-1)!.busy).toBe(false)
  })
})

describe('an update asked before any check', () => {
  it('inspects first and runs no installer for an agent already current', async () => {
    const { m, deps } = machine({
      installed: PI,
      latest: { '@earendil-works/pi-coding-agent': '0.85.1' }
    })
    const state = await new AgentUpdateManager(deps).update('pi')
    expect(state.agents.find((a) => a.id === 'pi')!.currentVersion).toBe('0.85.1')
    expect(m.runs).toEqual(['/bin/pi --version'])
  })
})

describe('the queue', () => {
  it('does not install an agent twice when the button and the automatic pass race', async () => {
    const { m, deps } = machine({
      installed: PI,
      latest: PI_LATEST,
      upgrade: (_f, _a, mm) => {
        mm.setVersion('pi', '0.99.1')
        return { code: 0, stdout: '', stderr: '' }
      }
    })
    const manager = new AgentUpdateManager(deps)
    await Promise.all([manager.checkAll(), manager.update('pi')])
    expect(m.runs.filter((r) => r.includes('add -g'))).toHaveLength(1)
    expect(m.notes).toHaveLength(1)
  })

  it('a second click queued behind the first installs nothing', async () => {
    const { m, deps } = machine({
      installed: PI,
      latest: PI_LATEST,
      autoUpdate: false,
      upgrade: (_f, _a, mm) => {
        mm.setVersion('pi', '0.99.1')
        return { code: 0, stdout: '', stderr: '' }
      }
    })
    const manager = new AgentUpdateManager(deps)
    await manager.checkAll()
    await Promise.all([manager.update('pi'), manager.update('pi')])
    expect(m.runs.filter((r) => r.includes('add -g'))).toHaveLength(1)
  })

  it('survives a step that throws: the next check and update still run', async () => {
    const { m, deps } = machine({
      installed: PI,
      latest: PI_LATEST,
      autoUpdate: false,
      upgrade: (_f, _a, mm) => {
        mm.setVersion('pi', '0.99.1')
        return { code: 0, stdout: '', stderr: '' }
      }
    })
    const loginEnv = deps.loginEnv
    let fail = true
    deps.loginEnv = async () => {
      if (fail) {
        fail = false
        throw new Error('login shell died')
      }
      return loginEnv()
    }
    const manager = new AgentUpdateManager(deps)
    await expect(manager.checkAll()).resolves.toBeDefined()
    const checked = await manager.checkAll()
    expect(checked.agents.find((a) => a.id === 'pi')!.updateAvailable).toBe(true)
    const updated = await manager.update('pi')
    expect(updated.agents.find((a) => a.id === 'pi')!.currentVersion).toBe('0.99.1')
    expect(updated.busy).toBe(false)
    expect(m.runs.filter((r) => r.includes('add -g'))).toHaveLength(1)
  })

  it('stays busy from the first read to the last upgrade of a pass', async () => {
    const { m, deps } = machine({
      installed: PI,
      latest: PI_LATEST,
      upgrade: (_f, _a, mm) => {
        mm.setVersion('pi', '0.99.1')
        return { code: 0, stdout: '', stderr: '' }
      }
    })
    const manager = new AgentUpdateManager(deps)
    const start = m.states.length
    await manager.checkAll()
    const during = m.states.slice(start, -1)
    expect(during.length).toBeGreaterThan(0)
    expect(during.every((state) => state.busy)).toBe(true)
    expect(m.states.at(-1)!.busy).toBe(false)
  })
})

describe('where the installers cannot run', () => {
  it('does nothing and says so', async () => {
    vi.useFakeTimers()
    const { m, deps } = machine({ installed: PI, latest: PI_LATEST })
    const manager = new AgentUpdateManager({ ...deps, supported: false, scheduled: true })
    manager.start()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    const state = await manager.checkAll()
    await manager.update('pi')
    expect(state.supported).toBe(false)
    expect(m.runs).toEqual([])
  })
})

describe('the schedule', () => {
  it('checks after the boot settles and every six hours, when scheduled', async () => {
    vi.useFakeTimers()
    const { deps } = machine({})
    const manager = new AgentUpdateManager({ ...deps, scheduled: true })
    const spy = vi.spyOn(manager, 'checkAll')
    manager.start()
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS - 1)
    expect(spy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(spy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS)
    expect(spy).toHaveBeenCalledTimes(2)
    manager.stop()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('never starts a timer when not scheduled (test mode, dev builds)', async () => {
    vi.useFakeTimers()
    const { deps } = machine({})
    const manager = new AgentUpdateManager(deps)
    const spy = vi.spyOn(manager, 'checkAll')
    manager.start()
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2)
    expect(spy).not.toHaveBeenCalled()
  })
})
