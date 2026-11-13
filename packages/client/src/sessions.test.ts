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
  it('reads the positioned snapshot under the history deadline, keeping cursor and retention', async () => {
    const ordinary = counting({ id: 's1' })
    const page = {
      items: [],
      before: null,
      cursor: { generation: 'g', sequence: 7 },
      truncated: true
    }
    const history = counting(page)
    expect(await sessionsClient(ordinary.call, history.call).timeline('s1', 200, 50)).toEqual(page)
    expect(history.used()).toBe(1)
    expect(ordinary.used()).toBe(0)
  })
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
    await client.keepOnRecord('t', { window: { key: 'primary', expectedKey: null } })
    expect(payloads).toEqual([
      { id: 't', name: { displayName: 'A', userRenamed: true } },
      { id: 't', page: { url: 'http://127.0.0.1:1' } },
      { id: 't', page: null },
      { id: 't', claudeSessionId: 'after-clear' },
      { id: 't', workspaceId: 'ws-2' },
      { id: 't', workspaceId: null },
      { id: 't', window: { key: 'primary', expectedKey: null } }
    ])
  })
})

describe('a change of a session’s work (PRDCT-4123)', () => {
  it('sends the session and the change, and answers the records the server rewrote', async () => {
    const payloads: unknown[] = []
    const changed = [
      { id: 't', work: null },
      { id: 'u', work: null }
    ]
    const client = {
      sessions: {
        changeWork: ({ payload }: { payload: unknown }) => {
          payloads.push(payload)
          return { changed, renamed: [] }
        }
      }
    }
    const call = (async (run: (c: unknown) => unknown) => run(client)) as unknown as Call
    const offer = { type: 'offer', to: '6f1c2c8e-1b9a-4d6e-9b1a-2f3c4d5e6f70' } as const
    expect(await sessionsClient(call).changeWork('t', offer)).toEqual({ changed, renamed: [] })
    expect(payloads).toEqual([{ id: 't', change: offer }])
  })
})

describe('refusedWrite', () => {
  it('names the field that failed in one line instead of the union tree', async () => {
    const { Schema, ParseResult } = await import('effect')
    const { SessionWrite } = await import('@clave/contract/sessions')
    const { refusedWrite } = await import('./sessions')
    const bad = {
      type: 'user_message',
      text: 'hi',
      attachments: [
        {
          id: 'a',
          delivery: 'session',
          sessionId: 'not a/session',
          name: 'Lane',
          agent: 'Claude Code',
          cwd: '/w'
        }
      ]
    }
    let message = ''
    try {
      Schema.encodeSync(SessionWrite)(bad as never)
    } catch (error) {
      expect(ParseResult.isParseError(error)).toBe(true)
      message = refusedWrite(error as Parameters<typeof refusedWrite>[0])
    }
    expect(message).toMatch(/^Clave could not send this message \(attachments\.0\./)
    expect(message).not.toMatch(/└─|readonly/)
    expect(message.split('\n')).toHaveLength(1)
  })
})
