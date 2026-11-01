import { describe, expect, it, vi } from 'vitest'
import type { Call } from './call'
import type { ServerEventEnvelope } from '@clave/contract/events'
import type { RequestSnapshot } from '../../contract/src/requests'
import { requestsClient } from './requests'
import type { PushStatus } from './push-client'

describe('pending request client reconciliation', () => {
  it('does not resurrect a settled request when an older initial query finishes last', async () => {
    const queued: Array<(snapshot: RequestSnapshot) => void> = []
    const call: Call = <A>() => new Promise<A>((resolve) => queued.push((s) => resolve(s as A)))
    const api = requestsClient(call)
    let event!: (envelope: ServerEventEnvelope) => void
    let status!: (status: PushStatus) => void
    const offEvent = vi.fn()
    const offStatus = vi.fn()
    const push = {
      onEvent: (next: typeof event) => {
        event = next
        return offEvent
      },
      onStatus: (next: typeof status) => {
        status = next
        return offStatus
      }
    }
    const snapshots = vi.fn()
    const error = vi.fn()
    const off = api.watch(push, snapshots, error)
    expect(queued).toHaveLength(1)
    event({ id: 'changed', seq: 2, at: 1, event: { _tag: 'requests.changed', revision: 2 } })
    queued[1]({ revision: 2, pending: [] })
    await Promise.resolve()
    const stale = {
      id: 'old',
      sessionId: 's',
      createdAt: 0,
      kind: 'permission' as const,
      description: 'Already answered',
      options: [{ id: 'yes', label: 'Yes' }]
    }
    queued[0]({ revision: 1, pending: [stale] })
    await Promise.resolve()
    expect(snapshots.mock.calls).toEqual([[{ revision: 2, pending: [] }]])
    // A restarted server can begin at revision zero. Reconnect resets the
    // per-connection watermark rather than rejecting its fresh snapshot.
    status('open')
    queued[2]({ revision: 0, pending: [] })
    await Promise.resolve()
    expect(snapshots).toHaveBeenLastCalledWith({ revision: 0, pending: [] })
    off()
    event({ id: 'late', seq: 3, at: 2, event: { _tag: 'requests.changed', revision: 3 } })
    queued[3]({ revision: 3, pending: [stale] })
    await Promise.resolve()
    expect(snapshots).toHaveBeenCalledTimes(2)
    expect(offEvent).toHaveBeenCalledOnce()
    expect(offStatus).toHaveBeenCalledOnce()
    expect(error).not.toHaveBeenCalled()
  })
})
