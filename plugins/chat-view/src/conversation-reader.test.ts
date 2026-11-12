import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { TimelinePage } from '@clave/contract/timeline'
import type { SessionPosition, SessionStream } from '../../../src/shared/session-model'
import {
  conversationReader,
  HANDOFF_MAX_BYTES,
  HANDOFF_MAX_ITEMS,
  type ConversationReader
} from './conversation-reader'
import { emptyConversation, reduceConversation, type Conversation, type Entry } from './reducer'

const position = (sequence: number, generation = 'g'): SessionPosition => ({ generation, sequence })
const frame = (sequence: number, text = 'same', generation = 'g'): SessionStream => ({
  kind: 'event',
  event: { type: 'user_message', text },
  position: position(sequence, generation)
})
const page = (
  sequences: number[],
  sequence = sequences.at(-1) ?? 0,
  generation = 'g'
): TimelinePage => ({
  items: sequences.map((n) => ({
    event: { type: 'user_message' as const, text: 'same' },
    position: position(n, generation)
  })),
  before: null,
  cursor: position(sequence, generation),
  truncated: false
})
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
  vi.useRealTimers()
})
function setup(timeline = vi.fn<() => Promise<TimelinePage | null>>(async () => page([1]))): {
  reader: ConversationReader
  timeline: Mock<() => Promise<TimelinePage | null>>
  snapshot: Mock
  event: Mock
  failed: Mock
  history: Mock
  entries(): Entry[]
  state(): Conversation
} {
  let conversation = { ...emptyConversation, state: 'working' as const, run: 4 }
  const snapshot = vi.fn()
  const event = vi.fn()
  const failed = vi.fn()
  const history = vi.fn(async () => ({
    items: [{ event: { type: 'user_message' as const, text: 'old' } }],
    before: null
  }))
  const reader = conversationReader(
    { timeline, history },
    {
      page: (p, replace, truncated) => {
        snapshot(p, replace, truncated)
        conversation = reduceConversation(
          conversation,
          replace ? { snapshot: p.items } : { prepend: p.items }
        ) as typeof conversation
      },
      event: (item) => {
        event(item)
        conversation = reduceConversation(conversation, item) as typeof conversation
      },
      reading: vi.fn(),
      failed
    }
  )
  cleanups.push(reader.stop)
  return {
    reader,
    timeline,
    snapshot,
    event,
    failed,
    history,
    entries: () => conversation.entries,
    state: () => conversation
  }
}

