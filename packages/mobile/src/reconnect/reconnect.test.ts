import { beforeEach, describe, expect, it } from 'vitest'
import { ServerError } from '../api/errors'
import { Drafts, MemoryKeyValueStore } from '../chat/drafts'
import type { WriteStatus } from '../contract/types'
import { DeliveryMarks, UnknownSends, type UnknownSend } from './ledger'
import { discardUnknownSend, reconnectPass, recordUnknownSend, type ReconnectPorts } from './pass'

const send: UnknownSend = {
  machineId: 'm-1',
  sessionId: 's-1',
  clientMessageId: 'message-0001',
  text: 'hello',
  at: 1
}
let kv: MemoryKeyValueStore
let ports: ReconnectPorts
let writes: UnknownSend[]
let refreshed: string[]
let time: number
let sleeps: number[]
let statuses: WriteStatus[]
beforeEach(async () => {
  kv = new MemoryKeyValueStore()
  writes = []
  refreshed = []
  time = 0
  sleeps = []
  statuses = [{ status: 'unknown' }]
  ports = {
    sends: new UnknownSends(kv),
    marks: new DeliveryMarks(kv),
    drafts: new Drafts(kv),
    status: async () => (statuses.length > 1 ? statuses.shift()! : statuses[0]!),
    write: async (s) => {
      writes.push(s)
      return { status: 'accepted' }
    },
    now: () => time,
    sleep: async (ms) => {
      sleeps.push(ms)
      time += ms
    },
    refreshRequests: async (id) => {
      refreshed.push(`requests:${id}`)
    },
    refreshHistory: async (m, s) => {
      refreshed.push(`history:${m}:${s}`)
    }
  }
  await recordUnknownSend(send, 'Connection lost', ports)
  await new Drafts(kv).set('m-1', 's-1', 'hello')
})
const run = (): ReturnType<typeof reconnectPass> =>
  reconnectPass(
    {
      machineId: 'm-1',
      openConversations: [{ sessionId: 's-1' }]
    },
    ports
  )

