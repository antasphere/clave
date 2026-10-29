import { afterEach, describe, expect, it } from 'vitest'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource, aSession } from '../test-support'
import { PendingRequests } from '../requests/service'
import { memoryWriteLedgerStorage, type WriteLedgerStorage } from '../sessions/writes'
import { fakePush, type FakePush } from './fake'

/**
 * The notify domain over the real server (the mobile wave, lane B): the
 * owner's two routes behind the token, the dispatcher fed by the requests
 * service and the server's own events, the write ledger behind
 * `POST /sessions/write` and `GET /sessions/writes`.
 */
let server: EmbeddedServer | undefined
afterEach(async () => {
  await server?.stop()
  server = undefined
})

const call = (path: string, body?: unknown, token = server!.token): Promise<Response> =>
  fetch(`${server!.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) })
  })
const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function world(
  input: { requests?: PendingRequests; grace?: number; storage?: WriteLedgerStorage } = {}
): Promise<{
  fake: FakePush
  source: FakeSource
}> {
  const fake = fakePush()
  fake.targets.add({ deviceId: 'iphone', platform: 'ios', token: 'ios-token-1' })
  const source = new FakeSource(aSession('s1'))
  server = await startEmbedded({
    ports: {
      sessions: source,
      ...(input.requests && { requests: input.requests }),
      pushTargets: fake.targets,
      pushTransports: fake.transports,
      notify: { serverName: 'Test-Mac', requestGraceMs: input.grace ?? 0, fake: true },
      ...(input.storage && { writeLedger: input.storage })
    }
  })
  return { fake, source }
}

describe('the owner’s routes', () => {
  it('answers the status, behind the token', async () => {
    await world()
    const refused = await fetch(`${server!.url}/notify/status`)
    expect(refused.status).toBe(401)
    const answer = await call('/notify/status')
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({
      transports: { ios: true, android: true },
      fake: true,
      targets: 1,
      serverName: 'Test-Mac'
    })
  })
  it('sends a test notification to one phone and refuses an unknown device', async () => {
    const { fake } = await world()
    const answer = await call('/notify/test', { deviceId: 'iphone' })
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({
      deviceId: 'iphone',
      platform: 'ios',
      result: { outcome: 'sent' }
    })
    expect(fake.transport.sent.map((s) => s.payload.category)).toEqual(['test'])
    const unknown = await call('/notify/test', { deviceId: 'nobody' })
    expect(unknown.status).toBe(422)
    expect(await unknown.json()).toMatchObject({ _tag: 'PushTargetNotFound', deviceId: 'nobody' })
  })
  it('says what a server without the ports can do: nothing', async () => {
    server = await startEmbedded({ ports: { sessions: new FakeSource() } })
    const answer = await call('/notify/status')
    expect(answer.status).toBe(200)
    expect(await answer.json()).toMatchObject({
      transports: { ios: false, android: false },
      fake: false,
      targets: 0
    })
  })
})

describe('the dispatcher on the real server', () => {
  it('pushes a pending request of the requests service, once, with its id', async () => {
    const requests = new PendingRequests()
    const { fake } = await world({ requests })
    const request = requests.create({
      sessionId: 's1',
      kind: 'clarification',
      description: 'A question',
      options: [{ id: 'answer', label: 'Submit' }],
      questions: [{ question: 'Which branch?', options: [] }],
      input: { secret: 'INPUT-SECRET' }
    })
    await tick(50)
    const sent = fake.transport.of('question')
    expect(sent.length).toBe(1)
    expect(sent[0].payload).toMatchObject({
      serverId: server!.serverId,
      serverName: 'Test-Mac',
      sessionId: 's1',
      sessionTitle: 's1',
      requestId: request.id,
      text: 'Which branch?',
      actions: ['reply', 'open']
    })
    expect(JSON.stringify(sent[0].payload).includes('INPUT-SECRET')).toBe(false)
    requests.close()
  })
  it('pushes a session finished off the server’s own state event, and an account limit off a usage read', async () => {
    const { fake } = await world()
    await server!.publish({ _tag: 'session.state_changed', id: 's1', state: 'done' })
    await server!.publish({
      _tag: 'usage.claude_read',
      accountId: 'acc-1',
      result: {
        windows: [
          {
            key: 'five_hour',
            label: '5-hour limit',
            kind: 'session',
            scope: null,
            usedPercentage: 97,
            resetsAt: 1000,
            severity: null
          }
        ],
        fetchedAt: 1
      }
    })
    await tick(50)
    expect(fake.transport.sent.map((s) => [s.payload.category, s.payload.text])).toEqual([
      ['finished', 's1 finished'],
      ['account_limit', 'acc-1: 5-hour limit has 3% left']
    ])
  })
  it('takes the frame road on a server with no requests service', async () => {
    const { fake } = await world()
    server!.notify.streamEvent('s1', {
      type: 'permission_request',
      id: 'native-1',
      description: 'Allow Write?',
      options: [
        { id: 'allow-once', label: 'Allow once' },
        { id: 'deny', label: 'Deny' }
      ]
    })
    server!.notify.exited('s1', 1, false)
    await tick(50)
    expect(fake.transport.sent.map((s) => s.payload.category).sort()).toEqual([
      'failed',
      'permission'
    ])
    expect(fake.transport.of('permission')[0].payload).toMatchObject({
      requestId: 'native-1',
      actions: ['allow', 'deny', 'open']
    })
  })
})

describe('a message written once (the seam of 29 October)', () => {
  const message = (clientMessageId: string): unknown => ({
    id: 's1',
    input: { type: 'user_message', text: 'hello', clientMessageId }
  })
  const status = async (id: string, clientMessageId: string): Promise<unknown> =>
    (await call(`/sessions/writes?id=${id}&clientMessageId=${clientMessageId}`)).json()

  it('writes the first arrival and answers accepted; a second arrival answers accepted and writes nothing', async () => {
    const { source } = await world()
    const first = await call('/sessions/write', message('phone-00000001'))
    expect(first.status).toBe(200)
    const answer = (await first.json()) as { status: string; at: number }
    expect(answer.status).toBe('accepted')
    expect(typeof answer.at).toBe('number')
    const second = await call('/sessions/write', message('phone-00000001'))
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual(answer)
    expect(source.writes).toEqual([
      {
        id: 's1',
        input: { type: 'user_message', text: 'hello', clientMessageId: 'phone-00000001' }
      }
    ])
    expect(await status('s1', 'phone-00000001')).toEqual(answer)
    expect(await status('s1', 'phone-00000009')).toEqual({ status: 'absent' })
    // The status is the ledger's, whether or not the session exists.
    expect(await status('ghost', 'phone-00000001')).toEqual({ status: 'absent' })
    const bad = await call('/sessions/writes?id=s1&clientMessageId=short')
    expect(bad.status).toBe(400)
  })
  it('answers pending to a second arrival while the first write is in flight, and writes once', async () => {
    const { source } = await world()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const write = source.write
    source.write = async (id, input) => {
      await gate
      return write(id, input)
    }
    const first = call('/sessions/write', message('phone-00000002'))
    await tick(50)
    expect(await status('s1', 'phone-00000002')).toEqual({ status: 'pending' })
    const second = await call('/sessions/write', message('phone-00000002'))
    expect(await second.json()).toEqual({ status: 'pending' })
    release()
    expect(((await (await first).json()) as { status: string }).status).toBe('accepted')
    expect(source.writes.length).toBe(1)
    expect(await status('s1', 'phone-00000002')).toMatchObject({ status: 'accepted' })
  })
  it('records a refused first write and refuses its retry with the recorded reason, writing nothing more', async () => {
    const { source } = await world()
    source.refuse = new Error('the provider refused it: hello is not welcome')
    const first = await call('/sessions/write', message('phone-00000003'))
    expect(first.status).toBe(422)
    expect(await first.json()).toMatchObject({
      _tag: 'SessionWriteRefused',
      message: 'the provider refused it: … is not welcome'
    })
    source.refuse = null
    const retry = await call('/sessions/write', message('phone-00000003'))
    expect(retry.status).toBe(422)
    expect(await retry.json()).toMatchObject({
      _tag: 'SessionWriteRefused',
      message: 'the provider refused it: … is not welcome'
    })
    expect(source.writes).toEqual([])
    expect(await status('s1', 'phone-00000003')).toMatchObject({
      status: 'rejected',
      reason: 'the provider refused it: … is not welcome'
    })
  })
  it('records a write to a session it does not know as rejected, and answers SessionNotFound', async () => {
    await world()
    const answer = await call('/sessions/write', {
      ...(message('phone-00000004') as object),
      id: 'ghost'
    })
    expect(answer.status).toBe(422)
    expect(await answer.json()).toMatchObject({ _tag: 'SessionNotFound', id: 'ghost' })
    expect(await status('ghost', 'phone-00000004')).toMatchObject({
      status: 'rejected',
      reason: 'no session with that id'
    })
  })
  it('refuses a second write of an id whose outcome is unknown, and writes nothing', async () => {
    const storage = memoryWriteLedgerStorage()
    // What a previous process left: dispatched, and no evidence.
    storage.documents.set(
      's1.ledger.json',
      JSON.stringify({
        v: 1,
        complete: true,
        entries: { 'phone-00000005': { status: 'dispatched', at: 1 } }
      })
    )
    const { source } = await world({ storage })
    expect(await status('s1', 'phone-00000005')).toMatchObject({ status: 'unknown' })
    const retry = await call('/sessions/write', message('phone-00000005'))
    expect(retry.status).toBe(422)
    expect(await retry.json()).toMatchObject({
      _tag: 'SessionWriteUnknown',
      clientMessageId: 'phone-00000005'
    })
    expect(source.writes).toEqual([])
  })
  it('settles a dispatched entry as accepted after a restart when the server’s own history carries the id', async () => {
    const storage = memoryWriteLedgerStorage()
    storage.documents.set(
      's1.ledger.json',
      JSON.stringify({
        v: 1,
        complete: true,
        entries: { 'phone-00000006': { status: 'dispatched', at: 1 } }
      })
    )
    storage.documents.set(
      's1.history.json',
      JSON.stringify({ v: 1, items: [{ id: 'phone-00000006', at: 2 }] })
    )
    await world({ storage })
    expect(await status('s1', 'phone-00000006')).toEqual({ status: 'accepted', at: 2 })
    const retry = await call('/sessions/write', message('phone-00000006'))
    expect(await retry.json()).toEqual({ status: 'accepted', at: 2 })
  })
  it('records the evidence the entry hands it: a message passing on the stream', async () => {
    const storage = memoryWriteLedgerStorage()
    await world({ storage })
    server!.writes.evidence('s1', 'phone-00000007', 77)
    expect(await status('s1', 'phone-00000007')).toEqual({ status: 'accepted', at: 77 })
    expect(JSON.parse(storage.documents.get('s1.history.json')!)).toEqual({
      v: 1,
      items: [{ id: 'phone-00000007', at: 77 }]
    })
  })
  it('writes a message with no id every time, as before, answering accepted', async () => {
    const { source } = await world()
    const input = { id: 's1', input: { type: 'user_message', text: 'again' } }
    const first = await call('/sessions/write', input)
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ status: 'accepted' })
    await call('/sessions/write', input)
    expect(source.writes.length).toBe(2)
  })
})
