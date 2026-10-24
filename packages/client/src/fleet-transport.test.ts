/** Real authenticated HTTP/WebSocket peers on held ephemeral loopback ports.
 * No desktop, personal account, persistent server, or running agent is used. */
import { afterEach, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { startEmbedded, type EmbeddedServer } from '@clave/server'
import { FakeSource, aSession, sleep } from '@clave/server/test-support'
import type { SessionStream } from '@clave/contract/sessions'
import { createApiClient } from './api'
import { PushClient, type PushSocketConstructor } from './push-client'
import { createFleetClient, type FleetClient } from './fleet'
import type { ServerEventEnvelope } from '@clave/contract/events'
import type { Sourced } from '../../contract/src/fleet'

const servers: EmbeddedServer[] = []
const clients: FleetClient[] = []
const until = async (check: () => boolean): Promise<void> => {
  const end = Date.now() + 5000
  while (!check()) {
    if (Date.now() > end) throw new Error('Fleet condition did not settle')
    await sleep(10)
  }
}
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await Promise.all(servers.splice(0).map((server) => server.stop()))
})

it('isolates colliding sessions, rejected tokens, outage/recovery and intentional disconnect', async () => {
  const sourceA = new FakeSource({ ...aSession('same'), title: 'Server A' })
  const sourceB = new FakeSource({ ...aSession('same'), title: 'Server B' })
  const a = await startEmbedded({ ports: { sessions: sourceA } })
  const b = await startEmbedded({ ports: { sessions: sourceB } })
  servers.push(a, b)
  const endpoints = { a, b, wrong: { url: a.url, token: 'wrong-token' } }
  const client = createFleetClient({
    resolve: async (id) => endpoints[id as keyof typeof endpoints],
    connect: (endpoint) => ({
      api: createApiClient({ ...endpoint, timeoutMs: 500 }),
      push: new PushClient({
        ...endpoint,
        WebSocket: WebSocket as unknown as PushSocketConstructor,
        backoff: { baseMs: 20, maxMs: 60 }
      })
    }),
    timeoutMs: 500
  })
  clients.push(client)
  await Promise.all(['a', 'b', 'wrong'].map((id) => client.connect(id)))
  await until(
    () =>
      client.list().filter((s) => s.state === 'connected').length === 2 &&
      client.list().some((s) => s.serverId === 'wrong' && s.state === 'unauthorized')
  )
  expect((await (await client.backing('a')).api.sessions.list())[0].title).toBe('Server A')
  expect((await (await client.backing('b')).api.sessions.list())[0].title).toBe('Server B')
  await expect(client.backing('wrong')).rejects.toThrow()
  const events: Array<Sourced<ServerEventEnvelope>> = []
  client.onEvent((event) => events.push(event))
  await a.publish({ _tag: 'session.title_changed', id: 'same', title: 'A changed' })
  await b.publish({ _tag: 'session.title_changed', id: 'same', title: 'B changed' })
  await until(() => events.length === 2)
  expect(events.map((event) => [event.serverId, event.value.event])).toEqual(
    expect.arrayContaining([
      ['a', { _tag: 'session.title_changed', id: 'same', title: 'A changed' }],
      ['b', { _tag: 'session.title_changed', id: 'same', title: 'B changed' }]
    ])
  )
  const streams: Array<Sourced<SessionStream>> = []
  await client.subscribe({ serverId: 'a', sessionId: 'same' }, (frame) => streams.push(frame))
  await client.subscribe({ serverId: 'b', sessionId: 'same' }, (frame) => streams.push(frame))
  await until(() => sourceA.listeners('same') === 2 && sourceB.listeners('same') === 2)
  sourceA.emit('same', { kind: 'pty', data: new Uint8Array([65]) })
  sourceB.emit('same', { kind: 'pty', data: new Uint8Array([66]) })
  await until(() => streams.length === 2)
  expect(streams.map((s) => [s.serverId, s.value.kind === 'pty' && [...s.value.data]])).toEqual(
    expect.arrayContaining([
      ['a', [65]],
      ['b', [66]]
    ])
  )
  const port = Number(new URL(a.url).port)
  await a.stop()
  await until(() => client.list().some((s) => s.serverId === 'a' && s.state === 'reconnecting'))
  expect((await (await client.backing('b')).api.sessions.list())[0].title).toBe('Server B')
  const recovered = new FakeSource({ ...aSession('same'), title: 'Server A recovered' })
  const restart = await startEmbedded({ ports: { sessions: recovered }, port, token: a.token })
  servers.push(restart)
  await until(
    () =>
      client.list().some((s) => s.serverId === 'a' && s.state === 'connected') &&
      recovered.listeners('same') === 2
  )
  expect((await (await client.backing('a')).api.sessions.list())[0].title).toBe(
    'Server A recovered'
  )
  recovered.emit('same', { kind: 'pty', data: new Uint8Array([67]) })
  await until(() => streams.length === 3)
  expect(streams.at(-1)?.serverId).toBe('a')
  await client.disconnect('b')
  await until(() => sourceB.listeners('same') === 0)
  expect(sourceB.get('same')?.title).toBe('Server B')
  expect(sourceB.stops).toEqual([])
  await expect(client.backing('b')).rejects.toThrow()
  expect(client.list().find((s) => s.serverId === 'b')?.state).toBe('disconnected')
  await client.connect('b')
  await until(() => client.list().some((s) => s.serverId === 'b' && s.state === 'connected'))
  expect((await (await client.backing('b')).api.sessions.list())[0].title).toBe('Server B')
}, 20_000)
