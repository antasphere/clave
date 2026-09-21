import { beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
const mocks = vi.hoisted(() => ({
  handlers: new Map(),
  fromWebContents: vi.fn(),
  keyForWindow: vi.fn()
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: unknown) => mocks.handlers.set(name, fn) },
  BrowserWindow: { fromWebContents: mocks.fromWebContents, getAllWindows: () => [] }
}))
vi.mock('../window-registry', () => ({ windowRegistry: { getKeyForWindow: mocks.keyForWindow } }))
import { registerSessionIpc } from './ipc'
import { sessionManager } from './session-manager'
import { EchoAdapter } from './adapters/echo-adapter'

let sequence = 0
beforeEach(() => {
  registerSessionIpc()
  mocks.fromWebContents.mockReturnValue({ id: 1 })
  mocks.keyForWindow.mockReturnValue('window')
})

it('fans out through production IPC and detaches the consumer when its WebContents dies', () => {
  const id = `ipc-${++sequence}`
  const adapter = new EchoAdapter()
  const session = {
    id,
    provider: 'echo',
    transport: 'events' as const,
    cwd: '/project',
    windowKey: 'window',
    state: 'idle' as const,
    createdAt: 1,
    adapterId: 'echo',
    title: 'Echo'
  }
  sessionManager.adopt(session, adapter.prepare(session), adapter)
  const sender = Object.assign(new EventEmitter(), {
    id: sequence,
    isDestroyed: () => false,
    send: vi.fn()
  })
  const event = { sender }
  expect(mocks.handlers.get('sessions:list')(event)).toContainEqual(session)
  expect(mocks.handlers.get('sessions:subscribe')(event, id)).toEqual(session)
  const local = vi.fn()
  sessionManager.subscribe(id, local)
  mocks.handlers.get('sessions:write')(event, id, { type: 'user_message', text: 'hello' })
  expect(sender.send).toHaveBeenCalledWith(`sessions:stream:${id}`, {
    kind: 'event',
    event: { type: 'assistant_text', delta: 'hello', final: true }
  })
  sender.send.mockClear()
  sender.emit('destroyed')
  sessionManager.write(id, { type: 'user_message', text: 'still alive' })
  expect(sender.send).not.toHaveBeenCalled()
  expect(local).toHaveBeenCalledTimes(12)
  expect(sessionManager.get(id)?.state).toBe('done')
  sessionManager.kill(id)
  sessionManager.forget(id)
})

it('rejects nonexistent sessions and malformed user messages', () => {
  const event = { sender: { id: 99 } }
  expect(() => mocks.handlers.get('sessions:subscribe')(event, 'absent')).toThrow('Unknown session')
  expect(() =>
    mocks.handlers.get('sessions:write')(event, 'absent', { type: 'user_message', text: 4 })
  ).toThrow()
})

it('refuses subscribe and write across windows, including unregistered callers', () => {
  const id = `ipc-${++sequence}`
  const adapter = new EchoAdapter()
  const session = {
    id,
    provider: 'echo',
    transport: 'events' as const,
    cwd: '/project',
    windowKey: 'owner',
    state: 'idle' as const,
    createdAt: 1,
    adapterId: 'echo',
    title: 'Echo'
  }
  sessionManager.adopt(session, adapter.prepare(session), adapter)
  const event = { sender: { id: 101 } }
  for (const key of ['other', undefined]) {
    mocks.keyForWindow.mockReturnValue(key)
    expect(mocks.handlers.get('sessions:list')(event)).toEqual([])
    expect(() => mocks.handlers.get('sessions:subscribe')(event, id)).toThrow('another window')
    expect(() =>
      mocks.handlers.get('sessions:write')(event, id, { type: 'user_message', text: 'blocked' })
    ).toThrow('another window')
    expect(sessionManager.get(id)?.state).toBe('idle')
  }
  sessionManager.forget(id)
})

