/**
 * The preload's server-event listeners, bound BEFORE main names the server
 * (wave 4, lane B, PRDCT-3295): each family hears IPC while there is no
 * server, binds its push side the moment the server is announced, reads its
 * read model off the server at the welcome and hears the push channel from
 * then on; a listener released before the server comes leaves nothing bound.
 * Before this lane every listener asked the router once at bind time, was
 * told null, and stayed on IPC for the rest of the window's life. The
 * doubles are those of `preload-workspace-files.test.ts`.
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
    return { api: { settings: mocks.settings }, push }
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
/** The IPC listener main would send on, as the preload bound it. */
const ipcListenerOn = (channel: string): ((event: unknown, ...args: unknown[]) => void) => {
  const found = mocks.on.mock.calls.filter(([c]) => c === channel).at(-1)?.[1]
  if (typeof found !== 'function') throw new Error(`no IPC listener bound on ${channel}`)
  return found as (event: unknown, ...args: unknown[]) => void
}
const ipcListenersOn = (channel: string): number =>
  mocks.on.mock.calls.filter(([c]) => c === channel).length -
  mocks.removeListener.mock.calls.filter(([c]) => c === channel).length
/** The server comes: a routed call connects the backing and announces it. */
const serverComes = async (): Promise<void> => {
  answer({ 'server:endpoint': endpoint })
  await api.claudeAccountsList().catch(() => undefined)
  await settle()
  expect(mocks.push).not.toBeNull()
}

const account = (id: string): Record<string, unknown> => ({
  id,
  label: id,
  hasToken: false,
  tokenSetAt: null,
  tokenExpiresAt: null,
  tokenInvalid: false
})
const job = (id: string): Record<string, unknown> => ({
  id,
  provider: 'claude',
  accountId: 'a1',
  status: 'running',
  url: null,
  awaitingCode: false,
  message: null,
  startedAt: 1
})
const read = (n: number): Record<string, unknown> => ({ windows: [], fetchedAt: n })

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.push = null
  mocks.settings = {
    claudeAccounts: { list: vi.fn(async () => [account('server-a')]) },
    codexAccounts: { list: vi.fn(async () => [{ id: 'server-c', label: 'C', kind: 'chatgpt' }]) },
    logins: { list: vi.fn(async () => [job('j-server')]) },
    usage: {
      claudeSnapshot: vi.fn(async () => ({ 'server-a': read(1) })),
      codexSnapshot: vi.fn(async () => ({ 'server-c': read(2) }))
    },
    antasphere: { status: vi.fn(async () => ({ phase: 'signed-out', fromServer: true })) },
    workspaces: {
      load: vi.fn(async () => ({
        version: 1,
        workspaces: [{ id: 'w-server' }],
        lastActiveWorkspaceId: null,
        activeWorkspaceId: null,
        pins: [{ id: 'p-server' }],
        pinsMigrated: true
      }))
    }
  }
  vi.resetModules()
  await import('../../preload/index')
  api = mocks.exposed.get('electronAPI') as ElectronAPI
})
afterEach(() => {
  vi.useRealTimers()
})

/** One family: the listener, its IPC channel and what main sends on it, the
 *  server event and what the callback gets for it, the catch-up value. */
type Family = {
  name: string
  bind: (callback: (value: unknown) => void) => () => void
  channel: string
  ipcArgs: unknown[]
  ipcValue: unknown
  event: Record<string, unknown>
  pushValue: unknown
  catchUp: unknown[]
}
const families: Family[] = [
  {
    name: 'the Claude accounts',
    bind: (cb) => api.onClaudeAccountsChanged(cb),
    channel: 'claude-accounts:changed',
    ipcArgs: [[account('main-a')]],
    ipcValue: [account('main-a')],
    event: { _tag: 'accounts.claude_changed', accounts: [account('pushed-a')] },
    pushValue: [account('pushed-a')],
    catchUp: [[account('server-a')]]
  },
  {
    name: 'the Codex accounts',
    bind: (cb) => api.onCodexAccountsChanged(cb),
    channel: 'codex-accounts:changed',
    ipcArgs: [[{ id: 'main-c' }]],
    ipcValue: [{ id: 'main-c' }],
    event: {
      _tag: 'accounts.codex_changed',
      accounts: [{ id: 'pushed-c', label: 'C', kind: 'chatgpt' }]
    },
    pushValue: [{ id: 'pushed-c', label: 'C', kind: 'chatgpt' }],
    catchUp: [[{ id: 'server-c', label: 'C', kind: 'chatgpt' }]]
  },
  {
    name: 'the login progress',
    bind: (cb) => api.onAccountLoginProgress(cb),
    channel: 'accounts:login-progress',
    ipcArgs: [job('j-main')],
    ipcValue: job('j-main'),
    event: { _tag: 'accounts.login_progressed', job: job('j-pushed') },
    pushValue: job('j-pushed'),
    catchUp: [job('j-server')]
  },
  {
    name: 'the Claude usage',
    bind: (cb) => api.onClaudeAccountUsage(cb),
    channel: 'usage:claude-account',
    ipcArgs: [{ accountId: 'main-a', result: read(0) }],
    ipcValue: { accountId: 'main-a', result: read(0) },
    event: { _tag: 'usage.claude_read', accountId: 'pushed-a', result: read(3) },
    pushValue: { accountId: 'pushed-a', result: read(3) },
    catchUp: [{ accountId: 'server-a', result: read(1) }]
  },
  {
    name: 'the Codex usage',
    bind: (cb) => api.onCodexAccountUsage(cb),
    channel: 'usage:codex-account',
    ipcArgs: [{ accountId: 'main-c', result: read(0) }],
    ipcValue: { accountId: 'main-c', result: read(0) },
    event: { _tag: 'usage.codex_read', accountId: 'pushed-c', result: read(4) },
    pushValue: { accountId: 'pushed-c', result: read(4) },
    catchUp: [{ accountId: 'server-c', result: read(2) }]
  },
  {
    name: 'the Antasphere account',
    bind: (cb) => api.onAntasphereAccountChanged(cb),
    channel: 'antasphere-account:changed',
    ipcArgs: [{ phase: 'signed-out', from: 'main' }],
    ipcValue: { phase: 'signed-out', from: 'main' },
    event: { _tag: 'accounts.antasphere_changed', status: { phase: 'signed-in', from: 'push' } },
    pushValue: { phase: 'signed-in', from: 'push' },
    catchUp: [{ phase: 'signed-out', fromServer: true }]
  },
  {
    name: 'the workspace state',
    bind: (cb) => api.onWorkspaceStateChanged(cb),
    channel: 'workspace:state-changed',
    ipcArgs: [{ workspaces: [{ id: 'w-main' }], pins: [] }],
    ipcValue: { workspaces: [{ id: 'w-main' }], pins: [] },
    event: {
      _tag: 'workspaces.state_changed',
      workspaces: [{ id: 'w-pushed' }],
      pins: [{ id: 'p-pushed' }],
      origin: 'another-window'
    },
    pushValue: { workspaces: [{ id: 'w-pushed' }], pins: [{ id: 'p-pushed' }] },
    catchUp: [{ workspaces: [{ id: 'w-server' }], pins: [{ id: 'p-server' }] }]
  },
  {
    name: 'the .clave file changes',
    bind: (cb) => api.onClaveFileChanged(cb as (path: string) => void),
    channel: 'clave:file-changed',
    ipcArgs: ['/w/main.clave'],
    ipcValue: '/w/main.clave',
    event: { _tag: 'workspace_files.changed', path: '/w/pushed.clave' },
    pushValue: '/w/pushed.clave',
    catchUp: []
  }
]

