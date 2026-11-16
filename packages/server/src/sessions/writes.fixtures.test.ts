import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Effect, Layer } from 'effect'
import { InMemoryAll } from '@structure-ai/eventsourcing'
import { ServerEvents } from '../events'
import { CommandBus, HandlerRegistry, layer as buses } from '@structure-ai/cqrs'
import { run, type FixtureError, type RunReport } from '@structure-ai/fixtures'
import { expect, it } from 'vitest'
import { startEmbedded } from '../embedded'
import { FakeSource, aSession } from '../test-support'
import { SessionHost } from './port'
import { sessionHandlers } from './handlers'
import { SessionWrites, WriteLedger, fileWriteLedgerStorage } from './writes'
import { writeFixtureCatalog } from './writes.fixtures'

it('loads mobile-notify/write-once and verifies one dispatch and durable status through HTTP', async () => {
  const scratch = join('/tmp', process.env.CLAVE_E2E_NS ?? 'clave-mobile-b')
  await mkdir(scratch, { recursive: true })
  const data = await mkdtemp(join(scratch, 'write-fixture-'))
  const storage = fileWriteLedgerStorage(join(data, 'write-ledger'))
  const source = new FakeSource(aSession('fixture-session'))
  new WriteLedger(storage).initialize('fixture-session')
  const fixtures = await Effect.runPromise(
    writeFixtureCatalog.prepare('mobile-notify/write-once', { sessionId: 'fixture-session' })
  )
  const layer = buses.pipe(
    Layer.provide(HandlerRegistry.layer(...sessionHandlers)),
    Layer.provide(SessionHost.layer(source)),
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
  expect(report.completed).toEqual(['mobile-notify/write'])
  expect(source.writes).toHaveLength(1)
  const write = report.values.write as {
    sessionId: string
    clientMessageId: string
    first: unknown
    second: unknown
  }
  expect(write.second).toEqual(write.first)
  const server = await startEmbedded({ ports: { sessions: source, writeLedger: storage } })
  try {
    const query = new URLSearchParams({
      id: write.sessionId,
      clientMessageId: write.clientMessageId
    })
    const response = await fetch(`${server.url}/sessions/writes?${query}`, {
      headers: { authorization: `Bearer ${server.token}` }
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(write.first)
    await writeFile(join(data, 'receipt.json'), JSON.stringify(report, null, 2))
  } finally {
    await server.stop()
  }
})
