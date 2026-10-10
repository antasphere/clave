import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ElectronAPI } from '../../preload/index.d'
import type { SessionInput } from '../../shared/session-model'

/** The preload's router and its push listeners: every routed method goes over
 *  IPC while main knows no server, to the server (scoped to the window) once
 *  it does, and a server failure reaches the caller rather than IPC. The
 *  preload keeps module state (the backing, the subscriptions' transports,
 *  the refusal flag), so every test imports a fresh copy of it. */
type Listener = (...args: unknown[]) => void
type PushDouble = {
  connect: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  subscribe: ReturnType<typeof vi.fn>
  subscribed: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
  releases: Map<string, ReturnType<typeof vi.fn>[]>
  streams: Map<string, Set<Listener>>
  exits: Map<string, Set<Listener>>
  events: Set<Listener>
}
const mocks = vi.hoisted(() => {
  const state = {
    exposed: new Map<string, unknown>(),
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    apiList: vi.fn(),
    sessions: {} as Record<string, ReturnType<typeof vi.fn>>,
    createApiClient: vi.fn(),
    router: null as null | { reset: () => void },
    push: null as null | PushDouble,
    pushes: [] as PushDouble[],
    makePush: (): PushDouble => {
      const push: PushDouble = {
        connect: vi.fn(() => push),
        close: vi.fn(),
        releases: new Map(),
        streams: new Map(),
        exits: new Map(),
        events: new Set(),
        subscribe: vi.fn((id: string, onStream: Listener, onExit?: Listener) => {
          if (!push.streams.has(id)) push.streams.set(id, new Set())
          if (!push.exits.has(id)) push.exits.set(id, new Set())
          push.streams.get(id)!.add(onStream)
          if (onExit) push.exits.get(id)!.add(onExit)
          const release = vi.fn(() => {
            push.streams.get(id)?.delete(onStream)
            if (onExit) push.exits.get(id)?.delete(onExit)
          })
          push.releases.set(id, [...(push.releases.get(id) ?? []), release])
          return release
        }),
        subscribed: vi.fn(async (id: string) => ({ id, via: 'server' })),
        onEvent: vi.fn((listener: Listener) => {
          push.events.add(listener)
          return () => {
            push.events.delete(listener)
          }
        })
      }
      return push
    },
    /** A stream frame on the push double, to every listener of the session. */
    emitStream: (id: string, frame: unknown): void => {
      for (const listener of state.push?.streams.get(id) ?? []) listener(frame)
    },
    /** A server event on the push double, to every `onEvent` listener. */
    emitEvent: (event: Record<string, unknown>): void => {
      for (const listener of state.push?.events ?? []) listener({ event })
    }
  }
  return state
})
vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, value: unknown) => mocks.exposed.set(key, value)
  },
  ipcRenderer: {
    invoke: mocks.invoke,
    send: mocks.send,
    on: mocks.on,
    removeListener: mocks.removeListener
  },
  webUtils: {}
}))
vi.mock('@clave/client/router', async (importActual) => {
  const actual = await importActual<typeof import('@clave/client/router')>()
  return {
    ...actual,
    createMethodRouter: (options: Parameters<typeof actual.createMethodRouter>[0]) => {
      const router = actual.createMethodRouter(options)
      mocks.router = router
      return router
    }
  }
})
// The preload builds its backing through the Node transport
// (`@clave/client/node`, ADR 0003); the double hands back the mocked request
// client for the endpoint it was given, and a push double that records its
// listeners and never opens a socket.
vi.mock('@clave/client/node', () => ({
  connectThroughNode: async (endpoint: { url: string; token: string }) => {
    const push = mocks.makePush()
    mocks.push = push
    mocks.pushes.push(push)
    return { api: mocks.createApiClient(endpoint), push }
  }
}))

let api: ElectronAPI

