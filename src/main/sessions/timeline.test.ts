import type { TimelinePage, SessionPosition } from '@clave/contract/timeline'
import { describe, expect, it, vi } from 'vitest'
import type { HistoryItem, Session, SessionStream } from '../../shared/session-model'
// The Echo with a conversation history, a test fixture: the app's Echo replays nothing.
import { HistoryEchoAdapter } from './adapters/echo-history.fixture'
import { SessionManager } from './session-manager'
import { SessionTimeline, TIMELINE_MAX_BYTES, TIMELINE_MAX_ITEMS } from './timeline'

const session: Session = {
  id: 'ordered',
  provider: 'echo',
  adapterId: 'echo',
  transport: 'events',
  cwd: '/tmp',
  windowKey: 'test',
  state: 'idle',
  createdAt: 1,
  title: 'Ordering'
}
const timeline = (manager: SessionManager, before?: number, limit?: number): TimelinePage =>
  manager.timeline(session.id, before, limit)
const position = (stream: SessionStream): SessionPosition | undefined =>
  stream.kind === 'event' ? stream.position : undefined

async function fixture(): Promise<{ manager: SessionManager; adapter: HistoryEchoAdapter }> {
  const manager = new SessionManager()
  const adapter = new HistoryEchoAdapter()
  manager.registerAdapter(adapter)
  await manager.create(session)
  return { manager, adapter }
}

describe('server-authoritative conversation positions', () => {
  it('keeps legitimate identical messages distinct and joins each stream event to history', async () => {
    const { manager } = await fixture()
    const streams: SessionStream[] = []
    manager.subscribe(session.id, (stream) => streams.push(stream))
    await manager.write(session.id, { type: 'user_message', text: 'same' })
    await manager.write(session.id, { type: 'user_message', text: 'same' })
    expect(streams.every((stream) => position(stream) !== undefined)).toBe(true)
    const page = timeline(manager)
    expect(page).toBeDefined()
    expect(page!.items.filter(({ event }) => event.type === 'user_message')).toHaveLength(2)
    expect(page!.items.filter(({ event }) => event.type === 'assistant_text')).toHaveLength(2)
    expect(page!.items.map((item) => item.position)).toEqual(streams.map(position))
    expect(new Set(page!.items.map((item) => item.position.sequence)).size).toBe(streams.length)
  })

  it('captures an event emitted during the initial history read after its historical prefix', async () => {
    const { manager, adapter } = await fixture()
    vi.spyOn(adapter, 'history').mockImplementationOnce(() => {
      adapter.inject(session.id, {
        kind: 'event',
        event: { type: 'assistant_text', delta: 'during', final: true }
      })
      return [{ event: { type: 'user_message', text: 'past' }, at: 1 }]
    })
    const streams: SessionStream[] = []
    manager.subscribe(session.id, (stream) => streams.push(stream))
    const page = timeline(manager)
    expect(page).toBeDefined()
    expect(page!.items.map(({ event }) => event.type)).toEqual(['user_message', 'assistant_text'])
    expect(page!.items[1].position).toEqual(position(streams[0]))
    expect(page!.cursor).toEqual(page!.items[1].position)
  })

  it('retains events before the first timeline read without reading live adapter history twice', async () => {
    const { manager, adapter } = await fixture()
    const history = vi.spyOn(adapter, 'history')
    await manager.write(session.id, { type: 'user_message', text: 'before-open' })
    const first = timeline(manager)
    const second = timeline(manager)
    expect(first).toBeDefined()
    expect(first!.items.filter(({ event }) => event.type === 'user_message')).toHaveLength(1)
    expect(second).toEqual(first)
    expect(history).toHaveBeenCalledTimes(1)
  })

  it('captures a prompt sent by ready once in both the timeline and the live stream', async () => {
    const { manager, adapter } = await fixture()
    vi.spyOn(adapter, 'ready').mockImplementation((handle) =>
      adapter.write(handle, { type: 'user_message', text: 'Initial prompt' })
    )
    const streams: SessionStream[] = []
    manager.subscribe(session.id, (stream) => streams.push(stream))
    manager.ready(session.id)
    const items = timeline(manager).items.filter(({ event }) => event.type === 'user_message')
    const live = streams.filter(
      (stream) => stream.kind === 'event' && stream.event.type === 'user_message'
    )
    expect(items).toHaveLength(1)
    expect(live).toHaveLength(1)
    expect(items[0].position).toEqual(position(live[0]))
  })

  it('keeps a failed launch history read failed instead of returning an empty snapshot', async () => {
    const { manager, adapter } = await fixture()
    const error = new Error('Launch history could not be read')
    const history = vi.spyOn(adapter, 'history').mockImplementation(() => {
      throw error
    })
    expect(() => timeline(manager)).toThrow(error)
    expect(() => timeline(manager)).toThrow(error)
    expect(history).toHaveBeenCalledTimes(1)
  })

  it('gives a snapshot watermark that separates buffered events arriving while HTTP is in flight', async () => {
    const { manager } = await fixture()
    await manager.write(session.id, { type: 'user_message', text: 'old' })
    const buffered: SessionStream[] = []
    const off = manager.subscribe(session.id, (stream) => buffered.push(stream))
    const captured = timeline(manager)
    expect(captured).toBeDefined()
    const response = Promise.resolve(captured!)
    await manager.write(session.id, { type: 'user_message', text: 'new' })
    const page = await response
    const later = buffered.filter(
      (stream) =>
        position(stream)!.generation === page.cursor.generation &&
        position(stream)!.sequence > page.cursor.sequence
    )
    expect(page.items.map(({ position }) => position.sequence)).not.toContain(
      position(later[0])!.sequence
    )
    expect(
      later.filter((stream) => stream.kind === 'event' && stream.event.type === 'user_message')
    ).toHaveLength(1)
    off()
    await manager.write(session.id, { type: 'user_message', text: 'while-closed' })
    const reopened = timeline(manager)!
    expect(reopened.items.filter(({ event }) => event.type === 'user_message')).toHaveLength(3)
    expect(reopened.cursor.sequence).toBeGreaterThan(page.cursor.sequence)
  })

  it('changes generation on provider attach, re-adoption and a new manager', async () => {
    const { manager, adapter } = await fixture()
    const initial = timeline(manager)
    expect(initial).toBeDefined()
    await manager.attach(session.id)
    const attached = timeline(manager)!
    expect(attached.cursor.generation).not.toBe(initial!.cursor.generation)
    manager.forget(session.id)
    manager.adopt(session, { id: session.id }, adapter)
    expect(timeline(manager)!.cursor.generation).not.toBe(attached.cursor.generation)
    const restarted = await fixture()
    expect(timeline(restarted.manager)!.cursor.generation).not.toBe(
      timeline(manager)!.cursor.generation
    )
  })
})

