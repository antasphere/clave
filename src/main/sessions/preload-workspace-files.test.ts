/**
 * The preload's workspace files section: a read routed through the server
 * waits for the push WELCOME before it goes out (a review published before
 * this window listens would wait for an answer nobody can give), the review
 * the server publishes with this window's requestId is shown through the
 * shell's dialog and answered on the server, and a watch taken over IPC
 * before the server was named moves to the server under the server's holder
 * name while the IPC name is released. Round 1 of the lane's verifier
 * dropped the welcome wait and nothing went red; this is the pin. The
 * doubles are those of `preload-routing.test.ts`.
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
  open: () => void
}
const mocks = vi.hoisted(() => {
  const state = {
    exposed: new Map<string, unknown>(),
    invoke: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    files: {} as Record<string, ReturnType<typeof vi.fn>>,
    push: null as null | PushDouble,
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
        onStatus: vi.fn(() => () => {}),
        events: new Set(),
        open: () => {
          push.status = 'open'
          resolveOpen()
        }
      }
      return push
    },
    emitEvent: (event: Record<string, unknown>): void => {
      for (const listener of state.push?.events ?? []) listener({ id: 'e', seq: 1, at: 0, event })
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
    return { api: { workspaceFiles: mocks.files }, push }
  }
}))

let api: ElectronAPI
const endpoint = { url: 'http://127.0.0.1:4242', token: 'secret' }
const answer = (table: Record<string, unknown>): void => {
  mocks.invoke.mockImplementation(async (channel: string) => table[channel])
}
const calls = (channel: string): unknown[][] =>
  mocks.invoke.mock.calls.filter(([c]) => c === channel).map((c) => c.slice(1))
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.push = null
  mocks.files = {
    read: vi.fn(async () => ({
      type: 'single',
      name: 'R',
      cwd: '/w',
      color: null,
      sessions: [],
      terminals: []
    })),
    answerReview: vi.fn(async () => undefined),
    watch: vi.fn(async () => undefined),
    unwatch: vi.fn(async () => undefined)
  }
  vi.resetModules()
  await import('../../preload/index')
  api = mocks.exposed.get('electronAPI') as ElectronAPI
})
afterEach(() => {
  vi.useRealTimers()
})

describe('a .clave read through the server', () => {
  it('waits for the push welcome before the read goes out, and sends its requestId', async () => {
    answer({ 'server:endpoint': endpoint })
    const reading = api.readClaveFile('/w/a.clave', '/w')
    await settle()
    expect(mocks.push).not.toBeNull()
    expect(mocks.push!.connect).toHaveBeenCalled()
    expect(mocks.push!.whenOpen).toHaveBeenCalled()
    expect(mocks.files.read).not.toHaveBeenCalled()
    mocks.push!.open()
    await settle()
    expect(mocks.files.read).toHaveBeenCalledTimes(1)
    const [path, options] = mocks.files.read.mock.calls[0] as [
      string,
      { rootDir?: string; requestId?: string }
    ]
    expect(path).toBe('/w/a.clave')
    expect(options.rootDir).toBe('/w')
    expect(typeof options.requestId).toBe('string')
    expect(await reading).toMatchObject({ name: 'R' })
  })

  it('shows the shell’s dialog for its own review and answers the server; another window’s review is left alone', async () => {
    answer({
      'server:endpoint': endpoint,
      'clave:review-dialog': { response: 0, checkboxChecked: true }
    })
    let release: (value: unknown) => void = () => {}
    mocks.files.read = vi.fn(() => new Promise((r) => (release = r)))
    const reading = api.readClaveFile('/w/e.clave')
    await settle()
    mocks.push!.open()
    await settle()
    const { requestId } = mocks.files.read.mock.calls[0][1] as { requestId: string }
    const review = {
      _tag: 'workspace_files.review_needed',
      reviewId: 'rev-1',
      requestId,
      path: '/w/e.clave',
      folder: '/w',
      autoCommands: ['npm run dev'],
      prompts: ['P'],
      dangerous: false
    }
    mocks.emitEvent({ ...review, reviewId: 'other', requestId: 'somebody-else' })
    mocks.emitEvent(review)
    await settle()
    expect(calls('clave:review-dialog')).toEqual([
      [
        {
          path: '/w/e.clave',
          folder: '/w',
          autoCommands: ['npm run dev'],
          prompts: ['P'],
          dangerous: false
        }
      ]
    ])
    expect(mocks.files.answerReview).toHaveBeenCalledExactlyOnceWith('rev-1', {
      response: 0,
      checkboxChecked: true
    })
    release(null)
    expect(await reading).toBeNull()
  })
})

describe('a .clave watch', () => {
  it('taken over IPC before the server was named moves to the server under the server’s name, the IPC name released', async () => {
    answer({ 'server:endpoint': null })
    await api.watchClaveFile('/w/a.clave')
    const ipcWatch = calls('clave:watch-file')
    expect(ipcWatch).toHaveLength(1)
    const [, ipcHolder] = ipcWatch[0] as [string, string]
    expect(ipcHolder).toMatch(/^ipc:/)
    // The server comes: a routed call connects the backing and announces it.
    answer({ 'server:endpoint': endpoint })
    await api.claveFileExists('/w/a.clave').catch(() => undefined)
    await settle()
    mocks.push?.open()
    await settle()
    expect(mocks.files.watch).toHaveBeenCalledExactlyOnceWith(
      '/w/a.clave',
      `server:${ipcHolder.slice(4)}`
    )
    expect(calls('clave:unwatch-file')).toEqual([['/w/a.clave', ipcHolder]])
    // Released where it is held now: on the server.
    await api.unwatchClaveFile('/w/a.clave')
    expect(mocks.files.unwatch).toHaveBeenCalledExactlyOnceWith(
      '/w/a.clave',
      `server:${ipcHolder.slice(4)}`
    )
    expect(calls('clave:unwatch-file')).toHaveLength(1)
  })
})
