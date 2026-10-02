import { afterEach, describe, expect, it } from 'vitest'
import { createApiClient, PushClient, type PushSocketConstructor } from '@clave/client'
import { WebSocket } from 'ws'
import type { Session } from '../../shared/session-model'
import { SessionManager } from '../sessions/session-manager'
import { EchoAdapter } from '../sessions/adapters/echo-adapter'
import {
  getClaveServerEndpoint,
  sessionSourceFromManager,
  startClaveServer,
  stopClaveServer
} from './clave-server'

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

afterEach(async () => {
  await stopClaveServer()
})

describe('the session manager as the server’s session source', () => {
  it('lists per window, hands out records, and strips a prepared prompt from a write', () => {
    const manager = new SessionManager()
    const adapter = new EchoAdapter()
    manager.registerAdapter(adapter)
    manager.adopt(record('a'), adapter.prepare(record('a')), adapter)
    manager.adopt(record('b', 'w2'), adapter.prepare(record('b', 'w2')), adapter)
    const source = sessionSourceFromManager(manager)
    expect(
      source
        .list()
        .map((s) => s.id)
        .sort()
    ).toEqual(['a', 'b'])
    expect(source.list('w2').map((s) => s.id)).toEqual(['b'])
    expect(source.get('a')?.title).toBe('a')
    expect(source.get('zz')).toBeUndefined()
    const seen: unknown[] = []
    const off = source.subscribe('a', (stream) => seen.push(stream))
    source.write('a', {
      type: 'user_message',
      text: 'hi',
      prepared: { text: 'never this', images: [] }
    })
    expect(seen[0]).toEqual({ kind: 'event', event: { type: 'user_message', text: 'hi' } })
    off()
    expect(() => source.subscribe('zz', () => {})).toThrow('Unknown session')
    manager.kill('a')
    manager.kill('b')
  })
})

describe('the server started by the shell', () => {
  it('publishes its address over the endpoint and the environment, once', async () => {
    const env: NodeJS.ProcessEnv = {}
    const manager = new SessionManager()
    const first = await startClaveServer({ manager, env })
    expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(env.CLAVE_SERVER_URL).toBe(first.url)
    expect(env.CLAVE_SERVER_TOKEN).toBe(first.token)
    expect(getClaveServerEndpoint()).toEqual(first)
    expect(await startClaveServer({ manager, env })).toEqual(first)
    await stopClaveServer(env)
    expect(getClaveServerEndpoint()).toBeNull()
    expect(env.CLAVE_SERVER_URL).toBeUndefined()
  })
  it('answers the manager’s sessions over HTTP and their state changes over the push channel', async () => {
    const manager = new SessionManager()
    const adapter = new EchoAdapter()
    manager.registerAdapter(adapter)
    manager.adopt(record('a'), adapter.prepare(record('a')), adapter)
    const endpoint = await startClaveServer({ manager, env: {} })
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
    await new Promise((resolve) => setTimeout(resolve, 50))
    await api.sessions.write('a', { type: 'user_message', text: 'hello' })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(states).toEqual(['working', 'done'])
    expect(streamed).toContain('assistant_text')
    push.close()
    await api.dispose()
    manager.kill('a')
  })
})
