import { describe, it, expect } from 'vitest'
import { GitQueue } from './git-queue'

/**
 * The app-wide git queue (PRDCT-3775): one limit for every background read,
 * whoever asks, and no read repeated while an identical one is still waiting.
 */

interface Gate {
  promise: Promise<void>
  open: () => void
}
const gate = (): Gate => {
  let open!: () => void
  const promise = new Promise<void>((resolve) => (open = resolve))
  return { promise, open }
}
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('GitQueue', () => {
  it('never runs more than its limit, however many batches pile up', async () => {
    const queue = new GitQueue(4, 2)
    let running = 0
    let peak = 0
    const gates: Gate[] = []
    const job = async (): Promise<void> => {
      running++
      peak = Math.max(peak, running)
      const g = gate()
      gates.push(g)
      await g.promise
      running--
    }
    // Three stacked "rounds" of fifty repos each — what the old timers did.
    const all: Promise<void>[] = []
    for (let round = 0; round < 3; round++) {
      for (let repo = 0; repo < 50; repo++) {
        all.push(queue.run(`status:/r${repo}:${round}`, 'status', job))
      }
    }
    while (all.length > 0 && (gates.length > 0 || running > 0)) {
      await flush()
      expect(running).toBeLessThanOrEqual(4)
      const g = gates.shift()
      if (!g) break
      g.open()
    }
    await Promise.all(all)
    expect(peak).toBe(4)
  })

  it('shares a job that is still waiting, and never one that already started', async () => {
    const queue = new GitQueue(1, 1)
    const blocker = gate()
    let calls = 0
    const first = queue.run('status:/a', 'status', async () => {
      calls++
      await blocker.promise
      return 'first'
    })
    await flush()
    // /a is running: a new ask must not get the running read's answer.
    const second = queue.run('status:/a', 'status', async () => {
      calls++
      return 'second'
    })
    // ...and a third ask while the second waits shares the second.
    const third = queue.run('status:/a', 'status', async () => {
      calls++
      return 'third'
    })
    expect(third).toBe(second)
    blocker.open()
    expect(await first).toBe('first')
    expect(await second).toBe('second')
    expect(await third).toBe('second')
    expect(calls).toBe(2)
  })

  it('starts waiting status reads before waiting fetches', async () => {
    const queue = new GitQueue(1, 1)
    const order: string[] = []
    const blocker = gate()
    const head = queue.run('fetch:/x', 'fetch', async () => {
      await blocker.promise
    })
    await flush()
    const f = queue.run('fetch:/y', 'fetch', async () => {
      order.push('fetch')
    })
    const s = queue.run('status:/y', 'status', async () => {
      order.push('status')
    })
    blocker.open()
    await Promise.all([head, f, s])
    expect(order).toEqual(['status', 'fetch'])
  })

  it('keeps slots for status reads while fetches are slow', async () => {
    const queue = new GitQueue(3, 1)
    const slow = gate()
    const fetches = [0, 1, 2].map((i) =>
      queue.run(`fetch:/f${i}`, 'fetch', async () => {
        await slow.promise
      })
    )
    await flush()
    expect(queue.stats()).toEqual({ running: 1, runningFetches: 1, queued: 2 })
    let statusRan = false
    await queue.run('status:/s', 'status', async () => {
      statusRan = true
    })
    expect(statusRan).toBe(true)
    slow.open()
    await Promise.all(fetches)
    expect(queue.stats()).toEqual({ running: 0, runningFetches: 0, queued: 0 })
  })

  it('passes a failure to its callers and frees the slot', async () => {
    const queue = new GitQueue(1, 1)
    await expect(
      queue.run('status:/bad', 'status', async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(await queue.run('status:/ok', 'status', async () => 'ok')).toBe('ok')
    expect(queue.stats().running).toBe(0)
  })
})