describe('bounded timeline paging', () => {
  it('keeps a tool call and its result together when the requested page starts inside the pair', async () => {
    const { manager, adapter } = await fixture()
    const events = [
      { type: 'user_message', text: 'Read the file' },
      { type: 'tool_call', id: 'read-file', name: 'Read', input: {} },
      { type: 'tool_result', id: 'read-file', output: 'File contents' },
      { type: 'assistant_text', delta: 'Done', final: true }
    ] as const
    for (const event of events) adapter.inject(session.id, { kind: 'event', event })
    const page = timeline(manager, undefined, 2)
    expect(page.items.map(({ event }) => event.type)).toEqual([
      'tool_call',
      'tool_result',
      'assistant_text'
    ])
    expect(page.before).toBe(2)
    expect(timeline(manager, page.before!).items.map(({ event }) => event.type)).toEqual([
      'user_message'
    ])
  })

  it('keeps older page cursors absolute while new events arrive and eviction is visible', async () => {
    const { manager, adapter } = await fixture()
    for (let i = 0; i < 2005; i++)
      adapter.inject(session.id, {
        kind: 'event',
        event: { type: 'user_message', text: String(i) }
      })
    const newest = timeline(manager, undefined, 2)
    expect(newest.truncated).toBe(true)
    expect(newest.items.map(({ position }) => position.sequence)).toEqual([2004, 2005])
    expect(newest.before).toBe(2004)
    adapter.inject(session.id, { kind: 'event', event: { type: 'user_message', text: 'later' } })
    const older = timeline(manager, newest.before!, 2)
    expect(older.items.map(({ position }) => position.sequence)).toEqual([2002, 2003])
    expect(older.cursor.sequence).toBe(2006)
    expect(timeline(manager, 1).items).toEqual([])
    expect(timeline(manager, 1).truncated).toBe(true)
  })
  it('reports byte-bound loss while keeping the live event position above the previous cursor', async () => {
    const { manager, adapter } = await fixture()
    const before = timeline(manager)
    let received: SessionStream | undefined
    manager.subscribe(session.id, (stream) => {
      received = stream
    })
    adapter.inject(session.id, {
      kind: 'event',
      event: { type: 'assistant_text', delta: 'x'.repeat(1024 * 1024), final: true }
    })
    const after = timeline(manager)
    expect(after.items).toEqual([])
    expect(after.truncated).toBe(true)
    expect(after.cursor.sequence).toBeGreaterThan(before.cursor.sequence)
    expect(position(received!)).toEqual(after.cursor)
  })
  it('does not retain raw provider frames or eagerly read dormant histories', async () => {
    const { manager, adapter } = await fixture()
    const read = vi.spyOn(adapter, 'history')
    expect(read).not.toHaveBeenCalled()
    adapter.inject(session.id, {
      kind: 'event',
      event: { type: 'provider_event', provider: 'codex', payload: { secret: 'not-history' } }
    })
    expect(read).not.toHaveBeenCalled()
    expect(timeline(manager).items).toEqual([])
  })
  it('keeps an outer emission before a nested emission during its initial capture', async () => {
    const { manager, adapter } = await fixture()
    vi.spyOn(adapter, 'history').mockImplementationOnce(() => {
      adapter.inject(session.id, { kind: 'event', event: { type: 'user_message', text: 'nested' } })
      return [{ event: { type: 'user_message', text: 'past' } }]
    })
    const delivered: SessionStream[] = []
    manager.subscribe(session.id, (stream) => delivered.push(stream))
    adapter.inject(session.id, { kind: 'event', event: { type: 'user_message', text: 'outer' } })
    expect(
      timeline(manager).items.map(({ event }) => event.type === 'user_message' && event.text)
    ).toEqual(['past', 'outer', 'nested'])
    expect(
      delivered.map(
        (stream) =>
          stream.kind === 'event' && stream.event.type === 'user_message' && stream.event.text
      )
    ).toEqual(['outer', 'nested'])
  })
})

