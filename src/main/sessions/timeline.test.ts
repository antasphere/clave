import type { TimelinePage, SessionPosition } from '@clave/contract/timeline'
import { describe, expect, it, vi } from 'vitest'
import type { Session, SessionStream } from '../../shared/session-model'
import { EchoAdapter } from './adapters/echo-adapter'
import { SessionManager } from './session-manager'

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

async function fixture(): Promise<{ manager: SessionManager; adapter: EchoAdapter }> {
  const manager = new SessionManager()
  const adapter = new EchoAdapter()
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