describe('the positioned snapshot/live handoff', () => {
  it.each([false, true])(
    'takes the current question definition when an older request reused its id (snapshot includes current: %s)',
    async (inSnapshot) => {
      const older = {
        type: 'permission_request' as const,
        id: 'reused',
        description: 'Older public question',
        options: [{ id: 'answer', label: 'Answer' }],
        questions: [{ id: 'value', header: 'Older public field', question: 'Value?', options: [] }],
        input: { turnId: 'older', questions: [{ id: 'value', isSecret: false }] }
      }
      const current = {
        ...older,
        description: 'Current private question',
        questions: [
          { id: 'value', header: 'Current private field', question: 'Value?', options: [] }
        ],
        input: { turnId: 'current', questions: [{ id: 'value', isSecret: true }] }
      }
      const snapshot: TimelinePage = {
        ...page([], inSnapshot ? 5 : 4),
        items: [
          { event: older, position: position(1) },
          {
            event: {
              type: 'permission_updated',
              id: older.id,
              answers: { value: 'old draft' },
              typed: true
            },
            position: position(2)
          },
          { event: { type: 'state_change', state: 'done' }, position: position(3) },
          { event: { type: 'state_change', state: 'blocked' }, position: position(4) },
          ...(inSnapshot ? [{ event: current, position: position(5) }] : [])
        ]
      }
      const h = setup(vi.fn(async () => snapshot))
      h.reader.stream({ kind: 'event', event: current })
      h.reader.start()
      await settle()
      expect(h.entries()).toHaveLength(1)
      expect(h.entries()[0]).toMatchObject({ kind: 'permission', request: current })
      expect(h.entries()[0]).not.toHaveProperty('typed')
    }
  )
  it('keeps a current question’s typed fields when its subscription definition repeats with another key order', async () => {
    const request = {
      type: 'permission_request' as const,
      id: 'request',
      description: 'Choose',
      options: [{ id: 'allow', label: 'Allow' }],
      input: { turnId: 'same', itemId: 'same' }
    }
    const h = setup(
      vi.fn(async () => ({ ...page([], 1), items: [{ event: request, position: position(1) }] }))
    )
    h.reader.start()
    await settle()
    h.reader.stream({
      kind: 'event',
      event: {
        type: 'permission_updated',
        id: request.id,
        answers: { choice: 'current draft' },
        typed: true
      }
    })
    h.reader.stream({
      kind: 'event',
      event: { ...request, input: { itemId: 'same', turnId: 'same' } }
    })
    expect(h.entries()).toHaveLength(1)
    expect(h.entries()[0]).toMatchObject({ typed: { choice: 'current draft' } })
  })
  it('keeps a host pending request and typed fields without duplicating a request already in the timeline', async () => {
    const request = {
      type: 'permission_request' as const,
      id: 'request',
      description: 'Choose',
      options: [{ id: 'allow', label: 'Allow' }]
    }
    const h = setup(
      vi.fn(async () => ({ ...page([], 1), items: [{ event: request, position: position(1) }] }))
    )
    h.reader.stream({ kind: 'event', event: request })
    h.reader.stream({
      kind: 'event',
      event: { type: 'permission_updated', id: 'request', answers: { choice: 'yes' }, typed: true }
    })
    h.reader.start()
    await settle()
    expect(h.entries()).toHaveLength(1)
    expect(h.entries()[0]).toMatchObject({ kind: 'permission', typed: { choice: 'yes' } })
    expect(h.history).not.toHaveBeenCalled()
  })

  it('does not resurrect a subscription request settled in the subsequent snapshot', async () => {
    const request = {
      type: 'permission_request' as const,
      id: 'request',
      description: 'Choose',
      options: [{ id: 'allow', label: 'Allow' }]
    }
    const h = setup(
      vi.fn(async () => ({
        ...page([], 1),
        items: [
          { event: { type: 'permission_withdrawn' as const, id: 'request' }, position: position(1) }
        ]
      }))
    )
    h.reader.stream({ kind: 'event', event: request })
    h.reader.start()
    await settle()
    expect(h.entries()).toHaveLength(0)
  })
  it('takes the latest positioned state covered by the snapshot instead of leaving the subscribe state stale', async () => {
    const h = setup(
      vi.fn(async () => ({
        ...page([], 1),
        items: [
          {
            event: { type: 'state_change' as const, state: 'done' as const, run: 4 },
            position: position(1)
          }
        ]
      }))
    )
    h.reader.start()
    h.reader.stream({
      kind: 'event',
      event: { type: 'state_change', state: 'done', run: 4 },
      position: position(1)
    })
    await settle()
    expect(h.state().state).toBe('done')
  })

  it('keeps the host’s unpositioned subscription state and background snapshot outside transcript deduplication', async () => {
    const h = setup()
    h.reader.stream({ kind: 'event', event: { type: 'state_change', state: 'working', run: 4 } })
    h.reader.stream({ kind: 'event', event: { type: 'background_tasks', tasks: [] } })
    h.reader.start()
    await settle()
    expect(h.snapshot).toHaveBeenCalledOnce()
    expect(h.event).toHaveBeenCalledTimes(2)
    expect(h.entries()).toHaveLength(1)
    expect(h.history).not.toHaveBeenCalled()
  })
  it('starts after subscription and buffers meanwhile; snapshot-covered events occur once', async () => {
    const h = setup()
    h.reader.stream(frame(1))
    expect(h.timeline).not.toHaveBeenCalled()
    h.reader.start()
    await settle()
    expect(h.entries()).toHaveLength(1)
    expect(h.event).not.toHaveBeenCalled()
    expect(h.history).not.toHaveBeenCalled()
    expect(h.state()).toMatchObject({ state: 'working', run: 4 })
  })
  it('applies above-watermark frames in position order, preserving identical messages at distinct positions', async () => {
    const answer = deferred<TimelinePage | null>()
    const h = setup(vi.fn(() => answer.promise))
    h.reader.start()
    h.reader.stream(frame(3))
    h.reader.stream(frame(2))
    h.reader.stream(frame(2))
    answer.resolve(page([1]))
    await settle()
    expect(h.entries()).toHaveLength(3)
    h.reader.stream(frame(3))
    h.reader.stream(frame(1))
    h.reader.stream(frame(4))
    expect(h.entries()).toHaveLength(4)
    expect(h.event).toHaveBeenCalledTimes(3)
  })
  it('repairs a sequence gap by snapshot, without appending out of order or losing the missing event', async () => {
    const answer = deferred<TimelinePage | null>()
    const h = setup(
      vi
        .fn()
        .mockResolvedValueOnce(page([1]))
        .mockImplementation(() => answer.promise)
    )
    h.reader.start()
    await settle()
    h.reader.stream(frame(3))
    expect(h.entries()).toHaveLength(1)
    h.reader.stream(frame(2))
    answer.resolve(page([1, 2, 3]))
    await settle()
    expect(h.entries()).toHaveLength(3)
    h.reader.stream(frame(3))
    expect(h.entries()).toHaveLength(3)
  })
  it('replaces from a reconnect snapshot and ignores an old HTTP response', async () => {
    const old = deferred<TimelinePage | null>()
    const h = setup(
      vi
        .fn()
        .mockImplementationOnce(() => old.promise)
        .mockResolvedValue(page([1, 2]))
    )
    h.reader.start()
    h.reader.reconnect()
    await settle()
    expect(h.entries()).toHaveLength(2)
    old.resolve(page([1]))
    await settle()
    expect(h.entries()).toHaveLength(2)
    h.reader.reconnect()
    await settle()
    expect(h.entries()).toHaveLength(2)
  })
  it('rejects a refresh behind the live cursor without rolling back the visible conversation', async () => {
    vi.useFakeTimers()
    const stale = deferred<TimelinePage | null>()
    const h = setup(
      vi
        .fn()
        .mockResolvedValueOnce(page([1, 2, 3]))
        .mockImplementationOnce(() => stale.promise)
        .mockResolvedValue(page([1, 2, 3, 4, 5]))
    )
    h.reader.start()
    await settle()
    h.reader.stream(frame(4, 'four'))
    h.reader.stream(frame(5, 'five'))
    const visible = h.entries()
    expect(visible).toHaveLength(5)

    h.reader.retry()
    stale.resolve(page([1, 2, 3]))
    await settle()
    expect(h.entries()).toEqual(visible)
    expect(h.entries().slice(-2)).toMatchObject([{ text: 'four' }, { text: 'five' }])
    expect(h.snapshot).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(500)
    expect(h.timeline).toHaveBeenCalledTimes(3)
    expect(h.snapshot).toHaveBeenCalledTimes(2)
    expect(h.entries()).toHaveLength(5)
    h.reader.stream(frame(6, 'after recovery'))
    expect(h.entries()).toHaveLength(6)
    expect(h.entries().at(-1)).toMatchObject({ text: 'after recovery' })
    expect(h.history).not.toHaveBeenCalled()
    expect(h.failed).not.toHaveBeenCalled()
  })
  it('takes a new generation snapshot, clearing old entries even when the new snapshot is empty', async () => {
    const h = setup(
      vi
        .fn()
        .mockResolvedValueOnce(page([1, 2]))
        .mockResolvedValue(page([], 0, 'new'))
    )
    h.reader.start()
    await settle()
    h.reader.reconnect()
    await settle()
    expect(h.entries()).toHaveLength(0)
    const reads = h.timeline.mock.calls.length
    h.reader.stream(frame(3, 'stale old connection'))
    await settle()
    expect(h.timeline).toHaveBeenCalledTimes(reads)
    expect(h.entries()).toHaveLength(0)
  })
  it('a new-generation frame rejects the old in-flight snapshot, and retired-generation frames cannot reset it', async () => {
    const old = deferred<TimelinePage | null>()
    const h = setup(
      vi
        .fn()
        .mockResolvedValueOnce(page([1]))
        .mockImplementationOnce(() => old.promise)
        .mockResolvedValue(page([1], 1, 'new'))
    )
    h.reader.start()
    await settle()
    h.reader.retry()
    h.reader.stream(frame(2, 'new message', 'new'))
    await settle()
    old.resolve(page([1, 2, 3]))
    h.reader.stream(frame(4, 'stale', 'g'))
    await settle()
    expect(h.entries()).toHaveLength(2)
    expect(h.entries().at(-1)).toMatchObject({ text: 'new message' })
  })
  it('retries a raced-generation snapshot without committing it', async () => {
    vi.useFakeTimers()
    const old = deferred<TimelinePage | null>()
    const h = setup(
      vi
        .fn()
        .mockImplementationOnce(() => old.promise)
        .mockResolvedValue(page([1], 1, 'new'))
    )
    h.reader.start()
    h.reader.stream(frame(2, 'new message', 'new'))
    old.resolve(page([1]))
    await settle()
    expect(h.snapshot).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(h.entries()).toHaveLength(2)
  })
  it('does not retire the current generation when a late old-process frame arrives', async () => {
    vi.useFakeTimers()
    const h = setup(vi.fn(async () => page([1], 1, 'current')))
    h.reader.start()
    await settle()
    h.reader.stream(frame(99, 'late old frame', 'old-process'))
    await settle()
    h.reader.stream(frame(2, 'current reply', 'current'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.entries().map((e) => ('text' in e ? e.text : ''))).toEqual(['same', 'current reply'])
    expect(h.failed).not.toHaveBeenCalled()
    const reads = h.timeline.mock.calls.length
    h.reader.stream(frame(100, 'another old frame', 'old-process'))
    await settle()
    expect(h.timeline).toHaveBeenCalledTimes(reads)
  })
  it('keeps a current reply arriving while a late old-process frame is being refreshed', async () => {
    const refresh = deferred<TimelinePage | null>()
    const h = setup(
      vi
        .fn()
        .mockResolvedValueOnce(page([1], 1, 'current'))
        .mockImplementation(() => refresh.promise)
    )
    h.reader.start()
    await settle()
    h.reader.stream(frame(99, 'late old frame', 'old-process'))
    await settle()
    expect(h.timeline).toHaveBeenCalledTimes(2)
    // The authoritative answer is still held when the current process speaks.
    h.reader.stream(frame(2, 'current reply', 'current'))
    refresh.resolve(page([1], 1, 'current'))
    await settle()
    expect(h.entries().map((e) => ('text' in e ? e.text : ''))).toEqual(['same', 'current reply'])
    expect(h.failed).not.toHaveBeenCalled()
    expect(h.history).not.toHaveBeenCalled()
  })
  it('only an explicit unsupported result uses frozen history and preserves buffered legacy live events', async () => {
    const h = setup(vi.fn(async () => null))
    h.reader.start()
    h.reader.stream({ kind: 'event', event: { type: 'user_message', text: 'new' } })
    await settle()
    expect(h.history).toHaveBeenCalledTimes(1)
    expect(h.entries().map((e) => ('text' in e ? e.text : ''))).toEqual(['old', 'new'])
  })
  it('shows real failures after bounded retries, never an empty/fallback transcript; Retry can recover', async () => {
    vi.useFakeTimers()
    const h = setup(vi.fn().mockRejectedValue(new Error('HTTP 500')))
    h.reader.start()
    await vi.advanceTimersByTimeAsync(121000)
    expect(h.failed).toHaveBeenCalled()
    expect(h.history).not.toHaveBeenCalled()
    expect(h.snapshot).not.toHaveBeenCalled()
    h.timeline.mockResolvedValue(page([1]))
    h.reader.retry()
    await settle()
    expect(h.entries()).toHaveLength(1)
  })
  it('stops retries and all callbacks after unmount', async () => {
    vi.useFakeTimers()
    const answer = deferred<TimelinePage | null>()
    const h = setup(vi.fn(() => answer.promise))
    h.reader.start()
    h.reader.stop()
    answer.resolve(page([1]))
    await settle()
    h.reader.stream(frame(2))
    h.reader.retry()
    h.reader.reconnect()
    await vi.advanceTimersByTimeAsync(121000)
    expect(h.snapshot).not.toHaveBeenCalled()
    expect(h.event).not.toHaveBeenCalled()
    expect(h.failed).not.toHaveBeenCalled()
  })
  it('bounds the handoff buffer; an overflowing prefix must be covered by the snapshot and retention remains explicit', async () => {
    const answer = deferred<TimelinePage | null>()
    const h = setup(vi.fn(() => answer.promise))
    h.reader.start()
    for (let n = 1; n <= HANDOFF_MAX_ITEMS + 2; n++) h.reader.stream(frame(n))
    answer.resolve({ ...page([HANDOFF_MAX_ITEMS + 2]), truncated: true })
    await settle()
    expect(h.entries()).toHaveLength(1)
    expect(h.reader.source().truncated).toBe(true)
    expect(h.snapshot.mock.calls[0][2]).toBe(true)
  })
  it.each([1, 2])(
    'keeps the highest discarded position across %i late-low overflows',
    async (rounds) => {
      vi.useFakeTimers()
      const answer = deferred<TimelinePage | null>()
      const last = rounds * HANDOFF_MAX_ITEMS + 1
      const h = setup(
        vi
          .fn()
          .mockImplementationOnce(() => answer.promise)
          .mockResolvedValue({ ...page([last]), truncated: true })
      )
      h.reader.start()
      for (let round = 0; round < rounds; round++) {
        for (let n = 2 + round * HANDOFF_MAX_ITEMS; n <= 1 + (round + 1) * HANDOFF_MAX_ITEMS; n++)
          h.reader.stream(frame(n))
        h.reader.stream(frame(1))
      }
      answer.resolve(page([1]))
      await settle()
      expect(h.snapshot).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(500)
      expect(h.timeline).toHaveBeenCalledTimes(2)
      expect(h.entries()).toHaveLength(1)
      expect(h.reader.source().truncated).toBe(true)
      h.reader.stream(frame(last + 1, 'after recovery'))
      expect(h.entries().at(-1)).toMatchObject({ text: 'after recovery' })
      expect(h.failed).not.toHaveBeenCalled()
    }
  )
  it('requires a byte-overflow snapshot to cover the higher position it discarded', async () => {
    vi.useFakeTimers()
    const answer = deferred<TimelinePage | null>()
    const h = setup(
      vi
        .fn()
        .mockImplementationOnce(() => answer.promise)
        .mockResolvedValue(page([1, 2]))
    )
    h.reader.start()
    const large = 'x'.repeat(Math.floor(HANDOFF_MAX_BYTES / 4))
    h.reader.stream(frame(2, large))
    h.reader.stream(frame(1, large))
    answer.resolve(page([1]))
    await settle()
    expect(h.snapshot).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(500)
    expect(h.entries()).toHaveLength(2)
    expect(h.failed).not.toHaveBeenCalled()
  })
  it('keeps pagination on the positioned source and refuses old-generation pages', async () => {
    const h = setup()
    h.reader.start()
    await settle()
    const source = h.reader.source()
    h.timeline.mockResolvedValue(page([], 1))
    await source.read(1, 20)
    expect(h.timeline).toHaveBeenLastCalledWith(1, 20)
    expect(h.history).not.toHaveBeenCalled()
    h.timeline.mockResolvedValue(page([], 0, 'new'))
    await expect(source.read(1)).rejects.toThrow('generation')
    expect(source.current()).toBe(false)
  })
  it('drops an earlier-page response racing a reconnect', async () => {
    const h = setup()
    h.reader.start()
    await settle()
    const answer = deferred<TimelinePage | null>()
    const source = h.reader.source()
    h.timeline.mockImplementationOnce(() => answer.promise)
    const earlier = source.read(1)
    h.reader.reconnect()
    await settle()
    answer.resolve(page([1]))
    await expect(earlier).rejects.toThrow('changed')
  })
})