describe('immutable launch history through the positioned timeline', () => {
  const past = (count: number): HistoryItem[] =>
    Array.from({ length: count }, (_, i) => ({
      event: { type: 'user_message', text: `past ${i}` },
      at: i
    }))
  const all = (timeline: SessionTimeline, limit = 17): TimelinePage['items'] => {
    let page = timeline.read(undefined, limit)
    let items = page.items
    while (page.before !== null) {
      const before = page.before
      page = timeline.read(before, limit)
      expect(page.before === null || page.before < before).toBe(true)
      expect(page.items.every(({ position }) => position.sequence < before)).toBe(true)
      items = [...page.items, ...items]
    }
    return items
  }

  it('pages every launch event beyond the item bound without claiming retention loss', () => {
    const seed = past(TIMELINE_MAX_ITEMS + 13)
    const read = vi.fn(() => seed)
    const timeline = new SessionTimeline(read)
    const newest = timeline.read(undefined, 2)
    expect(newest.items.map(({ position }) => position.sequence)).toEqual([2012, 2013])
    expect(newest.truncated).toBe(false)
    expect(all(timeline).map(({ event, at }) => ({ event, at }))).toEqual(seed)
    expect(read).toHaveBeenCalledTimes(1)
    expect(timeline.read(1).items).toEqual([])
    expect(timeline.read(1).before).toBeNull()
  })

  it('pages launch bytes beyond the live byte bound with stable positions and timestamps', () => {
    const seed = past(8).map((item) => ({
      ...item,
      event: {
        type: 'assistant_text' as const,
        delta: 'x'.repeat(TIMELINE_MAX_BYTES / 4),
        final: true
      }
    }))
    const timeline = new SessionTimeline(() => seed)
    const newest = timeline.read(undefined, 2)
    expect(newest.truncated).toBe(false)
    expect(all(timeline, 2)).toEqual(
      seed.map((item, i) => ({ ...item, position: { ...newest.cursor, sequence: i + 1 } }))
    )
  })

  it('freezes seed membership once and separates a reentrant capture from a large prefix', () => {
    const seed = past(TIMELINE_MAX_ITEMS + 1)
    seed.unshift({ event: { type: 'provider_event', provider: 'codex', payload: {} } })
    const delivered: SessionPosition[] = []
    const read = vi.fn(() => {
      timeline.capture({ type: 'user_message', text: 'nested' }, (p) => delivered.push(p))
      return seed
    })
    const timeline = new SessionTimeline(read)
    timeline.capture({ type: 'user_message', text: 'outer' }, (p) => delivered.push(p))
    const snapshot = timeline.read()
    seed.push({ event: { type: 'user_message', text: 'not part of launch' } })
    timeline.capture({ type: 'user_message', text: 'outer' }, (p) => delivered.push(p))
    const items = all(timeline)
    expect(items.map(({ event }) => event)).toEqual([
      ...seed.slice(1, -1).map(({ event }) => event),
      { type: 'user_message', text: 'outer' },
      { type: 'user_message', text: 'nested' },
      { type: 'user_message', text: 'outer' }
    ])
    expect(snapshot.cursor.sequence).toBe(TIMELINE_MAX_ITEMS + 3)
    expect(delivered).toEqual(items.slice(-3).map(({ position }) => position))
    expect(delivered[2].sequence).toBe(snapshot.cursor.sequence + 1)
    expect(new Set(items.map(({ position }) => position.sequence)).size).toBe(items.length)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('keeps a tool pair together across the launch/live boundary and pages at absolute cursors', () => {
    const seed: HistoryItem[] = [
      ...past(1),
      { event: { type: 'tool_call', id: 'read', name: 'Read', input: {} } }
    ]
    const timeline = new SessionTimeline(() => seed)
    timeline.capture({ type: 'tool_result', id: 'read', output: 'contents' }, () => {})
    timeline.capture({ type: 'assistant_text', delta: 'done', final: true }, () => {})
    const page = timeline.read(undefined, 2)
    expect(page.items.map(({ position }) => position.sequence)).toEqual([2, 3, 4])
    expect(page.before).toBe(2)
    timeline.capture({ type: 'user_message', text: 'later' }, () => {})
    const older = timeline.read(page.before!, 2)
    expect(older.items.map(({ position }) => position.sequence)).toEqual([1])
    expect(older.cursor).toEqual({ ...page.cursor, sequence: 5 })
    expect(older.truncated).toBe(false)
  })

  it('retains the launch prefix but reports a genuinely evicted live gap without renumbering', () => {
    const timeline = new SessionTimeline(() => past(3))
    const initial = timeline.read()
    for (let i = 0; i < TIMELINE_MAX_ITEMS + 5; i++)
      timeline.capture({ type: 'user_message', text: `live ${i}` }, () => {})
    const page = timeline.read(undefined, 2)
    expect(page.truncated).toBe(true)
    expect(page.cursor).toEqual({ ...initial.cursor, sequence: 2008 })
    expect(all(timeline).map(({ position }) => position.sequence)).toEqual([
      1,
      2,
      3,
      ...Array.from({ length: TIMELINE_MAX_ITEMS }, (_, i) => i + 9)
    ])
    expect(timeline.read(9).items.map(({ position }) => position.sequence)).toEqual([1, 2, 3])
    expect(timeline.read(9).truncated).toBe(true)
  })

  it('keeps prefix paging available after oversized live loss and preserves prior incompleteness', () => {
    expect(new SessionTimeline(() => past(3), true).read().truncated).toBe(true)
    const timeline = new SessionTimeline(() => past(3))
    const initial = timeline.read()
    expect(initial.truncated).toBe(false)
    timeline.capture(
      { type: 'assistant_text', delta: 'x'.repeat(TIMELINE_MAX_BYTES), final: true },
      () => {}
    )
    expect(all(timeline).map(({ position }) => position.sequence)).toEqual([1, 2, 3])
    expect(timeline.read().cursor).toEqual({ ...initial.cursor, sequence: 4 })
    expect(timeline.read().truncated).toBe(true)
  })
})
