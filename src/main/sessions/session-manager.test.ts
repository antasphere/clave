import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HistoryItem, Session, SessionStream } from '../../shared/session-model'
import type { SessionAdapter, SessionAdapterEvents } from './adapter'
import { EchoAdapter } from './adapters/echo-adapter'
import { SessionManager } from './session-manager'
import { JournalTimeline } from './journal-timeline'

const session = (id: string, windowKey = 'first'): Session => ({
  id,
  provider: 'echo',
  adapterId: 'echo',
  transport: 'events',
  cwd: '/tmp',
  windowKey,
  state: 'idle',
  createdAt: 1,
  title: 'Echo'
})

function fixture(): { manager: SessionManager; adapter: EchoAdapter } {
  const manager = new SessionManager()
  const adapter = new EchoAdapter()
  manager.registerAdapter(adapter)
  return { manager, adapter }
}

describe('SessionManager', () => {
  it('creates, isolates window lists, and returns snapshots', async () => {
    const { manager } = fixture()
    await manager.create(session('a'))
    await manager.create(session('b', 'second'))
    expect(manager.list('first').map((s) => s.id)).toEqual(['a'])
    expect(manager.list().map((s) => s.id)).toEqual(['a', 'b'])
    const snapshot = manager.get('a')!
    snapshot.title = 'outside mutation'
    expect(manager.get('a')?.title).toBe('Echo')
    manager.update('a', { windowKey: 'second', title: 'Moved' })
    expect(manager.list('first')).toEqual([])
    expect(manager.get('a')?.title).toBe('Moved')
  })

  it('has no past to page for an adapter that replays none', async () => {
    const { manager } = fixture()
    await manager.create(session('a'))
    expect(manager.history('a')).toEqual({ items: [], before: null })
    expect(() => manager.history('absent')).toThrow('Unknown session')
  })

  it('carries the chosen view on the record, and refuses an id that is not one', async () => {
    const { manager } = fixture()
    await manager.create(session('a'))
    expect(manager.get('a')?.viewId).toBeUndefined()
    expect(manager.setView('a', 'clave.chat-view/terminal').viewId).toBe('clave.chat-view/terminal')
    expect(manager.get('a')?.viewId).toBe('clave.chat-view/terminal')
    // Cleared, the session goes back to whatever the host resolves for it.
    expect(manager.setView('a', null).viewId).toBeUndefined()
    expect('viewId' in manager.get('a')!).toBe(false)
    for (const invalid of ['chat', 'a/b/c', '/terminal', 'clave.chat-view/', ''])
      expect(() => manager.setView('a', invalid)).toThrow('Invalid view id')
    // A refused id leaves the record as it was, never half-set.
    manager.setView('a', 'clave.chat-view/chat')
    expect(() => manager.setView('a', 'chat')).toThrow('Invalid view id')
    expect(manager.get('a')?.viewId).toBe('clave.chat-view/chat')
    expect(() => manager.setView('absent', 'clave.chat-view/chat')).toThrow('Unknown session')
  })

  it('keeps the chosen view across the record updates a session lives through', async () => {
    const { manager } = fixture()
    await manager.create(session('a'))
    manager.setView('a', 'clave.chat-view/terminal')
    manager.update('a', { windowKey: 'second', title: 'Moved' })
    manager.setState('a', 'working')
    expect(manager.get('a')?.viewId).toBe('clave.chat-view/terminal')
  })

  it('says a session is started only once it was made ready, and not after it ended', async () => {
    const { manager } = fixture()
    await manager.create(session('a'))
    // Registered is not started: a restored chat's provider waits for a view.
    expect(manager.get('a')).toBeDefined()
    expect(manager.started('a')).toBe(false)
    manager.ready('a')
    expect(manager.started('a')).toBe(true)
    await manager.kill('a')
    expect(manager.started('a')).toBe(false)
    expect(manager.started('absent')).toBe(false)
  })

  it('never starts an ended session again when a view opens it', async () => {
    const { manager, adapter } = fixture()
    const ready = vi.spyOn(adapter, 'ready')
    await manager.create(session('a'))
    manager.ready('a')
    await manager.kill('a')
    // Still held (not forgotten), ended: a restored tab's view opening it.
    expect(manager.get('a')?.state).toBe('ended')
    manager.ready('a')
    expect(ready).toHaveBeenCalledTimes(1)
  })

  it('rejects unknown adapters, mismatched transports and duplicate concurrent ids', async () => {
    const { manager } = fixture()
    await expect(manager.create({ ...session('x'), adapterId: 'missing' })).rejects.toThrow(
      'Unknown adapter'
    )
    await expect(manager.create({ ...session('x'), transport: 'pty' })).rejects.toThrow(
      'Unsupported transport'
    )
    const first = manager.create(session('x'))
    await expect(manager.create(session('x'))).rejects.toThrow('already exists')
    await first
    await expect(manager.create(session('x'))).rejects.toThrow('already exists')
  })

  it('echoes user messages and tools in order to multiple independent consumers', async () => {
    const { manager } = fixture()
    await manager.create(session('a'))
    const first: SessionStream[] = []
    const second = vi.fn()
    const off = manager.subscribe('a', (stream) => first.push(stream))
    manager.subscribe('a', second)
    manager.write('a', { type: 'user_message', text: 'hello' })
    expect(first.map((stream) => stream.kind === 'event' && stream.event.type)).toEqual([
      'user_message',
      'state_change',
      'assistant_text',
      'tool_call',
      'tool_result',
      'state_change'
    ])
    expect(first[2]).toMatchObject({
      kind: 'event',
      event: { type: 'assistant_text', delta: 'hello', final: true }
    })
    expect(first[3]).toMatchObject({ event: { type: 'tool_call', input: { text: 'hello' } } })
    expect(first[4]).toMatchObject({ event: { type: 'tool_result', output: 'hello' } })
    expect(second).toHaveBeenCalledTimes(6)
    expect(manager.get('a')?.state).toBe('done')
    off()
    manager.write('a', new TextEncoder().encode('again'))
    expect(first).toHaveLength(6)
    expect(second).toHaveBeenCalledTimes(12)
  })

  it('detaches a window subscriptions without killing or detaching another consumer', async () => {
    const { manager, adapter } = fixture()
    const kill = vi.spyOn(adapter, 'kill')
    await manager.create(session('a'))
    const detached = vi.fn()
    const surviving = vi.fn()
    const detachedExit = vi.fn()
    manager.subscribe('a', detached, 'first')
    manager.subscribe('a', surviving, 'second')
    manager.subscribeExit('a', detachedExit, 'first')
    manager.detachWindow('first')
    manager.write('a', { type: 'user_message', text: 'still alive' })
    expect(detached).not.toHaveBeenCalled()
    expect(surviving).toHaveBeenCalledTimes(6)
    expect(kill).not.toHaveBeenCalled()
    manager.kill('a')
    expect(detachedExit).not.toHaveBeenCalled()
    expect(manager.get('a')?.state).toBe('ended')
  })

  it('fans out PTY bytes and state transitions, deduplicates state, emits exit once', () => {
    const manager = new SessionManager()
    const emitter = new EventEmitter()
    const adapter: SessionAdapter = {
      id: 'pty',
      provider: '*',
      transports: ['pty'],
      spawn: vi.fn(),
      attach: vi.fn(),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      on: <K extends keyof SessionAdapterEvents>(
        _handle: { id: string },
        event: K,
        cb: (value: SessionAdapterEvents[K]) => void
      ) => {
        emitter.on(event, cb)
        return () => {
          emitter.off(event, cb)
        }
      }
    }
    manager.adopt({ ...session('a'), transport: 'pty', adapterId: 'pty' }, { id: 'a' }, adapter)
    const streams = vi.fn()
    const all = vi.fn()
    const exit = vi.fn()
    manager.subscribe('a', streams)
    manager.subscribeAll(all)
    manager.subscribeExit('a', exit)
    const data = new Uint8Array([255, 0, 1])
    emitter.emit('stream', { kind: 'pty', data })
    manager.setState('a', 'working')
    manager.setState('a', 'working')
    expect(streams.mock.calls).toMatchObject([
      [{ kind: 'pty', data }],
      // Stamped with the run the state belongs to (PRDCT-4191): the first
      // process under the id is run 1.
      [{ kind: 'event', event: { type: 'state_change', state: 'working', run: 1 } }]
    ])
    expect(all).toHaveBeenCalledWith('a', { kind: 'pty', data })
    manager.write('a', data)
    manager.resize('a', 80, 24)
    expect(adapter.write).toHaveBeenCalledWith({ id: 'a' }, data)
    expect(adapter.resize).toHaveBeenCalledWith({ id: 'a' }, 80, 24)
    emitter.emit('exit', 7)
    emitter.emit('exit', 7)
    manager.setState('a', 'working')
    expect(exit).toHaveBeenCalledExactlyOnceWith(7)
    expect(manager.get('a')?.state).toBe('ended')
    expect(emitter.listenerCount('stream')).toBe(0)
  })

  it('holds the background list, and drops it when the process ends or is replaced', async () => {
    const manager = new SessionManager()
    const emitter = new EventEmitter()
    const adapter: SessionAdapter = {
      id: 'chat',
      provider: '*',
      transports: ['events'],
      spawn: vi.fn(),
      attach: vi.fn(async (id: string) => ({ id })),
      write: vi.fn(),
      kill: vi.fn(),
      on: <K extends keyof SessionAdapterEvents>(
        _handle: { id: string },
        event: K,
        cb: (value: SessionAdapterEvents[K]) => void
      ) => {
        emitter.on(event, cb)
        return () => {
          emitter.off(event, cb)
        }
      }
    }
    manager.adopt({ ...session('a'), adapterId: 'chat' }, { id: 'a' }, adapter)
    const streams = vi.fn()
    manager.subscribe('a', streams)
    const task = { id: 't1', kind: 'shell' as const, description: 'sleep', startedAt: 1 }
    const snapshot = (tasks: (typeof task)[]): SessionStream => ({
      kind: 'event',
      event: { type: 'background_tasks', tasks }
    })
    emitter.emit('stream', snapshot([task]))
    expect(manager.background('a')).toEqual([task])
    // A new process under the same id: the old one's list goes with it.
    await manager.attach('a')
    expect(manager.background('a')).toEqual([])
    expect(streams).toHaveBeenLastCalledWith(expect.objectContaining(snapshot([])))
    emitter.emit('stream', snapshot([task]))
    streams.mockClear()
    emitter.emit('exit', 0)
    expect(manager.background('a')).toEqual([])
    expect(streams).toHaveBeenCalledWith(expect.objectContaining(snapshot([])))
    // Nothing to clear is not a change worth publishing.
    streams.mockClear()
    await manager.attach('a')
    expect(streams).not.toHaveBeenCalledWith(expect.objectContaining(snapshot([])))
    expect(manager.background('absent')).toEqual([])
  })

  it('keeps the waiting list and the session’s meta in the timeline a phone reads, in order with the rest', async () => {
    // The mobile wave's ordered history: a phone that opens the session late
    // reads what waits for the agent and which model runs from the timeline,
    // not only from the live frames. A provider's raw event stays out of it.
    const manager = new SessionManager()
    const emitter = new EventEmitter()
    const adapter: SessionAdapter = {
      id: 'chat',
      provider: '*',
      transports: ['events'],
      spawn: vi.fn(),
      attach: vi.fn(async (id: string) => ({ id })),
      write: vi.fn(),
      kill: vi.fn(),
      on: <K extends keyof SessionAdapterEvents>(
        _handle: { id: string },
        event: K,
        cb: (value: SessionAdapterEvents[K]) => void
      ) => {
        emitter.on(event, cb)
        return () => {
          emitter.off(event, cb)
        }
      }
    }
    manager.adopt({ ...session('a'), adapterId: 'chat' }, { id: 'a' }, adapter)
    const meta = { type: 'session_meta' as const, model: 'pi-model', providerSessionId: 'p-1' }
    const waiting = {
      type: 'waiting_messages' as const,
      messages: [{ id: 'waiting-1', text: 'from the phone', clientMessageId: 'phone-00000044' }],
      takes: 'step' as const
    }
    const handedBack = {
      type: 'waiting_messages' as const,
      messages: [],
      takes: 'step' as const,
      returned: { why: 'stopped' as const, messages: waiting.messages }
    }
    for (const event of [
      meta,
      { type: 'user_message' as const, text: 'first' },
      waiting,
      { type: 'provider_event' as const, provider: 'pi', payload: { raw: true } },
      handedBack
    ])
      emitter.emit('stream', { kind: 'event', event })
    expect(manager.timeline('a').items.map((item) => item.event)).toEqual([
      meta,
      { type: 'user_message', text: 'first' },
      waiting,
      handedBack
    ])
  })

  it('forgets a transferred handle without killing it and permits readoption', async () => {
    const { manager, adapter } = fixture()
    const record = await manager.create(session('a'))
    const old = vi.fn()
    const kill = vi.spyOn(adapter, 'kill')
    manager.subscribe('a', old)
    manager.forget('a')
    expect(manager.get('a')).toBeUndefined()
    expect(kill).not.toHaveBeenCalled()
    manager.adopt(record, await adapter.attach('a'), adapter)
    const next = vi.fn()
    manager.subscribe('a', next)
    manager.write('a', { type: 'user_message', text: 'moved' })
    expect(old).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(6)
  })

  it('counts the runs under an id across forget, and starts each id at 1', async () => {
    // PRDCT-4191: a resumed chat on a server is a new process under the same
    // id; the run is what lets a pane tell its old process's late frames from
    // the new one's, so it must survive the forget a restart makes between
    // the two adoptions, and never leak from one id to another.
    const { manager, adapter } = fixture()
    const first = await manager.create(session('a'))
    expect(first.run).toBe(1)
    expect(manager.get('a')?.run).toBe(1)
    manager.forget('a')
    const second = manager.adopt(first, await adapter.attach('a'), adapter)
    expect(second.run).toBe(2)
    expect(manager.get('a')?.run).toBe(2)
    expect((await manager.create(session('b'))).run).toBe(1)
  })

  it('stamps state_change with the current run and tells it to a late binder', async () => {
    // PRDCT-4191: the server's host reads currentState at every bind, so a
    // pane that mounts after the state moved still learns it, with the run.
    const { manager, adapter } = fixture()
    const record = await manager.create(session('a'))
    expect(manager.currentState('a')).toEqual({ type: 'state_change', state: 'idle', run: 1 })
    manager.forget('a')
    manager.adopt(record, await adapter.attach('a'), adapter)
    const streams = vi.fn()
    manager.subscribe('a', streams)
    manager.setState('a', 'working')
    // A frame of an events session carries its timeline position too (the
    // mobile wave's ordered history): a new adoption is a new generation.
    expect(streams).toHaveBeenCalledWith({
      kind: 'event',
      event: { type: 'state_change', state: 'working', run: 2 },
      position: { generation: expect.any(String), sequence: 1 }
    })
    expect(manager.currentState('a')).toEqual({ type: 'state_change', state: 'working', run: 2 })
    expect(manager.currentState('absent')).toBeUndefined()
  })

  it('isolates throwing consumers during stream and exit delivery', async () => {
    const { manager } = fixture()
    await manager.create(session('a'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const fail = (): void => {
      throw new Error('consumer')
    }
    manager.subscribe('a', fail)
    manager.subscribeAll(fail)
    manager.subscribeExit('a', fail)
    const streams = vi.fn()
    const exit = vi.fn()
    manager.subscribe('a', streams)
    manager.subscribeExit('a', exit)
    try {
      expect(() => manager.write('a', { type: 'user_message', text: 'safe' })).not.toThrow()
      expect(streams).toHaveBeenCalledTimes(6)
      expect(() => manager.kill('a')).not.toThrow()
      expect(exit).toHaveBeenCalledExactlyOnceWith(0)
      expect(log).toHaveBeenCalled()
    } finally {
      log.mockRestore()
    }
  })

  it('reattaches without accumulating adapter listeners', async () => {
    const { manager } = fixture()
    await manager.create(session('a'))
    const listener = vi.fn()
    manager.subscribe('a', listener)
    await manager.attach('a')
    await manager.attach('a')
    manager.write('a', { type: 'user_message', text: 'once' })
    expect(listener).toHaveBeenCalledTimes(6)
  })
})

describe('an identified write waits for its provider (PRDCT-4448)', () => {
  it('answers when the adapter acknowledges, and fails as the adapter fails', async () => {
    const { manager, adapter } = fixture()
    await manager.create(session('a'))
    let acknowledge!: () => void
    let refuse!: (error: Error) => void
    const write = vi.spyOn(adapter, 'write')
    write.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve
        })
    )
    const sent = manager.write('a', {
      type: 'user_message',
      text: 'hello',
      clientMessageId: 'phone-0001'
    })
    expect(sent).toBeInstanceOf(Promise)
    let settled = false
    void (sent as Promise<void>).then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    acknowledge()
    await sent
    expect(settled).toBe(true)
    write.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          refuse = reject
        })
    )
    const unconfirmed = manager.write('a', {
      type: 'user_message',
      text: 'again',
      clientMessageId: 'phone-0002'
    })
    refuse(new Error('the provider did not confirm whether the message arrived'))
    await expect(unconfirmed).rejects.toThrow('did not confirm')
  })
})