describe('reconnect, the five-status table', () => {
  it('accepted removes only the matching draft and delivery record without sending', async () => {
    statuses = [{ status: 'accepted', at: 5 }]
    expect((await run()).outcomes[0]!.outcome.kind).toBe('sent')
    expect(writes).toEqual([])
    expect(await ports.sends.list()).toEqual([])
    expect(await ports.drafts.get('m-1', 's-1')).toBe('')
    expect(await ports.marks.get('m-1', 's-1')).toBeNull()
  })
  it('accepted preserves text edited since the lost send', async () => {
    await new Drafts(kv).set('m-1', 's-1', 'new draft')
    statuses = [{ status: 'accepted' }]
    await run()
    expect(await ports.drafts.get('m-1', 's-1')).toBe('new draft')
  })
  it('pending waits with backoff up to 60 seconds, retains the draft, then marks unknown', async () => {
    statuses = [{ status: 'pending' }]
    expect((await run()).outcomes[0]!.outcome.kind).toBe('unknown')
    expect(time).toBe(60_000)
    expect(sleeps.slice(0, 4)).toEqual([1000, 2000, 4000, 8000])
    expect(Math.max(...sleeps)).toBe(8000)
    expect(await ports.drafts.get('m-1', 's-1')).toBe('hello')
    expect(writes).toEqual([])
    expect((await ports.marks.get('m-1', 's-1'))?.kind).toBe('unknown')
  })
  it('pending later accepted clears without a retry', async () => {
    statuses = [{ status: 'pending' }, { status: 'accepted' }]
    expect((await run()).outcomes[0]!.outcome.kind).toBe('sent')
    expect(writes).toEqual([])
  })
  it('rejected retains text and the reason; it never reuses that ID', async () => {
    statuses = [{ status: 'rejected', reason: 'server restarted before dispatch' }]
    await run()
    expect(await ports.drafts.get('m-1', 's-1')).toBe('hello')
    expect(await ports.marks.get('m-1', 's-1')).toMatchObject({
      kind: 'rejected',
      reason: 'server restarted before dispatch'
    })
    expect(await ports.sends.list()).toEqual([])
    expect(writes).toEqual([])
  })
  it('absent completes the same bytes and ID once', async () => {
    statuses = [{ status: 'absent' }]
    expect((await run()).outcomes[0]!.outcome.kind).toBe('sent')
    expect(writes).toEqual([send])
    expect(await ports.sends.list()).toEqual([])
  })
  it('a second lost absent write is unknown; it cannot send a second retry', async () => {
    statuses = [{ status: 'absent' }]
    ports = {
      ...ports,
      write: async (s) => {
        writes.push(s)
        throw new ServerError('network', 'Connection lost')
      }
    }
    expect((await run()).outcomes[0]!.outcome.kind).toBe('unknown')
    expect(writes).toEqual([send])
    expect(await ports.sends.list()).toEqual([send])
  })
  it('unknown sends nothing across a restart or repeated reconnections', async () => {
    ports = {
      ...ports,
      sends: new UnknownSends(kv),
      marks: new DeliveryMarks(kv),
      drafts: new Drafts(kv)
    }
    await run()
    await run()
    expect(writes).toEqual([])
    expect(await ports.sends.list()).toEqual([send])
    expect(await ports.drafts.get('m-1', 's-1')).toBe('hello')
    expect(await ports.marks.get('m-1', 's-1')).toMatchObject({ kind: 'unknown' })
  })
  it('an unavailable status route never becomes permission to retry', async () => {
    ports = {
      ...ports,
      status: async () => {
        throw new ServerError('protocol', 'Not found', { status: 404 })
      }
    }
    expect((await run()).outcomes[0]!.outcome.kind).toBe('unknown')
    expect(writes).toEqual([])
  })
  it('does not reconcile another machine or send a plain unsent draft', async () => {
    await ports.sends.add({ ...send, machineId: 'other', clientMessageId: 'other-message' })
    await new Drafts(kv).set('m-1', 'unsent', 'do not send')
    await run()
    expect(writes).toEqual([])
    expect(await ports.sends.forMachine('other')).toHaveLength(1)
    expect(await ports.drafts.get('m-1', 'unsent')).toBe('do not send')
    expect(refreshed).toEqual(['requests:m-1', 'history:m-1:s-1'])
  })
  it('refreshes pending requests and open history even when delivery stays unknown', async () => {
    const report = await run()
    expect(report.requestsRefreshed).toBe(true)
    expect(report.historyRefreshed).toEqual(['s-1'])
    expect(report.refreshFailures).toEqual([])
  })
  it('a request refresh failure does not skip open history', async () => {
    ports = {
      ...ports,
      refreshRequests: async () => {
        throw new Error('offline')
      }
    }
    const report = await run()
    expect(report.requestsRefreshed).toBe(false)
    expect(report.historyRefreshed).toEqual(['s-1'])
    expect(report.refreshFailures).toHaveLength(1)
  })
  it('an explicit discard removes the tracking and delivery mark', async () => {
    await discardUnknownSend(send, ports)
    expect(await ports.sends.list()).toEqual([])
    expect(await ports.marks.get('m-1', 's-1')).toBeNull()
    expect(writes).toEqual([])
  })
})

it('concurrent lost sends survive storage read-modify-write without dropping an ID', async () => {
  const sends = new UnknownSends(kv)
  await Promise.all([
    sends.add({ ...send, clientMessageId: 'parallel-one' }),
    sends.add({ ...send, clientMessageId: 'parallel-two' })
  ])
  expect((await sends.list()).map((s) => s.clientMessageId)).toEqual(
    expect.arrayContaining(['parallel-one', 'parallel-two'])
  )
})
