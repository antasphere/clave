import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource, aSession } from '../test-support'
import { STOPPED_AFTER_DISPATCH, fileWriteLedgerStorage } from './writes'

let server: EmbeddedServer | undefined
const roots: string[] = []
afterEach(async () => {
  await server?.stop()
  server = undefined
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const storageFor = (root: string): ReturnType<typeof fileWriteLedgerStorage> =>
  fileWriteLedgerStorage(join(root, 'write-ledger'), {
    activationFile: join(root, 'write-ledger-activation.json'),
    sessionIds: ['desktop-existing']
  })
const scratch = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'clave-legacy-write-'))
  roots.push(root)
  return root
}
const request = (route: string, body?: unknown): Promise<Response> =>
  fetch(server!.url + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${server!.token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
const message = {
  id: 'desktop-existing',
  input: {
    type: 'user_message',
    text: 'First phone message on an existing conversation',
    clientMessageId: 'phone-legacy-0001'
  }
}
const query = '/sessions/writes?id=desktop-existing&clientMessageId=phone-legacy-0001'

it('upgrades a saved desktop session before serving, accepts its first phone message and suppresses retry after restart', async () => {
  const root = scratch()
  const source = new FakeSource(aSession('desktop-existing'))
  server = await startEmbedded({ ports: { sessions: source, writeLedger: storageFor(root) } })
  expect(await (await request(query)).json()).toEqual({ status: 'absent' })
  const accepted = await (await request('/sessions/write', message)).json()
  expect(accepted).toMatchObject({ status: 'accepted' })
  expect(source.writes).toHaveLength(1)
  await server.stop()
  server = await startEmbedded({ ports: { sessions: source, writeLedger: storageFor(root) } })
  expect(await (await request('/sessions/write', message)).json()).toEqual(accepted)
  expect(source.writes).toHaveLength(1)
})

it('reads a message the session held when the server stopped as unknown after the restart, never rejected, and sends it nowhere again', async () => {
  const root = scratch()
  const source = new FakeSource(aSession('desktop-existing'))
  Object.assign(source, {
    write: (id: string, input: unknown) =>
      new Promise<void>(() => {
        source.writes.push({ id, input })
      })
  })
  server = await startEmbedded({ ports: { sessions: source, writeLedger: storageFor(root) } })
  void request('/sessions/write', message).catch(() => {})
  await vi.waitFor(() => expect(source.writes).toHaveLength(1))
  await server.stop()
  server = await startEmbedded({ ports: { sessions: source, writeLedger: storageFor(root) } })
  expect(await (await request(query)).json()).toMatchObject({
    status: 'unknown',
    reason: STOPPED_AFTER_DISPATCH
  })
  const again = await request('/sessions/write', message)
  expect(again.status).toBe(422)
  expect(await again.json()).toMatchObject({ _tag: 'SessionWriteUnknown' })
  expect(source.writes).toHaveLength(1)
})

it.each(['missing-file', 'corrupt-file', 'missing-directory'])(
  'never treats %s after activation as a legacy session',
  async (damage) => {
    const root = scratch()
    const storage = storageFor(root)
    const source = new FakeSource(aSession('desktop-existing'))
    server = await startEmbedded({ ports: { sessions: source, writeLedger: storage } })
    expect((await request('/sessions/write', message)).status).toBe(200)
    await server.stop()
    const dir = join(root, 'write-ledger')
    if (damage === 'missing-directory') rmSync(dir, { recursive: true })
    else if (damage === 'corrupt-file')
      writeFileSync(join(dir, 'desktop-existing.ledger.json'), '{broken')
    else rmSync(join(dir, 'desktop-existing.ledger.json'))
    server = await startEmbedded({ ports: { sessions: source, writeLedger: storageFor(root) } })
    expect(await (await request(query)).json()).toMatchObject({ status: 'unknown' })
    expect((await request('/sessions/write', message)).status).toBe(422)
    expect(source.writes).toHaveLength(1)
  }
)

it('an existing ledger directory without an activation marker does not prove a legacy installation', async () => {
  const root = scratch()
  mkdirSync(join(root, 'write-ledger'))
  const source = new FakeSource(aSession('desktop-existing'))
  server = await startEmbedded({ ports: { sessions: source, writeLedger: storageFor(root) } })
  expect(await (await request(query)).json()).toMatchObject({ status: 'unknown' })
  expect((await request('/sessions/write', message)).status).toBe(422)
  expect(source.writes).toHaveLength(0)
})

it('an interrupted activation never initializes the remaining saved ids on a later boot', async () => {
  const root = scratch()
  writeFileSync(join(root, 'write-ledger-activation.json'), JSON.stringify({ v: 1 }))
  const source = new FakeSource(aSession('desktop-existing'))
  server = await startEmbedded({ ports: { sessions: source, writeLedger: storageFor(root) } })
  expect(await (await request(query)).json()).toMatchObject({ status: 'unknown' })
  expect((await request('/sessions/write', message)).status).toBe(422)
  expect(source.writes).toHaveLength(0)
})

it('legacy activation initializes only the saved identities supplied by the host', async () => {
  const root = scratch()
  const source = new FakeSource(aSession('desktop-existing'))
  server = await startEmbedded({ ports: { sessions: source, writeLedger: storageFor(root) } })
  expect(
    await (await request('/sessions/writes?id=arbitrary&clientMessageId=phone-legacy-0001')).json()
  ).toMatchObject({ status: 'unknown' })
  const response = await request('/sessions/write', { ...message, id: 'arbitrary' })
  expect(response.status).toBe(422)
  expect(await response.json()).toMatchObject({ _tag: 'SessionWriteUnknown' })
  expect(source.writes).toHaveLength(0)
})
it('reads the saved identities at the first activation alone, never on a later boot (PRDCT-4448)', () => {
  const root = scratch()
  const saved = vi.fn(() => ['desktop-existing', 'desktop-existing', 'desktop-other'])
  const lazily = (): ReturnType<typeof fileWriteLedgerStorage> =>
    fileWriteLedgerStorage(join(root, 'write-ledger'), {
      activationFile: join(root, 'write-ledger-activation.json'),
      sessionIds: saved
    })
  lazily()
  expect(saved).toHaveBeenCalledTimes(1)
  expect(
    JSON.parse(readFileSync(join(root, 'write-ledger', 'desktop-other.ledger.json'), 'utf8'))
  ).toMatchObject({ complete: true })
  lazily()
  expect(saved).toHaveBeenCalledTimes(1)
})
it('reads nothing for a ledger folder that exists without an activation marker (PRDCT-4448)', () => {
  const root = scratch()
  mkdirSync(join(root, 'write-ledger'))
  const saved = vi.fn(() => ['desktop-existing'])
  fileWriteLedgerStorage(join(root, 'write-ledger'), {
    activationFile: join(root, 'write-ledger-activation.json'),
    sessionIds: saved
  })
  expect(saved).not.toHaveBeenCalled()
})
