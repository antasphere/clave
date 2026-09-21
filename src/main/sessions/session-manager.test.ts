import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { Session, SessionStream } from '../../shared/session-model'
import type { SessionAdapter, SessionAdapterEvents } from './adapter'
import { EchoAdapter } from './adapters/echo-adapter'
import { SessionManager } from './session-manager'

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

  it('carries the chosen view on the record, and refuses an id that is not one', async () => {
    const { manager } = fixture()
    await manager.create(session('a'))
    expect(manager.get('a')?.viewId).toBeUndefined()
    expect(manager.setView('a', 'clave.chat-view/compact').viewId).toBe('clave.chat-view/compact')
    expect(manager.get('a')?.viewId).toBe('clave.chat-view/compact')
    // Cleared, the session goes back to whatever the host resolves for it.
    expect(manager.setView('a', null).viewId).toBeUndefined()
    expect('viewId' in manager.get('a')!).toBe(false)
    for (const invalid of ['chat', 'a/b/c', '/compact', 'clave.chat-view/', ''])
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
    manager.setView('a', 'clave.chat-view/compact')
    manager.update('a', { windowKey: 'second', title: 'Moved' })
    manager.setState('a', 'working')
    expect(manager.get('a')?.viewId).toBe('clave.chat-view/compact')
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
    expect(first[2]).toEqual({
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
    expect(streams.mock.calls).toEqual([
      [{ kind: 'pty', data }],
      [{ kind: 'event', event: { type: 'state_change', state: 'working' } }]
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
