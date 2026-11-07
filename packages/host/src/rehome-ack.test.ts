import { describe, it, expect, vi } from 'vitest'
import { RehomeAck } from './rehome-ack'

/**
 * The ack must never be a latch: an unsolicited acknowledgement (a sidebar
 * move, a window close) must not make a LATER wait for the same id resolve
 * early — that is exactly how the second cross-window move of a tab ran its
 * group placement before the adoption had happened.
 */
describe('RehomeAck', () => {
  it('a wait registered before the ack resolves on it', async () => {
    const ack = new RehomeAck()
    const p = ack.wait(['a'])
    expect(ack.pending()).toEqual(['a'])
    ack.ack(['a'])
    await expect(p).resolves.toBeUndefined()
    expect(ack.pending()).toEqual([])
  })

  it('an unsolicited ack is dropped: the next wait does NOT resolve early', async () => {
    vi.useFakeTimers()
    try {
      const ack = new RehomeAck()
      ack.ack(['a']) // nobody waits — a sidebar move's ack
      let resolved = false
      void ack.wait(['a'], 1000).then(() => {
        resolved = true
      })
      await vi.advanceTimersByTimeAsync(500)
      expect(resolved).toBe(false)
      ack.ack(['a'])
      await vi.advanceTimersByTimeAsync(0)
      expect(resolved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves at the timeout when no ack ever comes, and forgets the waiter', async () => {
    vi.useFakeTimers()
    try {
      const ack = new RehomeAck()
      let resolved = false
      void ack.wait(['a'], 1000).then(() => {
        resolved = true
      })
      await vi.advanceTimersByTimeAsync(999)
      expect(resolved).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(resolved).toBe(true)
      expect(ack.pending()).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for every id, and an ack of one id wakes only that one', async () => {
    vi.useFakeTimers()
    try {
      const ack = new RehomeAck()
      let resolved = false
      void ack.wait(['a', 'b'], 1000).then(() => {
        resolved = true
      })
      ack.ack(['a'])
      await vi.advanceTimersByTimeAsync(0)
      expect(resolved).toBe(false)
      expect(ack.pending()).toEqual(['b'])
      ack.ack(['b'])
      await vi.advanceTimersByTimeAsync(0)
      expect(resolved).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('two waiters on one id both wake, and nothing lingers', async () => {
    const ack = new RehomeAck()
    const p1 = ack.wait(['a'])
    const p2 = ack.wait(['a'])
    ack.ack(['a'])
    await Promise.all([p1, p2])
    expect(ack.pending()).toEqual([])
  })
})
