import { beforeEach, describe, expect, it, vi } from 'vitest'
const backend = vi.hoisted(() => ({
  spawn: vi.fn(),
  attachListeners: vi.fn(),
  getSession: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
  kill: vi.fn()
}))
vi.mock('./pty-backend', () => ({ ptyBackend: backend }))
import { PtyAdapter } from './pty-adapter'
import { SessionManager } from '../session-manager'

const id = '22222222-2222-4222-8222-222222222222'
const spec = {
  id,
  provider: 'terminal',
  transport: 'pty' as const,
  cwd: '/project',
  windowKey: 'window',
  state: 'idle' as const,
  createdAt: 1,
  adapterId: 'pty',
  title: 'Terminal'
}

beforeEach(() => {
  vi.clearAllMocks()
  backend.spawn.mockReturnValue({
    id,
    cwd: '/project',
    folderName: 'project',
    alive: true,
    ptyProcess: null
  })
})

describe('PTY adapter compatibility', () => {
  it('prepares the requested provider and defers process startup to resize', async () => {
    const adapter = new PtyAdapter()
    const handle = await adapter.spawn(spec)
    expect(backend.spawn).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ claudeMode: false, adoptSessionId: id, windowKey: 'window' })
    )
    expect(backend.resize).not.toHaveBeenCalled()
    adapter.resize(handle, 132, 44)
    expect(backend.resize).toHaveBeenCalledWith(id, 132, 44)
  })
  it('fans the same bytes to independent consumers and retains UTF-8 input across chunks', async () => {
    const manager = new SessionManager()
    const adapter = new PtyAdapter()
    manager.registerAdapter(adapter)
    await manager.create(spec)
    const a = vi.fn(),
      b = vi.fn()
    manager.subscribe(id, a)
    const stop = manager.subscribe(id, b)
    const onData = backend.attachListeners.mock.calls[0][1]
    onData('héllo')
    expect(a.mock.calls[0][0]).toEqual({ kind: 'pty', data: new TextEncoder().encode('héllo') })
    expect(b).toHaveBeenCalledWith(a.mock.calls[0][0])
    stop()
    onData('next')
    expect(a).toHaveBeenCalledTimes(2)
    expect(b).toHaveBeenCalledTimes(1)
    manager.write(id, new Uint8Array([0xc3]))
    manager.write(id, new Uint8Array([0xa9]))
    expect(backend.write).toHaveBeenCalledExactlyOnceWith(id, 'é')
  })
  it('leaves Codex titles as bytes for the existing renderer state path', () => {
    const adapter = new PtyAdapter()
    const handle = adapter.prepare('/project', { codexMode: true })
    const state = vi.fn()
    adapter.on(handle, 'state', state)
    const onData = backend.attachListeners.mock.calls[0][1]
    onData('codex | Working')
    expect(state).not.toHaveBeenCalled()
    onData('\x1b]0;codex | Working\x07')
    expect(state).not.toHaveBeenCalled()
  })
  it('detaches the tmux client on shutdown and destroys it only on explicit kill', () => {
    const adapter = new PtyAdapter()
    adapter.detach(adapter.prepare('/project'))
    expect(backend.kill).toHaveBeenLastCalledWith(id, false)
    adapter.kill(adapter.prepare('/project'))
    expect(backend.kill).toHaveBeenLastCalledWith(id)
  })
  it('rejects an unsupported provider before creating any process or record', async () => {
    await expect(new PtyAdapter().spawn({ ...spec, provider: 'unknown' })).rejects.toThrow(
      'Unsupported PTY provider'
    )
    expect(backend.spawn).not.toHaveBeenCalled()
  })
})