it('readies an adapter only once and only after stream and exit notifications are bound', () => {
  const id = `ipc-ready-${++sequence}`
  const adapter = new EchoAdapter()
  const ready = vi.fn((handle: { id: string }) => {
    adapter.write(handle, { type: 'user_message', text: 'initial prompt' })
    adapter.kill(handle)
  })
  Object.assign(adapter, { ready })
  const record = {
    id,
    provider: 'echo',
    transport: 'events' as const,
    cwd: '/project',
    windowKey: 'window',
    state: 'idle' as const,
    createdAt: 1,
    adapterId: 'echo',
    title: 'Ready'
  }
  sessionManager.adopt(record, adapter.prepare(record), adapter)
  const sender = Object.assign(new EventEmitter(), {
    id: sequence,
    isDestroyed: () => false,
    send: vi.fn()
  })
  expect(ready).not.toHaveBeenCalled()
  mocks.handlers.get('sessions:subscribe')({ sender }, id)
  expect(sender.send).toHaveBeenCalledWith(`sessions:stream:${id}`, {
    kind: 'event',
    event: { type: 'user_message', text: 'initial prompt' }
  })
  expect(sender.send).toHaveBeenCalledWith(`sessions:exit:${id}`, 0)
  mocks.handlers.get('sessions:subscribe')({ sender }, id)
  expect(ready).toHaveBeenCalledTimes(1)
  mocks.handlers.get('sessions:unsubscribe')({ sender }, id)
  sessionManager.forget(id)
})

it('keeps subscriptions after ready errors and retries until one successful call', () => {
  const id = `ipc-retry-${++sequence}`
  const adapter = new EchoAdapter()
  const ready = vi
    .fn()
    .mockImplementationOnce(() => {
      throw new Error('temporary startup failure')
    })
    .mockImplementation((handle) =>
      adapter.write(handle, { type: 'user_message', text: 'initial prompt' })
    )
  Object.assign(adapter, { ready })
  const record = {
    id,
    provider: 'echo',
    transport: 'events' as const,
    cwd: '/project',
    windowKey: 'window',
    state: 'idle' as const,
    createdAt: 1,
    adapterId: 'echo',
    title: 'Retry'
  }
  sessionManager.adopt(record, adapter.prepare(record), adapter)
  const sender = Object.assign(new EventEmitter(), {
    id: sequence,
    isDestroyed: () => false,
    send: vi.fn()
  })
  const subscribe = (): unknown => mocks.handlers.get('sessions:subscribe')({ sender }, id)
  expect(subscribe()).toEqual(record)
  expect(sender.send).toHaveBeenCalledWith(`sessions:stream:${id}`, {
    kind: 'event',
    event: {
      type: 'error',
      message: 'Session readiness failed: temporary startup failure',
      fatal: false
    }
  })
  sender.send.mockClear()
  sessionManager.write(id, { type: 'user_message', text: 'subscription still works' })
  expect(sender.send).toHaveBeenCalledWith(`sessions:stream:${id}`, {
    kind: 'event',
    event: { type: 'user_message', text: 'subscription still works' }
  })
  subscribe()
  subscribe()
  expect(ready).toHaveBeenCalledTimes(2)
  expect(
    sender.send.mock.calls.filter(
      ([, stream]) =>
        stream.event?.type === 'user_message' && stream.event.text === 'initial prompt'
    )
  ).toHaveLength(1)
  mocks.handlers.get('sessions:unsubscribe')({ sender }, id)
  sessionManager.kill(id)
  sessionManager.forget(id)
})

it('sets the view only for the window that owns the session, and only on a valid id', () => {
  const id = `ipc-${++sequence}`
  const adapter = new EchoAdapter()
  const session = {
    id,
    provider: 'echo',
    transport: 'events' as const,
    cwd: '/project',
    windowKey: 'window',
    state: 'idle' as const,
    createdAt: 1,
    adapterId: 'echo',
    title: 'Echo'
  }
  sessionManager.adopt(session, adapter.prepare(session), adapter)
  const event = {
    sender: Object.assign(new EventEmitter(), {
      id: sequence,
      isDestroyed: () => false,
      send: vi.fn()
    })
  }
  const setView = mocks.handlers.get('sessions:set-view')
  expect(setView(event, id, 'clave.chat-view/compact')).toMatchObject({
    id,
    viewId: 'clave.chat-view/compact'
  })
  expect(sessionManager.get(id)?.viewId).toBe('clave.chat-view/compact')
  expect(() => setView(event, id, 'compact')).toThrow('Invalid view id')
  expect(() => setView(event, id, 42)).toThrow('Invalid view id')
  expect(setView(event, id, null).viewId).toBeUndefined()
  // Another window may not decide how this session is read, the rule every
  // session call keeps.
  mocks.keyForWindow.mockReturnValue('other-window')
  expect(() => setView(event, id, 'clave.chat-view/chat')).toThrow('another window')
  expect(sessionManager.get(id)?.viewId).toBeUndefined()
  mocks.keyForWindow.mockReturnValue('window')
  // An unregistered caller has no window key at all.
  mocks.fromWebContents.mockReturnValueOnce(null)
  expect(() => setView(event, id, 'clave.chat-view/chat')).toThrow('another window')
})