const endpoint = { url: 'http://127.0.0.1:4242', token: 'secret', mode: 'in-process' }
const attachedEndpoint = { ...endpoint, mode: 'attached' }
const identity = { windowId: 1, windowKey: 'w-7', workspaceId: null, isPrimary: true }
const onServer = { 'server:endpoint': endpoint, 'window:identity': identity }
const answer = (table: Record<string, unknown>): void => {
  mocks.invoke.mockImplementation(async (channel: string) => {
    if (channel in table) {
      const value = table[channel]
      if (value instanceof Error) throw value
      return value
    }
    return undefined
  })
}
const channels = (): string[] => mocks.invoke.mock.calls.map(([c]) => c as string)
/** Lets the announce (a microtask queued by `connect`) and the dynamic import run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
}
/** A routed call that connects the backing, then the announce. A watch ask
 *  still in flight would answer this call with its own null endpoint, so it
 *  is let finish first. */
const connectBacking = async (): Promise<void> => {
  await settle()
  answer(onServer)
  await api.sessionsList()
  await settle()
  expect(mocks.push).not.toBeNull()
}

beforeEach(async () => {
  vi.clearAllMocks()
  // The preload asks for the endpoint as it loads (the terminal pane's
  // mode): a previous test's answer must not be what it hears.
  mocks.invoke.mockReset()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  delete process.env.CLAVE_SERVER_URL
  delete process.env.CLAVE_SERVER_TOKEN
  mocks.push = null
  mocks.pushes = []
  mocks.sessions = {
    list: mocks.apiList,
    write: vi.fn(async () => undefined),
    setView: vi.fn(async (id: string) => ({ id, via: 'server' })),
    models: vi.fn(async () => [{ id: 'm' }]),
    commands: vi.fn(async () => [{ name: 'c' }]),
    capabilities: vi.fn(async () => ({ images: true })),
    history: vi.fn(async () => ({ items: [], via: 'server' })),
    start: vi.fn(async () => ({ id: 'new', via: 'server' })),
    stop: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    listAdoptable: vi.fn(async () => [
      { id: 'own', windowKey: 'w-7' },
      { id: 'elsewhere', windowKey: 'other' }
    ]),
    discardRecord: vi.fn(async () => undefined)
  }
  mocks.createApiClient.mockImplementation(() => ({ sessions: mocks.sessions }))
  vi.resetModules()
  await import('../../preload/index')
  api = mocks.exposed.get('electronAPI') as ElectronAPI
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('the preload routes sessionsList', () => {
  it('goes over IPC while main has no server, and keeps going there', async () => {
    answer({ 'server:endpoint': null, 'sessions:list': [{ id: 'ipc' }] })
    expect(await api.sessionsList()).toEqual([{ id: 'ipc' }])
    expect(mocks.createApiClient).not.toHaveBeenCalled()
    // The preload asks for the endpoint once at its start too, for the
    // terminal pane's road (its mode), before any routed call.
    expect(channels().filter((c) => c !== 'server:endpoint')).toEqual(['sessions:list'])
    expect(channels()[0]).toBe('server:endpoint')
  })
  it('goes to the server, scoped to this window, once main names an endpoint', async () => {
    answer({ ...onServer, 'sessions:list': [{ id: 'ipc' }] })
    mocks.apiList.mockResolvedValue([{ id: 'server' }])
    expect(await api.sessionsList()).toEqual([{ id: 'server' }])
    expect(mocks.createApiClient).toHaveBeenCalledExactlyOnceWith(endpoint)
    expect(mocks.apiList).toHaveBeenCalledExactlyOnceWith('w-7')
    expect(channels()).not.toContain('sessions:list')
  })
  it('answers nothing for a window without a key, as IPC does', async () => {
    answer({ 'server:endpoint': endpoint, 'window:identity': null })
    expect(await api.sessionsList()).toEqual([])
    expect(mocks.apiList).not.toHaveBeenCalled()
  })
  it('lets the server’s failure through instead of falling back to IPC', async () => {
    answer({ ...onServer, 'sessions:list': [{ id: 'ipc' }] })
    mocks.apiList.mockRejectedValue(new Error('server down'))
    await expect(api.sessionsList()).rejects.toThrow('server down')
    expect(channels()).not.toContain('sessions:list')
  })
  it('never reads an endpoint from its own environment: main over IPC is the only source', async () => {
    process.env.CLAVE_SERVER_URL = 'http://127.0.0.1:9/outer'
    process.env.CLAVE_SERVER_TOKEN = 'outer'
    answer({ 'server:endpoint': null, 'sessions:list': [{ id: 'ipc' }] })
    expect(await api.sessionsList()).toEqual([{ id: 'ipc' }])
    expect(mocks.createApiClient).not.toHaveBeenCalled()
  })
  it('asks main again on the next call while there is no server yet', async () => {
    answer({ 'server:endpoint': null, 'sessions:list': [{ id: 'ipc' }] })
    expect(await api.sessionsList()).toEqual([{ id: 'ipc' }])
    answer(onServer)
    mocks.apiList.mockResolvedValue([{ id: 'server' }])
    expect(await api.sessionsList()).toEqual([{ id: 'server' }])
  })
})

describe('the preload routes the other session calls', () => {
  const bytes = new Uint8Array([104, 105])
  const typed = { type: 'interrupt' } as unknown as SessionInput
  const spawnOptions = { claudeMode: true, model: 'opus' }

  it('sends every session call over IPC, with its arguments, while main names no server', async () => {
    answer({ 'server:endpoint': null })
    await api.sessionsWrite('s1', bytes)
    await api.sessionsWrite('s1', typed)
    await api.sessionsSetView('s1', 'chat')
    await api.sessionsModels('s1')
    await api.sessionsCommands('s1')
    await api.sessionsCapabilities('s1')
    await api.sessionsHistory('s1', 40, 20)
    await api.spawnSession('/repo', spawnOptions)
    await api.killSession('s1')
    const ipc = mocks.invoke.mock.calls.filter(([c]) => c !== 'server:endpoint')
    expect(ipc).toEqual([
      ['sessions:write', 's1', bytes],
      ['sessions:write', 's1', typed],
      ['sessions:set-view', 's1', 'chat'],
      ['sessions:models', 's1'],
      ['sessions:commands', 's1'],
      ['sessions:capabilities', 's1'],
      ['sessions:history', 's1', 40, 20],
      ['pty:spawn', '/repo', spawnOptions],
      ['pty:kill', 's1']
    ])
    expect(mocks.createApiClient).not.toHaveBeenCalled()
  })

  it('sends every session call to the server’s api, with its arguments, once main names one', async () => {
    answer(onServer)
    await api.sessionsWrite('s1', bytes)
    await api.sessionsWrite('s1', typed)
    expect(await api.sessionsSetView('s1', 'chat')).toEqual({ id: 's1', via: 'server' })
    expect(await api.sessionsModels('s1')).toEqual([{ id: 'm' }])
    expect(await api.sessionsCommands('s1')).toEqual([{ name: 'c' }])
    expect(await api.sessionsCapabilities('s1')).toEqual({ images: true })
    expect(await api.sessionsHistory('s1', 40, 20)).toEqual({ items: [], via: 'server' })
    expect(await api.spawnSession('/repo', spawnOptions)).toEqual({ id: 'new', via: 'server' })
    await api.killSession('s1')

    expect(mocks.sessions.write.mock.calls).toEqual([
      ['s1', { type: 'bytes', data: bytes }],
      ['s1', typed]
    ])
    expect(mocks.sessions.setView).toHaveBeenCalledExactlyOnceWith('s1', 'chat')
    expect(mocks.sessions.models).toHaveBeenCalledExactlyOnceWith('s1')
    expect(mocks.sessions.commands).toHaveBeenCalledExactlyOnceWith('s1')
    expect(mocks.sessions.capabilities).toHaveBeenCalledExactlyOnceWith('s1')
    expect(mocks.sessions.history).toHaveBeenCalledExactlyOnceWith('s1', 40, 20)
    expect(mocks.sessions.start).toHaveBeenCalledExactlyOnceWith({
      cwd: '/repo',
      windowKey: 'w-7',
      options: spawnOptions
    })
    expect(mocks.sessions.stop).toHaveBeenCalledExactlyOnceWith('s1')
    expect(channels().filter((c) => c !== 'server:endpoint' && c !== 'window:identity')).toEqual([])
  })
})

describe('the terminal pane’s road', () => {
  const ipcSends = (): unknown[][] => mocks.send.mock.calls
  it('stays on IPC inside the app, with the server named and in-process', async () => {
    answer(onServer)
    await api.startSession('t1', 120, 40)
    await api.writeSession('t1', 'ls\r')
    await api.resizeSession('t1', 100, 30)
    expect(ipcSends()).toEqual([
      ['pty:start', 't1', 120, 40],
      ['pty:write', 't1', 'ls\r'],
      ['pty:resize', 't1', 100, 30]
    ])
    expect(mocks.sessions.resize).not.toHaveBeenCalled()
    expect(mocks.sessions.write).not.toHaveBeenCalled()
    // The pane's listeners hear IPC only: no push subscription is taken for
    // a terminal of the in-process app (its bytes would arrive twice).
    const data = vi.fn()
    api.onSessionData('t1', data)
    api.onSessionExit('t1', vi.fn())
    await connectBacking()
    expect(mocks.push!.subscribe).not.toHaveBeenCalled()
    expect(mocks.on.mock.calls.map(([c]) => c)).toContain('pty:data:t1')
  })
  it('goes to the attached server, the bytes in order, and hears the pty frames off the push channel', async () => {
    answer({ 'server:endpoint': attachedEndpoint, 'window:identity': identity })
    // A pane exists only after a session started through the server: that
    // routed call announces the server and the preload learns the mode.
    await api.sessionsList()
    await settle()
    const order: string[] = []
    let calls = 0
    mocks.sessions.write.mockImplementation(async (_id: string, input: { data: Uint8Array }) => {
      // The FIRST call answers last (20 ms), every later one at once: without
      // the per-session chain the second write would land first and the
      // order would read ['b', 'a'].
      const delay = ++calls === 1 ? 20 : 1
      await new Promise((resolve) => setTimeout(resolve, delay))
      order.push(new TextDecoder().decode(input.data))
    })
    const first = api.writeSession('t1', 'a')
    const second = api.writeSession('t1', 'b')
    const third = api.startSession('t1', 120, 40)
    await settle()
    await vi.advanceTimersByTimeAsync(100)
    await Promise.all([first, second, third])
    expect(order).toEqual(['a', 'b'])
    expect(mocks.sessions.resize).toHaveBeenCalledWith('t1', 120, 40)
    expect(ipcSends()).toEqual([])

    const data = vi.fn()
    const exit = vi.fn()
    api.onSessionData('t1', data)
    api.onSessionExit('t1', exit)
    await settle()
    expect(mocks.push!.subscribe).toHaveBeenCalled()
    // A character split across two frames is finished by the second.
    mocks.emitStream('t1', { kind: 'pty', data: new Uint8Array([0x68, 0xc3]) })
    mocks.emitStream('t1', { kind: 'pty', data: new Uint8Array([0xa9]) })
    mocks.emitStream('t1', { kind: 'event', event: { type: 'state_change', state: 'idle' } })
    expect(data.mock.calls.map(([d]) => d).join('')).toBe('hé')
    for (const listener of mocks.push!.exits.get('t1') ?? []) listener(0)
    expect(exit).toHaveBeenCalledWith(0)
  })
})

describe('the preload relays the server’s refusal', () => {
  const refusal = (): Error =>
    Object.assign(new Error('no terminal process on this server'), {
      _tag: 'CapabilityUnavailable',
      capability: 'terminal'
    })

  it('tells the listeners what was refused, still rejects, and clears it once on the next success', async () => {
    answer(onServer)
    const heard = vi.fn()
    api.onServerRefusal(heard)
    mocks.sessions.stop.mockRejectedValueOnce(refusal())
    await expect(api.killSession('s1')).rejects.toThrow('no terminal process on this server')
    expect(heard).toHaveBeenCalledExactlyOnceWith({
      capability: 'terminal',
      message: 'no terminal process on this server'
    })

    await api.killSession('s1')
    await api.sessionsModels('s1')
    expect(heard.mock.calls).toEqual([
      [{ capability: 'terminal', message: 'no terminal process on this server' }],
      [null]
    ])
  })

  it('tells nothing for a failure that is not a declared refusal', async () => {
    answer(onServer)
    const heard = vi.fn()
    api.onServerRefusal(heard)
    mocks.sessions.stop.mockRejectedValueOnce(new Error('server down'))
    await expect(api.killSession('s1')).rejects.toThrow('server down')
    await api.killSession('s1')
    expect(heard).not.toHaveBeenCalled()
  })

  it('tells a listener nothing once it is removed', async () => {
    answer(onServer)
    const kept = vi.fn()
    const removed = vi.fn()
    api.onServerRefusal(kept)
    const off = api.onServerRefusal(removed)
    off()
    mocks.sessions.stop.mockRejectedValueOnce(refusal())
    await expect(api.killSession('s1')).rejects.toThrow()
    await api.killSession('s1')
    expect(kept).toHaveBeenCalledTimes(2)
    expect(removed).not.toHaveBeenCalled()
  })
})

describe('a subscription is released on the transport it was taken on', () => {
  it('releases over IPC a subscription taken over IPC, after the server arrived', async () => {
    answer({ 'server:endpoint': null, 'sessions:subscribe': { id: 's1', via: 'ipc' } })
    expect(await api.sessionsSubscribe('s1')).toEqual({ id: 's1', via: 'ipc' })
    expect(channels()).toContain('sessions:subscribe')

    await connectBacking()
    mocks.invoke.mockClear()
    await api.sessionsUnsubscribe('s1')
    expect(mocks.invoke).toHaveBeenCalledWith('sessions:unsubscribe', 's1')
    expect(mocks.push!.subscribe).not.toHaveBeenCalled()
    expect(mocks.push!.releases.size).toBe(0)
  })

  it('takes the same subscription again over IPC while the first is held there', async () => {
    answer({ 'server:endpoint': null, 'sessions:subscribe': { id: 's1', via: 'ipc' } })
    await api.sessionsSubscribe('s1')
    await connectBacking()
    answer({ ...onServer, 'sessions:subscribe': { id: 's1', via: 'ipc' } })
    mocks.invoke.mockClear()

    expect(await api.sessionsSubscribe('s1')).toEqual({ id: 's1', via: 'ipc' })
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith('sessions:subscribe', 's1')
    expect(mocks.push!.subscribe).not.toHaveBeenCalled()

    await api.sessionsUnsubscribe('s1')
    expect(channels()).not.toContain('sessions:unsubscribe')
    await api.sessionsUnsubscribe('s1')
    expect(mocks.invoke).toHaveBeenLastCalledWith('sessions:unsubscribe', 's1')
  })

  it('releases on the push channel a subscription taken on the server, never over IPC', async () => {
    answer(onServer)
    expect(await api.sessionsSubscribe('s2')).toEqual({ id: 's2', via: 'server' })
    const push = mocks.push!
    expect(push.subscribe).toHaveBeenCalledOnce()
    expect(push.subscribe.mock.calls[0][0]).toBe('s2')
    expect(push.subscribed).toHaveBeenCalledExactlyOnceWith('s2')
    expect(channels()).not.toContain('sessions:subscribe')

    await api.sessionsUnsubscribe('s2')
    expect(push.releases.get('s2')![0]).toHaveBeenCalledOnce()
    expect(channels()).not.toContain('sessions:unsubscribe')
  })
})

describe('a session listener bound before the server arrives', () => {
  it('binds IPC at once and the push channel once a routed call connects', async () => {
    answer({ 'server:endpoint': null })
    const titles = vi.fn()
    const states = vi.fn()
    api.onSessionAutoTitle('s1', titles)
    api.onAgentState('s1', states)
    expect(mocks.on.mock.calls.map(([c]) => c)).toEqual(['session:auto-title:s1', 'agent:state:s1'])
    await settle()
    expect(mocks.push).toBeNull()

    await connectBacking()
    expect(mocks.push!.onEvent).toHaveBeenCalledTimes(2)
    mocks.emitEvent({ _tag: 'session.title_changed', id: 's1', title: 'Fix the build' })
    mocks.emitEvent({ _tag: 'session.title_changed', id: 'other', title: 'Not this one' })
    mocks.emitEvent({ _tag: 'session.state_changed', id: 's1', state: 'working' })
    mocks.emitEvent({ _tag: 'session.state_changed', id: 'other', state: 'idle' })
    expect(titles.mock.calls).toEqual([['Fix the build']])
    expect(states.mock.calls).toEqual([['working']])
  })

  it('is wired when the watch finds the server, with no routed call', async () => {
    answer({ 'server:endpoint': null })
    const titles = vi.fn()
    const states = vi.fn()
    api.onSessionAutoTitle('s1', titles)
    api.onAgentState('s1', states)
    await settle()
    expect(mocks.push).toBeNull()

    answer(onServer)
    await vi.advanceTimersByTimeAsync(2000)
    await settle()
    expect(mocks.push).not.toBeNull()
    expect(mocks.push!.connect).toHaveBeenCalled()
    mocks.emitEvent({ _tag: 'session.title_changed', id: 's1', title: 'Found by the watch' })
    mocks.emitEvent({ _tag: 'session.title_changed', id: 'other', title: 'Not this one' })
    mocks.emitEvent({ _tag: 'session.state_changed', id: 's1', state: 'idle' })
    expect(titles.mock.calls).toEqual([['Found by the watch']])
    expect(states.mock.calls).toEqual([['idle']])
  })
})

describe('a stream listener follows its subscription’s transport', () => {
  it('stays off the push channel for a session subscribed over IPC, before or after the backing', async () => {
    answer({ 'server:endpoint': null, 'sessions:subscribe': { id: 's1', via: 'ipc' } })
    await api.sessionsSubscribe('s1')
    const early = vi.fn()
    api.onSessionStream('s1', early)
    api.onSessionStreamExit('s1', vi.fn())
    await connectBacking()
    const late = vi.fn()
    api.onSessionStream('s1', late)
    await settle()
    expect(mocks.push!.subscribe).not.toHaveBeenCalled()
    expect(mocks.on.mock.calls.map(([c]) => c)).toEqual([
      'sessions:stream:s1',
      'sessions:exit:s1',
      'sessions:stream:s1'
    ])
  })

  it('stays off the push channel for an IPC subscription still in flight when the server is announced', async () => {
    // The IPC answer is held: the server arrives in the middle of the round trip.
    let answerSubscribe: (session: unknown) => void = () => {}
    const held = new Promise((resolve) => {
      answerSubscribe = resolve
    })
    mocks.invoke.mockImplementation(async (channel: string) => {
      if (channel === 'server:endpoint') return null
      if (channel === 'sessions:subscribe') return held
      return undefined
    })
    const subscribing = api.sessionsSubscribe('s1')
    api.onSessionStream('s1', vi.fn())
    await connectBacking()
    answerSubscribe({ id: 's1', via: 'ipc' })
    await subscribing
    await settle()
    expect(mocks.push!.subscribe).not.toHaveBeenCalled()
    await api.sessionsUnsubscribe('s1')
    expect(channels()).toContain('sessions:unsubscribe')
  })

  it('binds the push channel for a session subscribed on the server', async () => {
    answer(onServer)
    await api.sessionsSubscribe('s2')
    const frames = vi.fn()
    api.onSessionStream('s2', frames)
    const push = mocks.push!
    expect(push.subscribe).toHaveBeenCalledTimes(2)
    expect(push.subscribe.mock.calls[1]).toEqual(['s2', frames])
    mocks.emitStream('s2', { kind: 'frame' })
    expect(frames).toHaveBeenCalledExactlyOnceWith({ kind: 'frame' })
  })
})

describe('unbinding a session listener', () => {
  it('removes the IPC listener and the push listener', async () => {
    await connectBacking()
    const titles = vi.fn()
    const off = api.onSessionAutoTitle('s1', titles)
    expect(mocks.push!.events.size).toBe(1)
    const [channel, bound] = mocks.on.mock.calls[0]
    expect(channel).toBe('session:auto-title:s1')

    off()
    expect(mocks.removeListener).toHaveBeenCalledExactlyOnceWith('session:auto-title:s1', bound)
    expect(mocks.push!.events.size).toBe(0)
    mocks.emitEvent({ _tag: 'session.title_changed', id: 's1', title: 'Too late' })
    expect(titles).not.toHaveBeenCalled()
  })

  it('never wires a listener withdrawn before the server arrives', async () => {
    answer({ 'server:endpoint': null })
    const titles = vi.fn()
    const off = api.onSessionAutoTitle('s1', titles)
    off()
    expect(mocks.removeListener).toHaveBeenCalledWith('session:auto-title:s1', expect.any(Function))

    await connectBacking()
    expect(mocks.push!.onEvent).not.toHaveBeenCalled()
    mocks.emitEvent({ _tag: 'session.title_changed', id: 's1', title: 'Too late' })
    expect(titles).not.toHaveBeenCalled()
  })
})

describe('the preload routes the session records', () => {
  const scope = { windowKey: 'w-7', primary: true, knownWindowKeys: ['w-7', 'other'] }
  const connectAttached = async (): Promise<void> => {
    await settle()
    answer({ ...onServer, 'server:endpoint': attachedEndpoint })
    await api.sessionsList()
    await settle()
  }

  it('reads records over IPC inside the app, the selection rule main’s', async () => {
    answer(onServer)
    await api.listSessionRecords()
    expect(channels()).toContain('records:list-adoptable')
    expect(mocks.sessions.listAdoptable).not.toHaveBeenCalled()
  })

  it('reads the server’s records attached, and applies the window’s selection rule here', async () => {
    await connectAttached()
    answer({ ...onServer, 'server:endpoint': attachedEndpoint, 'records:adoption-scope': scope })
    const records = await api.listSessionRecords()
    // The orphan rule dropped the record of another live window.
    expect(records.map((r) => r.id)).toEqual(['own'])
    expect(mocks.sessions.listAdoptable.mock.calls[0]).toEqual([])
  })

  it('reads by id attached without the selection rule: the re-home wants exactly those', async () => {
    await connectAttached()
    answer({ ...onServer, 'server:endpoint': attachedEndpoint, 'records:adoption-scope': scope })
    mocks.sessions.listAdoptable.mockResolvedValueOnce([{ id: 'x', windowKey: 'whatever' }])
    const records = await api.listSessionRecords({ ids: ['x'] })
    expect(records.map((r) => r.id)).toEqual(['x'])
    expect(mocks.sessions.listAdoptable).toHaveBeenCalledWith(['x'])
    expect(channels()).not.toContain('records:adoption-scope')
  })

  it('discards over IPC inside the app and through the server attached', async () => {
    answer(onServer)
    await api.discardSessionRecord('clave-r1')
    expect(channels()).toContain('records:discard')
    await connectAttached()
    await api.discardSessionRecord('clave-r2')
    expect(mocks.sessions.discardRecord).toHaveBeenCalledWith('clave-r2')
  })
})
