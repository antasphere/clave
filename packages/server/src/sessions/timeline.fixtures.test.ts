import { createServer } from 'node:http'
import { SessionInputSchema } from '../../../../src/shared/session-model'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { Effect, Layer, Schema } from 'effect'
import { InMemoryAll } from '@structure-ai/eventsourcing'
import { CommandBus, HandlerRegistry, layer as buses } from '@structure-ai/cqrs'
import { run, type FixtureError, type RunReport } from '@structure-ai/fixtures'
import { expect, it, vi } from 'vitest'
import { startEmbedded } from '../embedded'
import { ServerEvents } from '../events'
import { aSession, FakeSource } from '../test-support'
import { SessionHost, type SessionHostService } from './port'
import { SessionWrites, WriteLedger, fileWriteLedgerStorage } from './writes'
import { sessionHandlers } from './handlers'
import { timelineFixtureCatalog } from './timeline.fixtures'
import { TimelinePage } from '@clave/contract/timeline'
import type { SessionStream } from '@clave/contract/sessions'
import { SessionManager } from '../../../../src/main/sessions/session-manager'
import { EchoAdapter } from '../../../../src/main/sessions/adapters/echo-adapter'
import { PushClient } from '../../../client/src/push-client'

it('loads sessions/timeline-repeated-messages and verifies HTTP/push snapshot ordering and reopen catch-up', async () => {
  const root = '/tmp/clave-mobile-f'
  await mkdir(root, { recursive: true })
  const data = await mkdtemp(join(root, 'timeline-fixture-'))
  const manager = new SessionManager()
  manager.registerAdapter(new EchoAdapter())
  const storage = fileWriteLedgerStorage(join(data, 'write-ledger'))
  const host: SessionHostService = {
    ...SessionHost.none,
    list: () => manager.list(),
    get: (id) => manager.get(id),
    start: async ({ cwd }) => {
      const id = basename(cwd)
      await manager.create({ ...aSession(id), cwd })
      new WriteLedger(storage).initialize(id)
      return { id, cwd, folderName: id, alive: true, claudeSessionId: null, piSessionId: null }
    },
    subscribe: (id, listener) => {
      const off = manager.subscribe(id, listener)
      manager.ready(id)
      return off
    },
    subscribeExit: (id, listener) => manager.subscribeExit(id, listener),
    write: async (id, input) => {
      await manager.write(id, input.type === 'bytes' ? input.data : SessionInputSchema.parse(input))
    },
    history: (id, before, limit) => manager.history(id, before, limit),
    timeline: (id, before, limit) => manager.timeline(id, before, limit)
  }
  const fixtures = await Effect.runPromise(
    timelineFixtureCatalog.prepare('sessions/timeline-repeated-messages', {})
  )
  const layer = buses.pipe(
    Layer.provide(HandlerRegistry.layer(...sessionHandlers)),
    Layer.provide(SessionHost.layer(host)),
    Layer.provide(SessionWrites.layer(storage)),
    Layer.provide(ServerEvents.layer('fixture').pipe(Layer.provide(InMemoryAll)))
  )
  const report = await Effect.runPromise(
    (
      run({ fixtures, enabled: true, ready: () => Effect.void }) as Effect.Effect<
        RunReport<Readonly<Record<string, unknown>>>,
        FixtureError,
        CommandBus
      >
    ).pipe(Effect.provide(layer))
  )
  expect(report.completed).toEqual(['sessions/timeline-conversation'])
  const { sessionId } = report.values.conversation as { sessionId: string }
  const server = await startEmbedded({ ports: { sessions: host, writeLedger: storage } })
  const headers = { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' }
  const get = async (): Promise<TimelinePage> => {
    const response = await fetch(`${server.url}/sessions/timeline?id=${sessionId}`, { headers })
    expect(response.status).toBe(200)
    return Schema.decodeUnknownSync(TimelinePage)(await response.json())
  }
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let captured!: () => void
  const snapshotCaptured = new Promise<void>((resolve) => {
    captured = resolve
  })
  const proxy = createServer(async (request, response) => {
    const upstream = await fetch(server.url + request.url!, { headers })
    const body = await upstream.text()
    captured()
    await held
    response.writeHead(upstream.status, { 'content-type': 'application/json' })
    response.end(body)
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const address = proxy.address() as { port: number }
  const push = new PushClient({ url: server.url, token: server.token }).connect()
  const received: SessionStream[] = []
  try {
    await push.whenOpen()
    let off = push.subscribe(sessionId, (stream) => received.push(stream))
    await push.subscribed(sessionId)
    const initial = await get()
    expect(initial.items.filter(({ event }) => event.type === 'user_message')).toHaveLength(2)
    expect(new Set(initial.items.map(({ position }) => position.sequence)).size).toBe(
      initial.items.length
    )
    const pendingResponse = fetch(
      `http://127.0.0.1:${address.port}/sessions/timeline?id=${sessionId}`,
      { headers }
    ).then(async (response) => Schema.decodeUnknownSync(TimelinePage)(await response.json()))
    await snapshotCaptured
    const write = await fetch(`${server.url}/sessions/write`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        id: sessionId,
        input: { type: 'user_message', text: 'While snapshot response was held' }
      })
    })
    expect(write.status).toBe(200)
    await vi.waitFor(() =>
      expect(
        received.some((stream) => stream.kind === 'event' && stream.event.type === 'user_message')
      ).toBe(true)
    )
    release()
    const page = await pendingResponse
    const newer = received.filter(
      (stream) =>
        stream.kind === 'event' &&
        stream.position &&
        stream.position.generation === page.cursor.generation &&
        stream.position.sequence > page.cursor.sequence
    )
    expect(
      newer.filter((stream) => stream.kind === 'event' && stream.event.type === 'user_message')
    ).toHaveLength(1)
    for (const stream of newer) {
      if (stream.kind !== 'event') continue
      expect(
        (await get()).items.find(({ position }) => position.sequence === stream.position!.sequence)
          ?.event
      ).toEqual(stream.event)
    }
    off()
    await host.write(sessionId, { type: 'user_message', text: 'While closed' })
    off = push.subscribe(sessionId, (stream) => received.push(stream))
    await push.subscribed(sessionId)
    expect((await get()).items.filter(({ event }) => event.type === 'user_message')).toHaveLength(4)
    off()
    const reconnected = new PushClient({ url: server.url, token: server.token }).connect()
    try {
      await reconnected.whenOpen()
      reconnected.subscribe(sessionId, () => {})
      await reconnected.subscribed(sessionId)
      expect((await get()).items.filter(({ event }) => event.type === 'user_message')).toHaveLength(
        4
      )
    } finally {
      reconnected.close()
    }
    const pagedResponse = await fetch(
      `${server.url}/sessions/timeline?id=${sessionId}&before=7&limit=2`,
      { headers }
    )
    expect(pagedResponse.status).toBe(200)
    const paged = Schema.decodeUnknownSync(TimelinePage)(await pagedResponse.json())
    expect(paged.items.map(({ position }) => position.sequence)).toEqual([4, 5, 6])
    expect(paged.before).toBe(4)
    expect(paged.cursor).toEqual((await get()).cursor)
    const legacy = await fetch(`${server.url}/sessions/history?id=${sessionId}`, { headers })
    expect(legacy.status).toBe(200)
    expect(await legacy.json()).not.toHaveProperty('cursor')
    expect((await fetch(`${server.url}/sessions/timeline?id=${sessionId}`)).status).toBe(401)
    expect((await fetch(`${server.url}/sessions/timeline?id=missing`, { headers })).status).toBe(
      422
    )
    expect(
      (await fetch(`${server.url}/sessions/timeline?id=${sessionId}&limit=0`, { headers })).status
    ).toBe(400)
    await writeFile(
      join(data, 'receipt.json'),
      JSON.stringify({ ...report, timeline: await get() }, null, 2)
    )
    console.log(`Timeline fixture receipt: ${join(data, 'receipt.json')}`)
  } finally {
    release()
    push.close()
    await new Promise<void>((resolve) => {
      proxy.close(() => resolve())
      proxy.closeAllConnections()
    })
    await server.stop()
  }
})

it('refuses legacy hosts and reports seed failures as declared errors without leaking their contents', async () => {
  const source = new FakeSource(aSession('legacy'))
  const server = await startEmbedded({ ports: { sessions: source } })
  try {
    const headers = { authorization: `Bearer ${server.token}` }
    const response = await fetch(`${server.url}/sessions/timeline?id=legacy`, { headers })
    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ _tag: 'CapabilityUnavailable' })
    Object.assign(source, {
      timeline: () => {
        throw new Error('PRIVATE HISTORY CONTENT')
      }
    })
    const failed = await fetch(`${server.url}/sessions/timeline?id=legacy`, { headers })
    expect(failed.status).toBe(422)
    const body = await failed.json()
    expect(body).toMatchObject({ _tag: 'TimelineReadFailed', id: 'legacy' })
    expect(JSON.stringify(body)).not.toContain('PRIVATE HISTORY CONTENT')
  } finally {
    await server.stop()
  }
})