describe.each(families)('$name, bound before the server was named', (family) => {
  it('hears IPC meanwhile, the server at the welcome, then the push channel only', async () => {
    answer({ 'server:endpoint': null })
    const heard: unknown[] = []
    const off = family.bind((value) => heard.push(value))
    await settle()
    expect(mocks.push).toBeNull()
    ipcListenerOn(family.channel)({}, ...family.ipcArgs)
    expect(heard).toEqual([family.ipcValue])

    await serverComes()
    // Announced but not welcomed: still on IPC, a push frame does not count.
    mocks.emitEvent(family.event)
    expect(heard).toEqual([family.ipcValue])
    mocks.push!.open()
    await settle()
    // The welcome: IPC dropped, the server's read model delivered.
    expect(ipcListenersOn(family.channel)).toBe(0)
    expect(heard).toEqual([family.ipcValue, ...family.catchUp])
    mocks.emitEvent(family.event)
    await settle()
    expect(heard).toEqual([family.ipcValue, ...family.catchUp, family.pushValue])
    off()
    expect(mocks.push!.events.size).toBe(0)
  })

  it('released before the server comes, leaves nothing bound when it does', async () => {
    answer({ 'server:endpoint': null })
    const heard: unknown[] = []
    family.bind((value) => heard.push(value))()
    await settle()
    expect(ipcListenersOn(family.channel)).toBe(0)
    await serverComes()
    mocks.push!.open()
    await settle()
    mocks.emitEvent(family.event)
    await settle()
    expect(heard).toEqual([])
    expect(mocks.push!.events.size).toBe(0)
    expect(mocks.push!.statuses.size).toBe(0)
  })
})

describe('the catch-up read', () => {
  it('is dropped when the server refuses it, and the push channel is heard regardless', async () => {
    // A standalone server carries no login job: its list is refused.
    mocks.settings.logins.list = vi.fn(async () => {
      throw new Error('This server runs no login.')
    })
    answer({ 'server:endpoint': null })
    const heard: unknown[] = []
    api.onAccountLoginProgress((value) => heard.push(value))
    await settle()
    await serverComes()
    mocks.push!.open()
    await settle()
    expect(mocks.settings.logins.list).toHaveBeenCalledTimes(1)
    expect(heard).toEqual([])
    mocks.emitEvent({ _tag: 'accounts.login_progressed', job: job('j-pushed') })
    expect(heard).toEqual([job('j-pushed')])
  })

  it('is not made for a listener bound once the socket is already open', async () => {
    await serverComes()
    mocks.push!.open()
    await settle()
    const heard: unknown[] = []
    api.onClaudeAccountsChanged((value) => heard.push(value))
    await settle()
    // The one read is the routed call that connected the backing.
    expect(mocks.settings.claudeAccounts.list).toHaveBeenCalledTimes(1)
    expect(heard).toEqual([])
    expect(ipcListenersOn('claude-accounts:changed')).toBe(0)
  })

  it('bypasses the window’s own-echo filter: the server’s state is never its echo', async () => {
    answer({ 'server:endpoint': null, 'window:identity': { windowKey: 'me' } })
    const heard: unknown[] = []
    api.onWorkspaceStateChanged((value) => heard.push(value))
    await settle()
    await serverComes()
    mocks.push!.open()
    await settle()
    expect(heard).toEqual([{ workspaces: [{ id: 'w-server' }], pins: [{ id: 'p-server' }] }])
    mocks.emitEvent({ _tag: 'workspaces.state_changed', workspaces: [], pins: [], origin: 'me' })
    expect(heard).toHaveLength(1)
  })
})
