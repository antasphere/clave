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
  // ── Wave 4: the restart and the state the shadow reads ──
  restartSpawn: vi.fn(),
  getSessionRecord: vi.fn(() => undefined as unknown),
  setSessionDisplayName: vi.fn(),
  setSessionViewRecord: vi.fn(),
  writes: [] as [string, string][],
  states: new Map<string, { state: string; transport: string }>(),
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
      mocks.listeners.set(id, { onData, onExit }),
    restartSpawn: mocks.restartSpawn,
    // The real kill ends the process, whose exit runs the listener the
    // lifecycle attached, before the kill resolves.
    killAndWait: async (id: string) => {
      mocks.listeners.get(id)?.onExit(0)
    },
    getSessionRecord: mocks.getSessionRecord,
    setSessionDisplayName: mocks.setSessionDisplayName,
    setSessionViewRecord: mocks.setSessionViewRecord,
    getSession: (id: string) => (mocks.states.has(id) ? { id, alive: true } : undefined),
    write: (id: string, data: string) => void mocks.writes.push([id, data])
  }
}))
vi.mock('./session-manager', () => ({
  sessionManager: { get: (id: string) => mocks.states.get(id) }
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
import {
  readScreen,
  restartSession,
  setTmuxPreferenceReader,
  spawnSession,
  stopSession,
  trackInput,
  typeIntoSession
} from './lifecycle'
import { parentOf, resetLineageForTests, setParent } from './lineage'
import { hasScreen } from './terminal-screen'
import { getDraftShadow } from '../../shared/draft-shadow'

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
  mocks.states.clear()
  mocks.writes.length = 0
  resetLineageForTests()
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

// ── Wave 4, lane D: what the served agent tools stand on in the lifecycle ──

describe('what a terminal leaves for the served tools', () => {
  it('keeps what the terminal printed for a screen read, and forgets it at the exit', async () => {
    const id = `life-${++sequence}`
    windows()
    spawned(id)
    await spawnSession('w1', '/work/app', { claudeMode: false })
    mocks.states.set(id, { state: 'idle', transport: 'pty' })
    const listeners = mocks.listeners.get(id)!
    listeners.onData('$ make\r\nok\r\n')
    expect(hasScreen(id)).toBe(true)
    expect((await readScreen(id, 10)).lines).toEqual(['$ make', 'ok'])
    listeners.onExit(0)
    expect(hasScreen(id)).toBe(false)
    await expect(readScreen(id, 10)).rejects.toThrow('no terminal screen')
  })
  it('refuses a screen read of a chat tab', async () => {
    mocks.states.set('chat', { state: 'idle', transport: 'events' })
    await expect(readScreen('chat', 10)).rejects.toThrow('no terminal screen')
  })
  it('feeds the draft shadow from the keystrokes it writes, opaque while the agent is blocked', () => {
    const id = `life-${++sequence}`
    mocks.states.set(id, { state: 'idle', transport: 'pty' })
    trackInput(id, 'half')
    expect(getDraftShadow(id).snapshot()).toMatchObject({ text: 'half', confident: true })
    mocks.states.set(id, { state: 'blocked', transport: 'pty' })
    trackInput(id, 'y')
    expect(getDraftShadow(id).snapshot()).toMatchObject({ text: 'half', confident: false })
  })
  it('types into the terminal through the manager, never through the shadow', async () => {
    const id = `life-${++sequence}`
    mocks.states.set(id, { state: 'idle', transport: 'pty' })
    trackInput(id, 'draft')
    const out = await typeIntoSession(id, 'msg')
    expect(out).toEqual({ submitted: true, draftHandling: 'stashed-restored' })
    expect(mocks.writes.map(([, d]) => d)).toEqual([
      '\x7f'.repeat(5),
      '\x1b[200~msg\x1b[201~',
      '\r',
      '\x1b[200~draft\x1b[201~'
    ])
    expect(getDraftShadow(id).snapshot()).toMatchObject({ text: 'draft', confident: true })
    await expect(typeIntoSession('nobody', 'x')).rejects.toThrow('Unknown session: nobody')
  })
  it('forgets the parent link when the tab really ends', async () => {
    const id = `life-${++sequence}`
    windows()
    spawned(id)
    await spawnSession('w1', '/work/app', { claudeMode: false })
    setParent(id, 'coordinator')
    mocks.listeners.get(id)!.onExit(0)
    expect(parentOf(id)).toBeNull()
  })
})

describe('a restart on another account', () => {
  const plan = (id: string): void => {
    mocks.restartSpawn.mockReturnValue({
      cwd: '/work/app',
      options: { claudeMode: true, adoptSessionId: id, claudeProfileId: 'acc-2' },
      resumed: true
    })
  }
  it('keeps the tab in the window that holds it, with its parent link, its name and its page', async () => {
    const id = `life-${++sequence}`
    const { bound, unbound } = windows()
    spawned(id)
    await spawnSession('w1', '/work/app', { claudeMode: true })
    setParent(id, 'coordinator')
    plan(id)
    mocks.getSessionRecord.mockReturnValue({
      displayName: 'Lane D',
      userRenamed: true,
      view: { url: 'http://127.0.0.1:4814' }
    })
    spawned(id)
    const out = await restartSession(id, { claudeProfileId: 'acc-2' })
    expect(out).toMatchObject({ id, resumed: true })
    expect(mocks.spawn.mock.calls.at(-1)).toEqual([
      '/work/app',
      expect.objectContaining({ adoptSessionId: id, claudeProfileId: 'acc-2', windowKey: 'w1' })
    ])
    expect(unbound).toContain(id)
    expect(bound.at(-1)).toEqual([id, 'w1'])
    expect(parentOf(id)).toBe('coordinator')
    expect(mocks.setSessionDisplayName).toHaveBeenCalledWith(id, 'Lane D', true)
    expect(mocks.setSessionViewRecord).toHaveBeenCalledWith(id, { url: 'http://127.0.0.1:4814' })
  })
  it('takes the key the caller names, and refuses a tab it did not spawn', async () => {
    const id = `life-${++sequence}`
    windows()
    spawned(id)
    await spawnSession('w1', '/work/app', { claudeMode: true })
    plan(id)
    spawned(id)
    await restartSession(id, {}, 'w2')
    expect(mocks.spawn.mock.calls.at(-1)![1]).toMatchObject({ windowKey: 'w2' })
    mocks.restartSpawn.mockReturnValue(null)
    await expect(restartSession('other', {})).rejects.toThrow(
      'This session cannot be restarted from here.'
    )
  })
})
