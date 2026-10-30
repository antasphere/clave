import { it, expect } from 'vitest'
import { WriteLedger, memoryWriteLedgerStorage } from '../sessions/writes'
import { startEmbedded } from '../embedded'
import { FakeSource, aSession } from '../test-support'
const id = 'phone-late-0001'
it.each(['rejected', 'unknown'] as const)(
  'persisted own history must override prior %s consistently',
  async (status) => {
    const storage = memoryWriteLedgerStorage()
    storage.documents.set(
      's1.ledger.json',
      JSON.stringify({
        v: 1,
        complete: true,
        entries: { [id]: { status, at: 1, reason: 'earlier' } }
      })
    )
    storage.documents.set('s1.history.json', JSON.stringify({ v: 1, items: [{ id, at: 42 }] }))
    const source = new FakeSource(aSession('s1'))
    const server = await startEmbedded({ ports: { sessions: source, writeLedger: storage } })
    try {
      const headers = {
        authorization: `Bearer ${server.token}`,
        'content-type': 'application/json'
      }
      const before = await (
        await fetch(`${server.url}/sessions/writes?id=s1&clientMessageId=${id}`, { headers })
      ).json()
      const sent = await (
        await fetch(`${server.url}/sessions/write`, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            id: 's1',
            input: { type: 'user_message', text: 'same', clientMessageId: id }
          })
        })
      ).json()
      expect(before).toEqual({ status: 'accepted', at: 42 })
      expect(sent).toEqual(before)
      expect(source.writes).toHaveLength(0)
    } finally {
      await server.stop()
    }
  }
)
it('crash after late evidence history write but before accepted-ledger persist recovers accepted', () => {
  const storage = memoryWriteLedgerStorage()
  storage.documents.set(
    's1.ledger.json',
    JSON.stringify({ v: 1, complete: true, entries: { [id]: { status: 'dispatched', at: 1 } } })
  )
  const ledger = new WriteLedger(
    storage,
    () => 2,
    () => {}
  )
  expect(ledger.status('s1', id).status).toBe('unknown')
  let crashSnapshot!: Map<string, string>
  const write = storage.write
  storage.write = (name, text) => {
    write(name, text)
    if (name === 's1.history.json') crashSnapshot = new Map(storage.documents)
  }
  ledger.evidence('s1', id, 42)
  const recovered = new WriteLedger(
    { read: (name) => crashSnapshot.get(name) ?? null, write: () => {} },
    () => 3,
    () => {}
  )
  expect(recovered.status('s1', id)).toEqual({ status: 'accepted', at: 42 })
})
it.each(['rejected', 'unknown'] as const)('late own evidence settles live prior %s', (status) => {
  const storage = memoryWriteLedgerStorage()
  storage.documents.set(
    's1.ledger.json',
    JSON.stringify({
      v: 1,
      complete: true,
      entries: { [id]: { status, at: 1, reason: 'earlier' } }
    })
  )
  const ledger = new WriteLedger(
    storage,
    () => 2,
    () => {}
  )
  ledger.evidence('s1', id, 42)
  expect(ledger.status('s1', id)).toEqual({ status: 'accepted', at: 42 })
})

it('delayed own history preserves original accepted result on duplicate', () => {
  const ledger = new WriteLedger(
    memoryWriteLedgerStorage(),
    () => 1,
    () => {}
  )
  ledger.initialize('s')
  ledger.receive('s', 'phone-late-0002')
  ledger.dispatch('s', 'phone-late-0002')
  ledger.accept('s', 'phone-late-0002', 1)
  ledger.evidence('s', 'phone-late-0002', 42)
  expect(ledger.receive('s', 'phone-late-0002')).toEqual({ held: { status: 'accepted', at: 1 } })
})

it('replayed evidence and direct accept keep the first durable accepted result after restart', () => {
  const storage = memoryWriteLedgerStorage()
  const ledger = new WriteLedger(
    storage,
    () => 1,
    () => {}
  )
  ledger.initialize('s1')
  ledger.receive('s1', id)
  ledger.dispatch('s1', id)
  ledger.evidence('s1', id, 42)
  ledger.evidence('s1', id, 84)
  expect(ledger.accept('s1', id, 99)).toEqual({ status: 'accepted', at: 42 })
  const recovered = new WriteLedger(storage)
  expect(recovered.status('s1', id)).toEqual({ status: 'accepted', at: 42 })
  expect(recovered.receive('s1', id)).toEqual({ held: { status: 'accepted', at: 42 } })
})

