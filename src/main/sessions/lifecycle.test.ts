import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtySpawnOptions } from '../pty-manager'
import { inMemorySessionWindows, installSessionWindows, type SessionWindowsPort } from './windows'

// The lifecycle must load and run without Electron (PRDCT-3293): the window
// is a key, and what reaches it goes through the session windows port.
vi.mock('electron', () => {
  throw new Error('the lifecycle imported electron')
})
const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  kill: vi.fn<(id: string) => Promise<void>>(async () => {}),
  listeners: new Map<string, { onData: (d: string) => void; onExit: (c: number) => void }>(),
  preference: vi.fn<(key: string) => unknown>(() => undefined),
  lastWorkspace: vi.fn((): string | null => null),
  scheduleTitle: vi.fn(),
  cleanupTitle: vi.fn(),
  clearState: vi.fn()
}))
vi.mock('../pty-manager', () => ({
  ptyManager: {
    spawn: mocks.spawn,
    kill: mocks.kill,
    attachListeners: (id: string, onData: (d: string) => void, onExit: (c: number) => void) =>
      mocks.listeners.set(id, { onData, onExit })
  }
}))
vi.mock('../workspace-manager', () => ({
  workspaceManager: { getLastActiveWorkspaceId: () => mocks.lastWorkspace() }
}))
vi.mock('../title-generator', () => ({
  scheduleTitleGeneration: mocks.scheduleTitle,
  cleanup: mocks.cleanupTitle,
  notifyClear: vi.fn()
}))
vi.mock('../agent-state-manager', () => ({ clearState: mocks.clearState }))
import { setTmuxPreferenceReader, spawnSession, stopSession } from './lifecycle'

/** A windows port that records everything, with one live window `w1` on
 *  workspace `ws-1`. */
function windows(): {
  port: SessionWindowsPort
  sent: unknown[][]
  bound: Array<[string, string]>
  unbound: string[]
  stops: string[]
} {
  const sent: unknown[][] = []
  const bound: Array<[string, string]> = []
  const unbound: string[] = []
  const stops: string[] = []
  const memory = inMemorySessionWindows()
  const port: SessionWindowsPort = {
    workspaceOf: (key) => (key === 'w1' ? 'ws-1' : null),
    bind: (id, key) => {
      bound.push([id, key])
      memory.bind(id, key)
    },
    unbind: (id) => {
      unbound.push(id)
      memory.unbind(id)
    },
    windowOf: memory.windowOf,
    send: (key, channel, ...args) => {
      if (key === 'w1') sent.push([channel, ...args])
    },
    beforeStop: async (id) => {
      stops.push(`before:${id}`)
    }
  }
  installSessionWindows(port)
  return { port, sent, bound, unbound, stops }
}

let sequence = 0
const spawned = (id: string, extra: Partial<PtySpawnOptions> = {}): void => {
  mocks.spawn.mockImplementation(async (cwd: string, options: PtySpawnOptions) => ({
    id,
    cwd,
    folderName: cwd.split('/').pop(),
    alive: true,
    claudeSessionId: options.claudeMode === false ? null : `claude-${id}`,
    piSessionId: null,
    launchProfileId: options.launchProfileId,
    ...extra
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listeners.clear()
  mocks.preference.mockReturnValue(undefined)
  // The shell's reader of the tmux switch (the .clave handlers' file).
  setTmuxPreferenceReader(() => mocks.preference('tmuxMode'))
  mocks.lastWorkspace.mockReturnValue(null)
})
afterEach(() => {
  installSessionWindows(null)
  setTmuxPreferenceReader(null)
})

describe('a session is spawned for a window named by its key', () => {
  it('stamps the workspace of the asking window and binds the session to it', async () => {
    const id = `life-${++sequence}`
    const { bound } = windows()
    spawned(id)
    const info = await spawnSession('w1', '/work/app', { claudeMode: false })
    expect(info).toMatchObject({ id, cwd: '/work/app', folderName: 'app', alive: true })
    expect(mocks.spawn).toHaveBeenCalledWith('/work/app', {
      claudeMode: false,
      tmuxMode: true,
      workspaceId: 'ws-1',
      windowKey: 'w1'
    })
    expect(bound).toEqual([[id, 'w1']])
  })
  it('a windowless caller falls back to the last active workspace and binds nothing', async () => {
    const id = `life-${++sequence}`
    const { bound } = windows()
    mocks.lastWorkspace.mockReturnValue('ws-last')
    spawned(id)
    await spawnSession(null, '/work/app', { claudeMode: false })
    expect(mocks.spawn.mock.calls[0][1]).toMatchObject({
      workspaceId: 'ws-last',
      windowKey: undefined
    })
    expect(bound).toEqual([])
  })
  it('honours the tmux preference and an explicit workspace over the window’s', async () => {
    const id = `life-${++sequence}`
    windows()
    mocks.preference.mockImplementation((key) => (key === 'tmuxMode' ? false : undefined))
    spawned(id)
    await spawnSession('w1', '/work/app', { claudeMode: false, workspaceId: 'ws-pinned' })
    expect(mocks.spawn.mock.calls[0][1]).toMatchObject({
      tmuxMode: false,
      workspaceId: 'ws-pinned'
    })
  })
  it('sends the terminal’s bytes and its exit to the window by key, and unbinds on exit', async () => {
    const id = `life-${++sequence}`
    const { sent, unbound } = windows()
    spawned(id)
    await spawnSession('w1', '/work/app', { claudeMode: false })
    const listeners = mocks.listeners.get(id)!
    listeners.onData('hello')
    listeners.onExit(3)
    expect(sent).toEqual([
      [`pty:data:${id}`, 'hello'],
      [`pty:exit:${id}`, 3]
    ])
    expect(unbound).toEqual([id])
    expect(mocks.cleanupTitle).toHaveBeenCalledWith(id)
    expect(mocks.clearState).toHaveBeenCalledWith(id)
  })
  it('names a fresh Claude session by its first message, on the asking window', async () => {
    const id = `life-${++sequence}`
    windows()
    spawned(id)
    await spawnSession('w1', '/work/app', { claudeProfileId: 'acct' })
    expect(mocks.scheduleTitle).toHaveBeenCalledWith(id, '/work/app', `claude-${id}`, 'w1', {
      workspaceId: 'ws-1',
      launchProfileId: undefined,
      claudeProfileId: 'acct',
      configDir: undefined
    })
  })
  it('a resumed Claude session keeps its name', async () => {
    const id = `life-${++sequence}`
    windows()
    spawned(id)
    await spawnSession('w1', '/work/app', { resumeSessionId: 'old' })
    expect(mocks.scheduleTitle).not.toHaveBeenCalled()
  })
  it('a windowless Claude session is still named, through the server’s events', async () => {
    const id = `life-${++sequence}`
    windows()
    spawned(id)
    await spawnSession(null, '/work/app', {})
    expect(mocks.scheduleTitle).toHaveBeenCalledWith(
      id,
      '/work/app',
      `claude-${id}`,
      null,
      expect.anything()
    )
  })
})

describe('a session is stopped', () => {
  it('lets the window finish first, then kills and unbinds', async () => {
    const id = `life-${++sequence}`
    const { stops, unbound } = windows()
    mocks.kill.mockImplementation(async (killed: string) => {
      stops.push(`kill:${killed}`)
    })
    await stopSession(id)
    expect(stops).toEqual([`before:${id}`, `kill:${id}`])
    expect(unbound).toEqual([id])
  })
})
