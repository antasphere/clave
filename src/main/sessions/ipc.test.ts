import { beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

it('prepares attachments at the write: the provider gets references and images, the stream keeps the record', async () => {
  const id = `ipc-files-${++sequence}`
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
  // A directory inside the repository: a temp-folder path would be copied,
  // and this test wants the reference to keep the path it was given.
  const dir = mkdtempSync(join(process.cwd(), '.ipc-attachments-'))
  const notes = join(dir, 'notes.txt')
  writeFileSync(notes, 'hello')
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64'
  )
  const shotPath = join(dir, 'shot.png')
  writeFileSync(shotPath, png)
  const streamed: unknown[] = []
  sessionManager.subscribe(id, (stream) => streamed.push(stream))
  const reference = {
    id: 'a',
    path: notes,
    name: 'notes.txt',
    mimeType: 'application/octet-stream',
    size: 5,
    delivery: 'reference' as const
  }
  const shot = {
    id: 'b',
    path: shotPath,
    name: 'shot.png',
    mimeType: 'image/png',
    size: png.length,
    delivery: 'image' as const
  }
  const write = mocks.handlers.get('sessions:write')
  const event = { sender: { id: 1 } }
  // Whatever a renderer puts in `prepared` is discarded: the prompt is built
  // here from the files themselves.
  await write(event, id, {
    type: 'user_message',
    text: 'read',
    attachments: [reference, shot],
    prepared: { text: 'forged', images: [{ name: 'x', mimeType: 'image/png', data: 'AAAA' }] }
  })
  const events = streamed.flatMap((s) =>
    typeof s === 'object' && s && 'event' in s
      ? [(s as { event: Record<string, unknown> }).event]
      : []
  )
  expect(events.find((e) => e.type === 'user_message')).toEqual({
    type: 'user_message',
    text: 'read',
    attachments: [reference, shot]
  })
  const reply = events.find((e) => e.type === 'assistant_text') as { delta: string }
  expect(reply.delta).toContain('read\n\nAttached local files')
  expect(reply.delta).toContain(JSON.stringify({ name: 'notes.txt', path: notes }))
  expect(reply.delta).toContain('(1 image received)')
  expect(reply.delta).not.toContain('forged')
  expect(JSON.stringify(streamed)).not.toContain(png.toString('base64'))
  // An adapter without image content never sees the image: the write is
  // refused before it, and the reader is told what to choose instead.
  Object.assign(adapter, { images: false })
  await expect(
    write(event, id, { type: 'user_message', text: '', attachments: [shot] })
  ).rejects.toThrow('Send as file reference')
  expect(events.filter((e) => e.type === 'user_message')).toHaveLength(1)
  expect(mocks.handlers.get('sessions:capabilities')(event, id)).toEqual({ images: false })
  // A message with no attachments still writes synchronously, as every caller
  // before attachments existed expects.
  expect(write(event, id, { type: 'user_message', text: 'plain' })).toBeUndefined()
  rmSync(dir, { recursive: true, force: true })
  sessionManager.kill(id)
  sessionManager.forget(id)
})