// Expectations are the public seam, independent of ledger implementation.
const phaseCases = [
  { phase: 'received', withoutHistory: 'rejected', acceptedAt: 42 },
  { phase: 'dispatched', withoutHistory: 'unknown', acceptedAt: 42 },
  { phase: 'accepted', withoutHistory: 'accepted', acceptedAt: 1 },
  { phase: 'rejected', withoutHistory: 'rejected', acceptedAt: 42 },
  { phase: 'unknown', withoutHistory: 'unknown', acceptedAt: 42 },
  { phase: 'absent', withoutHistory: 'absent', acceptedAt: 42 }
] as const
const reconciliationCases = phaseCases.flatMap((row) =>
  [true, false].flatMap((complete) =>
    [true, false].map((history) => ({
      ...row,
      complete,
      history,
      expected: history
        ? 'accepted'
        : !complete && row.phase === 'absent'
          ? 'unknown'
          : row.withoutHistory
    }))
  )
)

it.each(reconciliationCases)(
  'HTTP reconciliation $phase, complete=$complete, history=$history agrees through duplicate sends and restart',
  async ({ phase, complete, history, expected, acceptedAt }) => {
    const storage = memoryWriteLedgerStorage()
    storage.documents.set(
      's1.ledger.json',
      JSON.stringify({
        v: 1,
        complete,
        entries:
          phase === 'absent'
            ? {}
            : {
                [id]: {
                  status: phase,
                  at: 1,
                  ...(['rejected', 'unknown'].includes(phase) ? { reason: 'earlier result' } : {})
                }
              }
      })
    )
    if (history)
      storage.documents.set('s1.history.json', JSON.stringify({ v: 1, items: [{ id, at: 42 }] }))
    const source = new FakeSource(aSession('s1'))
    let server = await startEmbedded({ ports: { sessions: source, writeLedger: storage } })
    const get = async (): Promise<Record<string, unknown>> => {
      const response = await fetch(`${server.url}/sessions/writes?id=s1&clientMessageId=${id}`, {
        headers: { authorization: `Bearer ${server.token}` }
      })
      expect(response.status).toBe(200)
      return response.json()
    }
    const post = (): Promise<Response> =>
      fetch(`${server.url}/sessions/write`, {
        method: 'POST',
        headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          id: 's1',
          input: { type: 'user_message', text: 'same message', clientMessageId: id }
        })
      })
    try {
      const before = await get()
      expect(before.status).toBe(expected)
      if (expected === 'accepted') expect(before.at).toBe(acceptedAt)
      const first = await post()
      const firstBody = await first.json()
      let accepted: Record<string, unknown> | undefined
      if (expected === 'accepted' || expected === 'absent') {
        expect(first.status).toBe(200)
        expect(firstBody.status).toBe('accepted')
        accepted = firstBody
        if (expected === 'accepted') expect(firstBody).toEqual(before)
        expect(await get()).toEqual(firstBody)
      } else {
        expect(first.status).toBe(422)
        expect(firstBody).toMatchObject({
          _tag: expected === 'rejected' ? 'SessionWriteRefused' : 'SessionWriteUnknown',
          message: before.reason
        })
      }
      const expectedWrites = expected === 'absent' ? 1 : 0
      expect(source.writes).toHaveLength(expectedWrites)
      // Both a retry now and a retry after a new server process use the same result.
      for (const restart of [false, true]) {
        if (restart) {
          await server.stop()
          server = await startEmbedded({ ports: { sessions: source, writeLedger: storage } })
        }
        const view = await get()
        const response = await post()
        const body = await response.json()
        if (accepted) {
          expect(view).toEqual(accepted)
          expect(response.status).toBe(200)
          expect(body).toEqual(accepted)
        } else {
          expect(view).toEqual(before)
          expect(response.status).toBe(422)
          expect(body).toEqual(firstBody)
        }
        expect(source.writes).toHaveLength(expectedWrites)
      }
    } finally {
      await server.stop()
    }
  }
)