describe('a chat kept whole on disk (PRDCT-4666)', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  /** An Echo resumed on a saved conversation: its replay is what the
   *  provider had at the launch and never grows, as a resumed chat's does. */
  class ResumedEcho extends EchoAdapter {
    replay: HistoryItem[] = Array.from({ length: 600 }, (_, n) => ({
      event:
        n % 2 === 0
          ? { type: 'user_message', text: `saved question ${n}` }
          : { type: 'assistant_text', delta: `saved answer ${n}`, final: true }
    }))
    history(): HistoryItem[] {
      return this.replay
    }
  }
  function kept(): { manager: SessionManager; adapter: ResumedEcho; dir: string } {
    const root = mkdtempSync(join(tmpdir(), 'session-manager-timelines-'))
    dirs.push(root)
    const dir = join(root, 'session-timelines')
    const manager = new SessionManager()
    const adapter = new ResumedEcho()
    manager.registerAdapter(adapter)
    manager.keepTimelines(dir)
    return { manager, adapter, dir }
  }
  const texts = (items: HistoryItem[]): string[] =>
    items.flatMap(({ event }) =>
      event.type === 'user_message'
        ? [event.text]
        : event.type === 'assistant_text'
          ? [event.delta]
          : []
    )
  function readAll(manager: SessionManager, id: string): HistoryItem[] {
    const items: HistoryItem[] = []
    let before: number | null | undefined
    for (let guard = 0; guard < 100; guard++) {
      const page = manager.history(id, before ?? undefined, 50)
      items.unshift(...page.items)
      before = page.before
      if (before === null) return items
    }
    throw new Error('The history never reached its start')
  }

  it('answers the turn made after the resume, and pages back to the first item', async () => {
    const { manager, adapter } = kept()
    await manager.create(session('a'))
    manager.ready('a')
    await manager.write('a', { type: 'user_message', text: 'after the resume' })
    const latest = manager.history('a', undefined, 50)
    expect(texts(latest.items).slice(-2)).toEqual(['after the resume', 'after the resume'])
    expect(latest.before).not.toBeNull()
    const all = readAll(manager, 'a')
    expect(all[0]).toEqual(adapter.replay[0])
    expect(texts(all)).toEqual([...texts(adapter.replay), 'after the resume', 'after the resume'])
  })

  it('starts a new run of the tab from its replay, without the previous run', async () => {
    const { manager, adapter } = kept()
    await manager.create(session('a'))
    manager.ready('a')
    await manager.write('a', { type: 'user_message', text: 'the old run' })
    adapter.replay = [{ event: { type: 'user_message', text: 'another conversation' } }]
    await manager.attach('a')
    expect(texts(manager.history('a').items)).toEqual(['another conversation'])
  })

  it('keeps the file past the entry, and forgetTimeline removes it', async () => {
    const { manager, dir } = kept()
    await manager.create(session('a'))
    manager.ready('a')
    const file = join(dir, 'a.jsonl')
    expect(existsSync(file)).toBe(true)
    manager.forget('a')
    expect(existsSync(file)).toBe(true)
    manager.forgetTimeline('a')
    expect(existsSync(file)).toBe(false)
    // Without a directory there is nothing to forget.
    expect(() => new SessionManager().forgetTimeline('a')).not.toThrow()
  })

  it('answers the past alone in history, while the timeline keeps the live state', async () => {
    for (const keep of [true, false]) {
      const { manager, adapter } = keep
        ? kept()
        : (() => {
            const manager = new SessionManager()
            const adapter = new ResumedEcho()
            manager.registerAdapter(adapter)
            return { manager, adapter }
          })()
      adapter.replay = [{ event: { type: 'user_message', text: 'saved' } }]
      await manager.create(session('a'))
      manager.ready('a')
      await manager.write('a', { type: 'user_message', text: 'now' })
      adapter.inject('a', {
        kind: 'event',
        event: { type: 'waiting_messages', messages: [{ id: 'w1', text: 'next' }], takes: 'turn' }
      })
      const live = ['state_change', 'background_tasks', 'waiting_messages']
      const timelineTypes = manager.timeline('a').items.map(({ event }) => event.type)
      expect(timelineTypes).toContain('state_change')
      expect(timelineTypes).toContain('waiting_messages')
      const history = manager.history('a').items
      expect(history.some(({ event }) => live.includes(event.type))).toBe(false)
      expect(texts(history)).toEqual(['saved', 'now', 'now'])
    }
  })

  it('closes the previous run’s timeline once at a restart', async () => {
    const { manager } = kept()
    await manager.create(session('a'))
    manager.ready('a')
    const close = vi.spyOn(JournalTimeline.prototype, 'close')
    try {
      await manager.attach('a')
      expect(close).toHaveBeenCalledTimes(1)
    } finally {
      close.mockRestore()
    }
  })

  it('gives a run file up once a write to it failed', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { manager, dir } = kept()
      await manager.create(session('a'))
      manager.ready('a')
      const file = join(dir, 'a.jsonl')
      expect(existsSync(file)).toBe(true)
      // The run's file stops taking writes, as a full disk does.
      const entry = (
        manager as unknown as {
          entries: Map<string, { timeline: { file?: { close(): void } } }>
        }
      ).entries.get('a')!
      entry.timeline.file!.close()
      await manager.write('a', { type: 'user_message', text: 'after the failure' })
      expect(existsSync(file)).toBe(false)
      expect(texts(manager.history('a').items)).toContain('after the failure')
      expect(error).toHaveBeenCalledTimes(1)
    } finally {
      error.mockRestore()
    }
  })

  it('never sweeps a live session’s file, and sweeps a gone one', async () => {
    const { manager, dir } = kept()
    await manager.create(session('a'))
    manager.ready('a')
    await manager.create(session('b'))
    manager.ready('b')
    manager.forget('b')
    manager.sweepTimelines(new Set(['some-recorded-tab']))
    expect(existsSync(join(dir, 'a.jsonl'))).toBe(true)
    expect(existsSync(join(dir, 'b.jsonl'))).toBe(false)
    expect(() => new SessionManager().sweepTimelines(new Set(['a']))).not.toThrow()
  })
})
