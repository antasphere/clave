/**
 * The preload's `onServerConnected` (wave 6, lane A, PRDCT-3526): heard when
 * the window's server connection opens and at every welcome after that, a
 * reconnection included, which is when the chat pane asks again for a past
 * it lost. Not heard before the push channel is open, never after the
 * listener is released, and not at all by a window on IPC for good. The
 * doubles are `preload-server-events.test.ts`'s.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronAPI } from '../../preload/index.d'

type Listener = (...args: unknown[]) => void
type PushDouble = {
  status: string
  connect: ReturnType<typeof vi.fn>
  whenOpen: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
  onStatus: ReturnType<typeof vi.fn>
  events: Set<Listener>
  statuses: Set<Listener>
  open: () => void
}
const mocks = vi.hoisted(() => {
  const state = {
    exposed: new Map<string, unknown>(),
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    settings: {} as Record<string, Record<string, ReturnType<typeof vi.fn>>>,
    sessions: {} as Record<string, ReturnType<typeof vi.fn>>,
    push: null as null | PushDouble,
    pushReads: 0,
    makePush: (): PushDouble => {
      let resolveOpen: () => void = () => {}
      const opened = new Promise<void>((r) => {
        resolveOpen = r
      })
      const push: PushDouble = {
        status: 'connecting',
        connect: vi.fn(() => push),
        whenOpen: vi.fn(() => opened),
        onEvent: vi.fn((listener: Listener) => {
          push.events.add(listener)
          return () => {
            push.events.delete(listener)
          }
        }),
        onStatus: vi.fn((listener: Listener) => {
          push.statuses.add(listener)
          return () => {
            push.statuses.delete(listener)
          }
        }),
        events: new Set(),
        statuses: new Set(),
        open: () => {
          push.status = 'open'
          for (const listener of [...push.statuses]) listener('open', { attempt: 1 })
          resolveOpen()
        }
      }
      return push
    },
    emitEvent: (event: Record<string, unknown>): void => {
      for (const listener of mocks.push?.events ?? []) listener({ id: 'e', seq: 1, at: 0, event })
    }
  }
  return state
})
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => mocks.exposed.set(key, value)
  },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener },
  webUtils: {}
}))
vi.mock('@clave/client/node', () => ({
  connectThroughNode: async () => {
    const push = mocks.makePush()
    mocks.push = push
    // Every read of `push` off the backing is one wait fired at the announce
    // (the preload hands each waiting listener `backing.push`), counted so a
    // wait that should have been withdrawn shows.
    return {
      api: { settings: mocks.settings, sessions: mocks.sessions },
      get push() {
        mocks.pushReads += 1
        return push
      }
    }
  }
}))

let api: ElectronAPI
const endpoint = { url: 'http://127.0.0.1:4242', token: 'secret' }
const answer = (table: Record<string, unknown>): void => {
  mocks.invoke.mockImplementation(async (channel: string) => table[channel])
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
/** The server comes: a routed call connects the backing and announces it. */
const serverComes = async (): Promise<void> => {
  answer({ 'server:endpoint': endpoint })
  await api.claudeAccountsList().catch(() => undefined)
  await settle()
  expect(mocks.push).not.toBeNull()
}

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.push = null
  mocks.pushReads = 0
  mocks.settings = { claudeAccounts: { list: vi.fn(async () => []) } }
  mocks.sessions = { keepOnRecord: vi.fn(async () => undefined) }
  vi.resetModules()
  await import('../../preload/index')
  api = mocks.exposed.get('electronAPI') as ElectronAPI
})
afterEach(() => {
  vi.useRealTimers()
})

describe('onServerConnected (PRDCT-3526)', () => {
  it('bound before the server: heard at the first welcome, and again at each reconnection', async () => {
    answer({ 'server:endpoint': null })
    const heard = vi.fn()
    api.onServerConnected(heard)
    await settle()
    expect(heard).not.toHaveBeenCalled()
    await serverComes()
    // Announced, the socket still connecting: nothing yet.
    expect(heard).not.toHaveBeenCalled()
    mocks.push!.open()
    expect(heard).toHaveBeenCalledTimes(1)
    // The socket goes and comes back.
    for (const listener of [...mocks.push!.statuses]) listener('reconnecting', { attempt: 2 })
    expect(heard).toHaveBeenCalledTimes(1)
    for (const listener of [...mocks.push!.statuses]) listener('open', {})
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('bound once the connection is open: heard at once', async () => {
    await serverComes()
    mocks.push!.open()
    const heard = vi.fn()
    api.onServerConnected(heard)
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('released: never heard again, whether the server had come or not', async () => {
    answer({ 'server:endpoint': null })
    const early = vi.fn()
    api.onServerConnected(early)()
    await settle()
    await serverComes()
    mocks.push!.open()
    expect(early).not.toHaveBeenCalled()
    const late = vi.fn()
    const release = api.onServerConnected(late)
    expect(late).toHaveBeenCalledTimes(1)
    release()
    for (const listener of [...mocks.push!.statuses]) listener('open', {})
    expect(late).toHaveBeenCalledTimes(1)
  })

  it('a window whose server never comes never hears it', async () => {
    answer({ 'server:endpoint': null })
    const heard = vi.fn()
    api.onServerConnected(heard)
    await settle()
    expect(mocks.push).toBeNull()
    expect(heard).not.toHaveBeenCalled()
  })
})

describe("the record writes on the server's records and main's (wave 6, lane A)", () => {
  it('each write reaches the server, then main, whose folder the boot still lists', async () => {
    await serverComes()
    mocks.invoke.mockClear()
    await api.setSessionDisplayName('t', 'Mine', true)
    await api.setSessionViewRecord('t', { url: 'http://127.0.0.1:1', title: 'Page' })
    await api.setSessionWorkspace('t', 'ws-2')
    await api.setSessionClaudeSessionId('t', 'after-clear')
    expect(mocks.sessions.keepOnRecord.mock.calls).toEqual([
      ['t', { name: { displayName: 'Mine', userRenamed: true } }],
      ['t', { page: { url: 'http://127.0.0.1:1', title: 'Page' } }],
      ['t', { workspaceId: 'ws-2' }],
      ['t', { claudeSessionId: 'after-clear' }]
    ])
    const toMain = mocks.invoke.mock.calls.filter(([channel]) =>
      String(channel).startsWith('session:set-')
    )
    expect(toMain).toEqual([
      ['session:set-display-name', 't', 'Mine', true],
      ['session:set-view', 't', { url: 'http://127.0.0.1:1', title: 'Page' }],
      ['session:set-workspace', 't', 'ws-2'],
      ['session:set-claude-session-id', 't', 'after-clear']
    ])
  })
  it("a refusal from main never undoes the server's write", async () => {
    await serverComes()
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'server:endpoint') return endpoint
      if (channel.startsWith('session:set-')) throw new Error('main refused')
      return undefined
    })
    await expect(api.setSessionDisplayName('t', 'Mine', true)).resolves.toBeUndefined()
    expect(mocks.sessions.keepOnRecord).toHaveBeenCalledTimes(1)
  })
})
