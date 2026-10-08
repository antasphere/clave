import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiClient, PushClient, type PushSocketConstructor } from '@clave/client'
// The host's neighbours that reach the PTY backend and Electron: nothing here
// names a tab or looks a window up.
vi.mock('../title-generator', () => ({ notifyChatMessage: vi.fn() }))
vi.mock('../sessions/lifecycle', () => ({
  spawnSession: vi.fn(),
  stopSession: vi.fn(),
  trackInput: vi.fn()
}))
import { WebSocket } from 'ws'
import type { Session } from '../../shared/session-model'
import { SessionManager } from '../sessions/session-manager'
import { EchoAdapter } from '../sessions/adapters/echo-adapter'
import { createSessionHost, type SessionLifecycle } from '../sessions/host'
import { getClaveServerEndpoint, startClaveServer, stopClaveServer } from './clave-server'
import { hasServerEventPublisher } from './session-events'

const Socket = WebSocket as unknown as PushSocketConstructor
const record = (id: string, windowKey = 'w1'): Session => ({
  id,
  provider: 'echo',
  transport: 'events' as const,
  cwd: '/project',
  windowKey,
  state: 'idle' as const,
  createdAt: 1,
  adapterId: 'echo',
  title: id
})
const lifecycle: SessionLifecycle = {
  spawn: async (_windowKey, cwd) => ({
    id: 'spawned',
    cwd,
    folderName: cwd.split('/').pop() ?? cwd,
    alive: true,
    claudeSessionId: null,
    piSessionId: null
  }),
  stop: async () => {}
}
const hostOver = (manager: SessionManager): ReturnType<typeof createSessionHost> =>
  createSessionHost({ manager, lifecycle })

afterEach(async () => {
  await stopClaveServer()
})

describe('the server started by the shell', () => {
  it('publishes its address over the endpoint, once, and never into the environment', async () => {
    const manager = new SessionManager()
    const before = { ...process.env }
    const options = { manager, ports: { sessions: hostOver(manager) } }
    const first = await startClaveServer(options)
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(getClaveServerEndpoint()).toEqual(first)
    expect(process.env.CLAVE_SERVER_URL).toBe(before.CLAVE_SERVER_URL)
    expect(process.env.CLAVE_SERVER_TOKEN).toBe(before.CLAVE_SERVER_TOKEN)
    expect(await startClaveServer(options)).toEqual(first)
    await stopClaveServer()
    expect(getClaveServerEndpoint()).toBeNull()
  })
  it('two concurrent starts share one server', async () => {
    const manager = new SessionManager()
    const options = { manager, ports: { sessions: hostOver(manager) } }
    const [a, b] = await Promise.all([startClaveServer(options), startClaveServer(options)])
    expect(a).toEqual(b)
    expect(getClaveServerEndpoint()).toEqual(a)
    await stopClaveServer()
    // Nothing listens there any more: the one server stopped is the one started.
    await expect(fetch(`${a.url}/health/live`)).rejects.toThrow()
  })
  it('a stop during a start in flight leaves nothing listening', async () => {
    const manager = new SessionManager()
    const starting = startClaveServer({ manager, ports: { sessions: hostOver(manager) } })
    await stopClaveServer()
    const started = await starting
    expect(getClaveServerEndpoint()).toBeNull()
    await expect(fetch(`${started.url}/health/live`)).rejects.toThrow()
  })
  it('stopping removes the listener it put on the manager, and the event publisher', async () => {
    const manager = new SessionManager()
    const listeners = (): number => (manager as unknown as { all: Set<unknown> }).all.size
    const idle = listeners()
    expect(hasServerEventPublisher()).toBe(false)
    await startClaveServer({ manager, ports: { sessions: hostOver(manager) } })
    expect(listeners()).toBe(idle + 1)
    expect(hasServerEventPublisher()).toBe(true)
    await stopClaveServer()
    expect(listeners()).toBe(idle)
    expect(hasServerEventPublisher()).toBe(false)
  })
  it('answers the manager’s sessions over HTTP and their state changes over the push channel', async () => {
    const manager = new SessionManager()
    const adapter = new EchoAdapter()
    manager.registerAdapter(adapter)
    manager.adopt(record('a'), adapter.prepare(record('a')), adapter)
    const endpoint = await startClaveServer({ manager, ports: { sessions: hostOver(manager) } })
    const api = createApiClient(endpoint)
    expect((await api.sessions.list()).map((s) => s.id)).toEqual(['a'])
    const push = new PushClient({ ...endpoint, WebSocket: Socket }).connect()
    await push.whenOpen()
    const states: string[] = []
    const streamed: string[] = []
    push.onEvent((envelope) => {
      if (envelope.event._tag === 'session.state_changed') states.push(envelope.event.state)
    })
    push.subscribe('a', (stream) => {
      if (stream.kind === 'event') streamed.push(stream.event.type)
    })
    const subscribed = await push.subscribed('a')
    expect(subscribed.id).toBe('a')
    await api.sessions.write('a', { type: 'user_message', text: 'hello' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(states).toEqual(['working', 'done'])
    expect(streamed).toContain('assistant_text')
    push.close()
    await api.dispose()
    manager.kill('a')
  })
  it('starts and stops a session through the host it was given', async () => {
    const manager = new SessionManager()
    const stopped: string[] = []
    const host = createSessionHost({
      manager,
      lifecycle: {
        ...lifecycle,
        stop: async (id) => {
          stopped.push(id)
        }
      }
    })
    const endpoint = await startClaveServer({ manager, ports: { sessions: host } })
    const api = createApiClient(endpoint)
    const info = await api.sessions.start({ cwd: '/work/app', windowKey: 'w1' })
    expect(info).toMatchObject({ id: 'spawned', cwd: '/work/app', folderName: 'app', alive: true })
    await api.sessions.stop('spawned')
    expect(stopped).toEqual(['spawned'])
    await api.dispose()
  })
})
