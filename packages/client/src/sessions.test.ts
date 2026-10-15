import { describe, expect, it } from 'vitest'
import { HISTORY_TIMEOUT_MS, PATIENT_TIMEOUT_MS } from './api'
import type { Call } from './call'
import { sessionsClient } from './sessions'

/** A call that answers `value` without reaching any server, and counts. */
function counting(value: unknown): { call: Call; used: () => number } {
  let used = 0
  const call = (async () => {
    used += 1
    return value
  }) as unknown as Call
  return { call, used: () => used }
}

describe('the history deadline (PRDCT-3526)', () => {
  it('a page of the past goes through the history call, the rest through the ordinary one', async () => {
    const ordinary = counting({ id: 's1' })
    const history = counting({ items: [], before: null })
    const client = sessionsClient(ordinary.call, history.call)
    await client.history('s1')
    await client.history('s1', 200, 50)
    expect(history.used()).toBe(2)
    expect(ordinary.used()).toBe(0)
    await client.get('s1')
    await client.capabilities('s1')
    expect(ordinary.used()).toBe(2)
    expect(history.used()).toBe(2)
  })

  it('without a history call, history takes the ordinary one', async () => {
    const ordinary = counting({ items: [], before: null })
    await sessionsClient(ordinary.call).history('s1')
    expect(ordinary.used()).toBe(1)
  })

  it('the history deadline sits between the ordinary ten seconds and the patient one', () => {
    expect(HISTORY_TIMEOUT_MS).toBeGreaterThan(10_000)
    expect(HISTORY_TIMEOUT_MS).toBeLessThan(PATIENT_TIMEOUT_MS)
  })
})

describe('what the window keeps on a record (PRDCT-3526, round 2 of the verifier, G1)', () => {
  /** A call that hands the request client a double and keeps the payload. */
  function capturing(): { call: Call; payloads: unknown[] } {
    const payloads: unknown[] = []
    const client = {
      sessions: {
        keepOnRecord: ({ payload }: { payload: unknown }) => {
          payloads.push(payload)
          return undefined
        }
      }
    }
    const call = (async (run: (c: unknown) => unknown) => run(client)) as unknown as Call
    return { call, payloads }
  }

  it('sends each field the window gave, and none it did not', async () => {
    const { call, payloads } = capturing()
    const client = sessionsClient(call)
    await client.keepOnRecord('t', { name: { displayName: 'A', userRenamed: true } })
    await client.keepOnRecord('t', { page: { url: 'http://127.0.0.1:1' } })
    await client.keepOnRecord('t', { page: null })
    await client.keepOnRecord('t', { claudeSessionId: 'after-clear' })
    await client.keepOnRecord('t', { workspaceId: 'ws-2' })
    await client.keepOnRecord('t', { workspaceId: null })
    expect(payloads).toEqual([
      { id: 't', name: { displayName: 'A', userRenamed: true } },
      { id: 't', page: { url: 'http://127.0.0.1:1' } },
      { id: 't', page: null },
      { id: 't', claudeSessionId: 'after-clear' },
      { id: 't', workspaceId: 'ws-2' },
      { id: 't', workspaceId: null }
    ])
  })
})
