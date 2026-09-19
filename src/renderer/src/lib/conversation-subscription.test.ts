import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ConversationAPI,
  ConversationEnvelope,
  ConversationSnapshot
} from '../../../shared/agent-session'
import { subscribeConversation } from './conversation-subscription'

const initial: ConversationSnapshot = {
  session: {
    id: 'conversation-test',
    provider: 'pi',
    cwd: '/project',
    createdAt: '',
    updatedAt: '',
    status: 'idle',
    capabilities: { permissions: false, questions: false, resume: true }
  },
  sequence: 0,
  entries: [],
  requests: []
}
const delta = (sequence: number, text: string): ConversationEnvelope => ({
  sessionId: initial.session.id,
  sequence,
  timestamp: '',
  event: { type: 'text-delta', messageId: 'answer', text }
})
afterEach(() => vi.useRealTimers())

describe('conversation subscription', () => {
  it('buffers snapshot races, sorts events and deduplicates without mutating old snapshots', async () => {
    vi.useFakeTimers()
    let receive!: (event: ConversationEnvelope) => void
    let resolve!: (snapshot: ConversationSnapshot) => void
    const cleanup = vi.fn()
    const api = {
      onEvent: (listener) => {
        receive = listener
        return cleanup
      },
      snapshot: vi.fn(
        () =>
          new Promise<ConversationSnapshot>((done) => {
            resolve = done
          })
      )
    } as unknown as ConversationAPI
    const update = vi.fn()
    const stop = subscribeConversation(api, initial.session.id, update, vi.fn())
    receive(delta(2, ' world'))
    receive(delta(1, 'Hello'))
    receive(delta(1, 'Hello'))
    resolve(initial)
    await vi.advanceTimersByTimeAsync(0)
    expect(update.mock.lastCall?.[0].entries[0].text).toBe('Hello world')
    expect(initial.entries).toEqual([])
    receive(delta(2, ' world'))
    expect(update.mock.lastCall?.[0].entries[0].text).toBe('Hello world')
    stop()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('recovers gaps from an authoritative snapshot and does not spin on a stale snapshot', async () => {
    vi.useFakeTimers()
    let receive!: (event: ConversationEnvelope) => void
    const snapshot = vi.fn().mockResolvedValue(initial)
    const api = {
      onEvent: (listener) => {
        receive = listener
        return vi.fn()
      },
      snapshot
    } as unknown as ConversationAPI
    const update = vi.fn()
    const stop = subscribeConversation(api, initial.session.id, update, vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    receive(delta(3, '!'))
    await vi.advanceTimersByTimeAsync(0)
    expect(snapshot).toHaveBeenCalledTimes(2)
    snapshot.mockResolvedValue({
      ...initial,
      sequence: 2,
      entries: [{ kind: 'message', id: 'answer', role: 'assistant', text: 'Recovered' }]
    })
    await vi.advanceTimersByTimeAsync(5000)
    expect(update.mock.lastCall?.[0].entries[0].text).toBe('Recovered!')
    stop()
  })

  it('unsubscribes and ignores a snapshot resolving after unmount', async () => {
    vi.useFakeTimers()
    let resolve!: (snapshot: ConversationSnapshot) => void
    const cleanup = vi.fn()
    const api = {
      onEvent: () => cleanup,
      snapshot: () =>
        new Promise<ConversationSnapshot>((done) => {
          resolve = done
        })
    } as unknown as ConversationAPI
    const update = vi.fn()
    subscribeConversation(api, initial.session.id, update, vi.fn())()
    resolve(initial)
    await vi.advanceTimersByTimeAsync(0)
    expect(update).not.toHaveBeenCalled()
    expect(cleanup).toHaveBeenCalledOnce()
  })
})
