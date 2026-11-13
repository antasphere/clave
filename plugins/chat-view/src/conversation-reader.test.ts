import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { TimelinePage } from '@clave/contract/timeline'
import type {
  SessionEvent,
  SessionPosition,
  SessionStream
} from '../../../src/shared/session-model'
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
      page: (p, replace, truncated, preserve) => {
        snapshot(p, replace, truncated)
        conversation = reduceConversation(
          conversation,
          replace ? { snapshot: p.items, preserve } : { prepend: p.items }
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

describe('hosted drafts across refreshed snapshots', () => {
  const request = {
    type: 'permission_request' as const,
    id: 'clave:refresh',
    description: 'Your details',
    input: { tool: 'clave_request_input' },
    options: [{ id: 'answer', label: 'Approve' }]
  }
  const draft = {
    type: 'permission_updated' as const,
    id: request.id,
    answers: { when: 'Tuesday' }
  }
  const retained = (key = 'name', value: string | string[] = 'Luca'): TimelinePage => ({
    ...page([], 2),
    items: [
      { event: request, position: position(1) },
      { event: { ...draft, answers: { [key]: value, when: 'Tuesday' } }, position: position(2) }
    ]
  })
  const form = (h: ReturnType<typeof setup>): Extract<Entry, { kind: 'permission' }> => {
    const entry = h.entries().find((entry) => entry.kind === 'permission')
    if (entry?.kind !== 'permission') throw new Error('Missing hosted form')
    return entry
  }
  const mount = async (snapshot = retained()): Promise<ReturnType<typeof setup>> => {
    const h = setup(vi.fn(async () => snapshot))
    h.reader.stream({ kind: 'event', event: request })
    h.reader.stream({ kind: 'event', event: draft })
    h.reader.start()
    await settle()
    expect(form(h).draft).toEqual({ when: 'Tuesday' })
    return h
  }
  it.each([
    { key: 'name', value: 'Luca' },
    { key: 'colours', value: ['blue'] }
  ])(
    'keeps a cleared $key through Retry, gap repair and both reconnect orderings',
    async ({ key, value }) => {
      const snapshot = retained(key, value)
      const h = await mount(snapshot)
      h.reader.retry()
      await settle()
      expect(form(h).draft).toEqual({ when: 'Tuesday' })
      h.timeline.mockResolvedValue({
        ...snapshot,
        cursor: position(4),
        items: [...snapshot.items, ...page([3, 4]).items]
      })
      h.reader.stream(frame(4))
      await settle()
      expect(form(h).draft).toEqual({ when: 'Tuesday' })
      h.reader.reconnect()
      await settle()
      expect(form(h).draft).toEqual({ when: 'Tuesday' })
      h.reader.stream({ kind: 'event', event: request })
      h.reader.stream({ kind: 'event', event: draft })
      expect(form(h).draft).toEqual({ when: 'Tuesday' })
      h.reader.reconnect()
      h.reader.stream({ kind: 'event', event: request })
      h.reader.stream({ kind: 'event', event: draft })
      await settle()
      expect(form(h).draft).toEqual({ when: 'Tuesday' })
      expect(h.entries().filter((entry) => entry.kind === 'user')).toHaveLength(2)
      expect(h.failed).not.toHaveBeenCalled()
    }
  )
  it('takes a later positioned agent fill while retaining other current fields and private typing', async () => {
    const h = await mount()
    h.reader.stream({
      kind: 'event',
      event: { ...draft, typed: true, answers: { note: 'Private' } }
    })
    const update = { ...draft, answers: { name: 'Later agent fill' } }
    h.timeline.mockResolvedValue({
      ...retained(),
      cursor: position(3),
      items: [...retained().items, { event: update, position: position(3) }]
    })
    h.reader.retry()
    await settle()
    expect(form(h)).toMatchObject({
      draft: { name: 'Later agent fill', when: 'Tuesday' },
      typed: { note: 'Private' }
    })
    h.reader.stream({ kind: 'event', event: update, position: position(3) })
    expect(h.event.mock.calls.filter(([item]) => item.event === update)).toHaveLength(0)
  })
  it('takes a full pending form arriving after a reconnect snapshot, including omitted cleared fields', async () => {
    const h = await mount()
    h.reader.stream({
      kind: 'event',
      event: { ...draft, answers: { name: 'Now filled' } },
      position: position(3)
    })
    h.reader.stream({
      kind: 'event',
      event: { ...draft, typed: true, answers: { note: 'Old private text' } }
    })
    h.timeline.mockResolvedValue({
      ...retained(),
      cursor: position(3),
      items: [
        ...retained().items,
        { event: { ...draft, answers: { name: 'Now filled' } }, position: position(3) }
      ]
    })
    h.reader.reconnect()
    await settle()
    h.reader.stream({ kind: 'event', event: request })
    h.reader.stream({ kind: 'event', event: draft })
    expect(form(h).draft).toEqual({ when: 'Tuesday' })
    expect(form(h).typed ?? {}).toEqual({})
  })
  it('does not carry private form state into a new generation or a changed question', async () => {
    const h = await mount()
    h.reader.stream({
      kind: 'event',
      event: { ...draft, typed: true, answers: { note: 'Private' } }
    })
    const next = retained()
    h.timeline.mockResolvedValue({
      ...next,
      cursor: position(2, 'new'),
      items: next.items.map((item) => ({
        ...item,
        position: position(item.position.sequence, 'new')
      }))
    })
    h.reader.reconnect()
    await settle()
    expect(form(h).typed).toBeUndefined()
    expect(form(h).draft).toEqual({ name: 'Luca', when: 'Tuesday' })
    h.reader.stream({
      kind: 'event',
      event: { ...draft, typed: true, answers: { note: 'New private' } }
    })
    h.timeline.mockResolvedValue({
      ...next,
      cursor: position(3, 'new'),
      items: [
        ...next.items.map((item) => ({
          ...item,
          position: position(item.position.sequence, 'new')
        })),
        {
          event: { ...request, description: 'Different private question' },
          position: position(3, 'new')
        }
      ]
    })
    h.reader.retry()
    await settle()
    expect(form(h).request.description).toBe('Different private question')
    expect(form(h).typed).toBeUndefined()
    expect(form(h).draft).toBeUndefined()
  })
  it.each([false, true])(
    'does not preserve an open form over a newer settlement (approved: %s)',
    async (approved) => {
      const h = await mount()
      h.reader.stream({
        kind: 'event',
        event: { ...draft, typed: true, answers: { note: 'Private' } }
      })
      const settled: SessionEvent = approved
        ? { ...draft, sent: true, answers: { name: 'Approved' } }
        : { type: 'permission_withdrawn', id: request.id }
      h.timeline.mockResolvedValue({
        ...retained(),
        cursor: position(3),
        items: [...retained().items, { event: settled, position: position(3) }]
      })
      h.reader.retry()
      await settle()
      h.reader.stream({ kind: 'event', event: request })
      expect(form(h)).toMatchObject(
        approved
          ? { answer: 'answer', answers: { name: 'Approved' } }
          : { abandoned: true, answeredElsewhere: true }
      )
    }
  )
  it('replays native prompts from the snapshot rather than preserving hosted-only state', async () => {
    const native = { ...request, input: { turnId: 'native', itemId: 'prompt' } }
    const snapshot = retained()
    snapshot.items[0] = { event: native, position: position(1) }
    const h = setup(vi.fn(async () => snapshot))
    h.reader.start()
    await settle()
    h.reader.stream({
      kind: 'event',
      event: { ...draft, typed: true, answers: { name: 'Local native value' } }
    })
    h.reader.retry()
    await settle()
    expect(form(h).draft).toEqual({ name: 'Luca', when: 'Tuesday' })
    expect(form(h).typed).toBeUndefined()
  })
  it('does not replay an agent fill received before the current subscription overlay', async () => {
    const pending = deferred<TimelinePage>()
    const h = setup(vi.fn(() => pending.promise))
    h.reader.start()
    h.reader.stream({
      kind: 'event',
      event: retained().items[1].event as SessionEvent,
      position: position(2)
    })
    h.reader.stream({ kind: 'event', event: request })
    h.reader.stream({ kind: 'event', event: draft })
    pending.resolve(retained())
    await settle()
    expect(form(h).draft).toEqual({ when: 'Tuesday' })
    expect(
      h.event.mock.calls.filter(([item]) => item.event.type === 'permission_updated')
    ).toHaveLength(1)
  })
})

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

  it.each([false, true])(
    'remounts a form without reapplying an agent fill over server typing (typing in snapshot: %s)',
    async (inSnapshot) => {
      const request = {
        type: 'permission_request' as const,
        id: 'clave:draft',
        description: 'Your details',
        options: [{ id: 'answer', label: 'Approve' }]
      }
      const typing = {
        type: 'permission_updated' as const,
        id: request.id,
        answers: { name: 'Luca P' },
        typed: true
      }
      const snapshot: TimelinePage = {
        ...page([], inSnapshot ? 3 : 2),
        items: [
          { event: request, position: position(1) },
          {
            event: {
              type: 'permission_updated',
              id: request.id,
              answers: { name: 'Luca', when: '2026-11-17' }
            },
            position: position(2)
          },
          ...(inSnapshot ? [{ event: typing, position: position(3) }] : [])
        ]
      }
      // A newly mounted view has no local typedSent action or card cache.
      // Its pending request and server draft arrive before historical replay.
      const h = setup(vi.fn(async () => snapshot))
      h.reader.stream({ kind: 'event', event: request })
      h.reader.stream({ kind: 'event', event: typing })
      h.reader.start()
      await settle()
      expect(h.entries()).toHaveLength(1)
      expect(h.entries()[0]).toMatchObject({
        kind: 'permission',
        typed: { name: 'Luca P' }
      })
      expect((h.entries()[0] as { draft?: object }).draft).toEqual({ when: '2026-11-17' })
    }
  )

  it.each([
    { key: 'name', value: 'Luca' },
    { key: 'colours', value: ['blue'] }
  ])(
    'keeps a cleared hosted $key absent after remount, with other current fields intact',
    async ({ key, value }) => {
      const request = {
        type: 'permission_request' as const,
        id: 'clave:cleared',
        description: 'Your details',
        input: { tool: 'clave_request_input', layout: 'steps' },
        options: [{ id: 'answer', label: 'Approve' }]
      }
      const h = setup(
        vi.fn(async () => ({
          ...page([], 2),
          items: [
            { event: request, position: position(1) },
            {
              event: {
                type: 'permission_updated' as const,
                id: request.id,
                answers: { [key]: value, when: '2026-11-17' }
              },
              position: position(2)
            }
          ]
        }))
      )
      // setDraft removes a no-default field cleared to either '' or []. The
      // complete subscription draft then has only the other current fields.
      h.reader.stream({ kind: 'event', event: request })
      h.reader.stream({
        kind: 'event',
        event: {
          type: 'permission_updated',
          id: request.id,
          answers: { when: '2026-11-17' }
        }
      })
      h.reader.stream({
        kind: 'event',
        event: {
          type: 'permission_updated',
          id: request.id,
          answers: { note: 'Still typed' },
          typed: true
        }
      })
      h.reader.start()
      await settle()
      expect(h.entries()).toHaveLength(1)
      expect(h.entries()[0]).toMatchObject({
        kind: 'permission',
        draft: { when: '2026-11-17' },
        typed: { note: 'Still typed' }
      })
      expect((h.entries()[0] as { draft?: object }).draft).not.toHaveProperty(key)
    }
  )

  it('keeps an entirely emptied hosted draft empty without a typed overlay', async () => {
    const request = {
      type: 'permission_request' as const,
      id: 'clave:empty',
      description: 'Name',
      input: { tool: 'clave_request_input' },
      options: [{ id: 'answer', label: 'Approve' }]
    }
    const h = setup(
      vi.fn(async () => ({
        ...page([], 2),
        items: [
          { event: request, position: position(1) },
          {
            event: {
              type: 'permission_updated' as const,
              id: request.id,
              answers: { name: 'Luca' }
            },
            position: position(2)
          }
        ]
      }))
    )
    h.reader.stream({ kind: 'event', event: request })
    h.reader.start()
    await settle()
    expect(h.entries()).toHaveLength(1)
    expect((h.entries()[0] as { draft?: object }).draft ?? {}).toEqual({})
  })

  it('keeps a newer hosted agent write covered by the snapshot without moving its cursor back', async () => {
    const request = {
      type: 'permission_request' as const,
      id: 'clave:new-write',
      description: 'Name',
      input: { tool: 'clave_request_input' },
      options: [{ id: 'answer', label: 'Approve' }]
    }
    const update = (name: string): Extract<SessionEvent, { type: 'permission_updated' }> => ({
      type: 'permission_updated' as const,
      id: request.id,
      answers: { name }
    })
    const snapshot = deferred<TimelinePage>()
    const h = setup(vi.fn(() => snapshot.promise))
    h.reader.stream({ kind: 'event', event: request })
    h.reader.stream({ kind: 'event', event: update('Current at subscribe') })
    h.reader.start()
    h.reader.stream({ kind: 'event', event: update('Newer agent write'), position: position(3) })
    snapshot.resolve({
      ...page([], 5),
      items: [
        { event: request, position: position(1) },
        { event: update('Historical fill'), position: position(2) },
        { event: update('Newer agent write'), position: position(3) },
        { event: { type: 'user_message', text: 'four' }, position: position(4) },
        { event: { type: 'user_message', text: 'five' }, position: position(5) }
      ]
    })
    await settle()
    expect(h.entries().find((entry) => entry.kind === 'permission')).toMatchObject({
      draft: { name: 'Newer agent write' }
    })
    expect(
      h.event.mock.calls.filter(
        ([item]) =>
          item.event.type === 'permission_updated' &&
          item.event.answers.name === 'Newer agent write'
      )
    ).toHaveLength(1)
    h.reader.stream(frame(4, 'four'))
    h.reader.stream(frame(6, 'six'))
    expect(
      h
        .entries()
        .filter((entry) => entry.kind === 'user')
        .map((entry) => entry.text)
    ).toEqual(['four', 'five', 'six'])
    expect(h.failed).not.toHaveBeenCalled()
  })

  it('preserves historical fills for a native prompt whose subscription has no hosted draft', async () => {
    const request = {
      type: 'permission_request' as const,
      id: 'native:question',
      description: 'Name',
      options: [{ id: 'answer', label: 'Approve' }]
    }
    const h = setup(
      vi.fn(async () => ({
        ...page([], 2),
        items: [
          { event: request, position: position(1) },
          {
            event: {
              type: 'permission_updated' as const,
              id: request.id,
              answers: { name: 'Native fill' }
            },
            position: position(2)
          }
        ]
      }))
    )
    h.reader.stream({ kind: 'event', event: request })
    h.reader.start()
    await settle()
    expect(h.entries()[0]).toMatchObject({ draft: { name: 'Native fill' } })
  })

  it.each([false, true])(
    'keeps a hosted form settled by the later snapshot (approved: %s)',
    async (approved) => {
      const request = {
        type: 'permission_request' as const,
        id: 'clave:settled',
        description: 'Name',
        input: { tool: 'clave_request_input' },
        options: [{ id: 'answer', label: 'Approve' }]
      }
      const settled = approved
        ? {
            type: 'permission_updated' as const,
            id: request.id,
            answers: { name: 'Approved' },
            sent: true
          }
        : { type: 'permission_withdrawn' as const, id: request.id }
      const h = setup(
        vi.fn(async () => ({
          ...page([], 3),
          items: [
            { event: request, position: position(1) },
            {
              event: {
                type: 'permission_updated' as const,
                id: request.id,
                answers: { name: 'Historical fill' }
              },
              position: position(2)
            },
            { event: settled, position: position(3) }
          ]
        }))
      )
      h.reader.stream({ kind: 'event', event: request })
      h.reader.stream({
        kind: 'event',
        event: {
          type: 'permission_updated',
          id: request.id,
          answers: { name: 'Stale subscription' }
        }
      })
      h.reader.start()
      await settle()
      expect(h.entries()).toHaveLength(1)
      expect(h.entries()[0]).toMatchObject({ draft: { name: 'Historical fill' } })
      expect(h.entries()[0]).toMatchObject(
        approved ? { answer: 'answer', answers: { name: 'Approved' } } : { answeredElsewhere: true }
      )
    }
  )

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
