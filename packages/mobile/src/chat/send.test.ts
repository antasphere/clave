import { describe, expect, it } from 'vitest'
import { ServerError } from '../api/errors'
import type { WriteStatus } from '../contract/types'
import { reconcile, sendMessage, type SendPorts } from './send'

/** Ports over scripts: what each write attempt does, what each status ask answers. */
function ports(script: {
  writes: Array<'ok' | 'network' | 'timeout' | 'refused' | 'unauthenticated'>
  statuses: Array<WriteStatus | 'network' | '404'>
}): SendPorts & { writes: string[]; asks: number; slept: number[] } {
  let clock = 0
  const made = {
    writes: [] as string[],
    asks: 0,
    slept: [] as number[],
    write: async (id: string): Promise<void> => {
      made.writes.push(id)
      const step = script.writes.shift() ?? 'ok'
      if (step === 'ok') return
      if (step === 'network') throw new ServerError('network', 'The server could not be reached.')
      if (step === 'timeout')
        throw new ServerError('timeout', 'The server did not answer within 10 s.')
      if (step === 'refused')
        throw new ServerError('refused', 'The provider refused the message.', {
          status: 422,
          failure: { _tag: 'SessionWriteRefused', message: 'The provider refused the message.' }
        })
      throw new ServerError('unauthenticated', 'The server refused the token.', { status: 401 })
    },
    status: async (): Promise<WriteStatus> => {
      made.asks += 1
      const step = script.statuses.shift() ?? 'network'
      if (step === 'network') throw new ServerError('network', 'The server could not be reached.')
      if (step === '404')
        throw new ServerError('protocol', 'The server answered 404.', { status: 404 })
      return step
    },
    sleep: async (ms: number): Promise<void> => {
      made.slept.push(ms)
      clock += ms
    },
    now: () => clock
  }
  return made
}

describe('a send and its reconciliation', () => {
  it('a write that answers is sent, nothing asked', async () => {
    const p = ports({ writes: ['ok'], statuses: [] })
    expect(await sendMessage('m-1', p)).toEqual({
      kind: 'sent',
      clientMessageId: 'm-1',
      reconciled: false
    })
    expect(p.asks).toBe(0)
  })
  it('a refusal keeps the draft with the reason and never asks', async () => {
    const p = ports({ writes: ['refused'], statuses: [] })
    expect(await sendMessage('m-1', p)).toEqual({
      kind: 'rejected',
      clientMessageId: 'm-1',
      reason: 'The provider refused the message.'
    })
    expect(p.asks).toBe(0)
  })
  it('a refused token is a failure, not a reconciliation', async () => {
    const p = ports({ writes: ['unauthenticated'], statuses: [] })
    expect((await sendMessage('m-1', p)).kind).toBe('failed')
    expect(p.asks).toBe(0)
  })
  it('accepted: the lost answer is found landed', async () => {
    const p = ports({ writes: ['network'], statuses: [{ status: 'accepted', at: 5 }] })
    expect(await sendMessage('m-1', p)).toEqual({
      kind: 'sent',
      clientMessageId: 'm-1',
      reconciled: true
    })
    expect(p.writes).toEqual(['m-1'])
  })
  it('pending: asked again with backoff, then accepted', async () => {
    const p = ports({
      writes: ['timeout'],
      statuses: [{ status: 'pending' }, { status: 'pending' }, { status: 'accepted' }]
    })
    expect((await sendMessage('m-1', p, { backoffMs: 1_000 })).kind).toBe('sent')
    expect(p.slept).toEqual([1_000, 2_000])
    expect(p.asks).toBe(3)
  })
  it('pending past the budget counts as unknown and sends nothing', async () => {
    const p = ports({
      writes: ['network'],
      statuses: Array.from({ length: 50 }, () => ({ status: 'pending' as const }))
    })
    const outcome = await sendMessage('m-1', p, {
      pendingBudgetMs: 60_000,
      backoffMs: 1_000,
      maxBackoffMs: 8_000
    })
    expect(outcome.kind).toBe('unknown')
    expect(p.writes).toEqual(['m-1'])
    expect(p.slept.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(60_000)
    expect(p.slept.at(-1)).toBeLessThanOrEqual(8_000)
  })
  it('rejected on the ledger keeps the draft with the recorded reason', async () => {
    const p = ports({
      writes: ['network'],
      statuses: [{ status: 'rejected', reason: 'server restarted before dispatch' }]
    })
    expect(await sendMessage('m-1', p)).toEqual({
      kind: 'rejected',
      clientMessageId: 'm-1',
      reason: 'server restarted before dispatch'
    })
    expect(p.writes).toEqual(['m-1'])
  })
  it('absent: the same send is completed once with the same id', async () => {
    const p = ports({ writes: ['network', 'ok'], statuses: [{ status: 'absent' }] })
    expect(await sendMessage('m-1', p)).toEqual({
      kind: 'sent',
      clientMessageId: 'm-1',
      reconciled: true
    })
    expect(p.writes).toEqual(['m-1', 'm-1'])
  })
  it('absent twice: the one retry is spent, the second loss is unknown', async () => {
    const p = ports({
      writes: ['network', 'network'],
      statuses: [{ status: 'absent' }, { status: 'absent' }]
    })
    const outcome = await sendMessage('m-1', p)
    expect(outcome.kind).toBe('unknown')
    expect(p.writes).toEqual(['m-1', 'm-1'])
    expect(p.asks).toBe(2)
  })
  it("unknown sends nothing by itself and keeps the id for the person's choice", async () => {
    const p = ports({ writes: ['network'], statuses: [{ status: 'unknown' }] })
    const outcome = await sendMessage('m-1', p)
    expect(outcome).toEqual({
      kind: 'unknown',
      clientMessageId: 'm-1',
      reason: 'The server cannot say whether the message arrived.'
    })
    expect(p.writes).toEqual(['m-1'])
  })
  it('a server without the status route cannot tell: unknown, nothing sent', async () => {
    const p = ports({ writes: ['timeout'], statuses: ['404'] })
    const outcome = await sendMessage('m-1', p)
    expect(outcome).toMatchObject({
      kind: 'unknown',
      reason: 'This server cannot say whether the message arrived.'
    })
    expect(p.writes).toEqual(['m-1'])
  })
  it('a status ask that fails is unknown, nothing sent', async () => {
    const p = ports({ writes: ['network'], statuses: ['network'] })
    expect((await sendMessage('m-1', p)).kind).toBe('unknown')
    expect(p.writes).toEqual(['m-1'])
  })
  it('the crash between the dispatch and the acknowledgement: the draft stays, nothing is sent by itself', async () => {
    // The write's answer is lost with the server; the restarted server
    // recovers the entry as unknown (the seam's recovery rule).
    const p = ports({ writes: ['network'], statuses: [{ status: 'unknown' }] })
    const outcome = await sendMessage('m-1', p)
    expect(outcome.kind).toBe('unknown')
    expect(p.writes).toHaveLength(1)
    // Asked again later (a reconnection), still unknown: still nothing sent.
    const again = await reconcile('m-1', ports({ writes: [], statuses: [{ status: 'unknown' }] }))
    expect(again.kind).toBe('unknown')
  })
})
