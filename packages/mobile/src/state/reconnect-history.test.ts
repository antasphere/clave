import { expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { Drafts, MemoryKeyValueStore } from '../chat/drafts'
import { MemorySecureStore, SecureCredentialStore } from '../machines/credentials'
import type { PushSocketConstructor } from '../api/push'
import { createStore, conversationKey } from './store'

it('welcome refreshes open history only after the new subscription ack, without sending a draft', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing listener')
  const origin = `http://127.0.0.1:${address.port}`
  const peers = new Set<WebSocket>()
  let connections = 0
  let ackSecond: (() => void) | undefined
  const session = {
    id: 's',
    provider: 'echo',
    transport: 'events',
    cwd: '/tmp',
    windowKey: 'server',
    state: 'idle',
    createdAt: 1,
    adapterId: 'echo',
    title: 'Fixture'
  }
  server.on('connection', (socket) => {
    peers.add(socket)
    socket.on('close', () => peers.delete(socket))
    const generation = ++connections
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data)) as { _tag: string }
      if (frame._tag === 'hello')
        socket.send(
          JSON.stringify({ _tag: 'welcome', serverId: 'fixture', protocol: 1, version: 'test' })
        )
      if (frame._tag === 'subscribe') {
        const ack = (): void => {
          socket.send(JSON.stringify({ _tag: 'subscribed', sessionId: 's', session }))
        }
        if (generation === 1) ack()
        else ackSecond = ack
      }
      if (frame._tag === 'ping') socket.send(JSON.stringify({ _tag: 'pong' }))
    })
  })
  const kv = new MemoryKeyValueStore()
  const drafts = new Drafts(kv)
  const credentials = new SecureCredentialStore(new MemorySecureStore())
  await credentials.set('m', { serverUrl: origin, bearer: 'fixture' })
  await drafts.set('m', 's', 'ordinary unsent offline draft')
  let snapshots = 0
  let writes = 0
  const store = createStore({
    build: 'development',
    credentials,
    kv,
    drafts,
    sources: {
      developer: null,
      relay: {
        list: async () => [
          {
            id: 'm',
            name: 'Fixture',
            platform: 'unknown',
            version: '',
            online: true,
            lastSeen: null,
            baseUrl: origin,
            pushUrl: `${origin}/push`
          }
        ]
      }
    },
    clientName: 'fixture',
    pushOptions: {
      WebSocket: WebSocket as unknown as PushSocketConstructor,
      backoff: { baseMs: 1, maxMs: 5 }
    },
    clientOptions: {
      fetch: async (url, init) => {
        if (init.method === 'POST') writes++
        const timeline = new URL(url).pathname === '/sessions/timeline'
        if (timeline) snapshots++
        const position = { generation: 'g', sequence: snapshots }
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify(
              timeline
                ? {
                    items: [
                      {
                        event: {
                          type: 'assistant_text',
                          delta: snapshots === 1 ? 'before' : 'after reconnect',
                          final: false
                        },
                        position
                      }
                    ],
                    before: null,
                    cursor: position,
                    truncated: false
                  }
                : { revision: 1, pending: [] }
            )
        }
      }
    }
  })
  try {
    await store.getState().loadMachines()
    await store.getState().openChat('m', 's')
    expect(snapshots).toBe(1)
    for (const peer of peers) peer.close()
    await vi.waitFor(() => expect(ackSecond).toBeTypeOf('function'))
    expect(snapshots).toBe(1)
    ackSecond!()
    await vi.waitFor(() => expect(snapshots).toBe(2))
    const entries = store.getState().conversations[conversationKey('m', 's')]!.conversation.entries
    expect(JSON.stringify(entries)).toContain('after reconnect')
    expect(await drafts.get('m', 's')).toBe('ordinary unsent offline draft')
    expect(writes).toBe(0)
  } finally {
    store.getState().disconnectAll()
    for (const peer of peers) peer.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
