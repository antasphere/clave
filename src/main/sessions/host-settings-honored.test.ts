import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Session, SessionStream } from '../../shared/session-model'
import type { SessionAdapter, SessionAdapterEvents } from './adapter'
import { SessionManager } from './session-manager'

/**
 * Issue #423: a chat's model and effort are honored and what it runs on is
 * what every view shows.
 *
 * - A pick made in a composer is the next chat's default only once the
 *   provider took it: Claude refuses a model or an effort after the write
 *   returned (a `control_response` error), and that refused pick used to
 *   become the default of every chat started after.
 * - A view that opens on a chat later is told the effort and the permission
 *   mode the chat runs at, as it is told the model: a long conversation's
 *   last page no longer holds the events that said them.
 */
vi.mock('electron', () => {
  throw new Error('the host imported electron')
})
vi.mock('../pty-manager', () => ({ ptyManager: {} }))
vi.mock('./lifecycle', () => ({
  readScreen: vi.fn(),
  restartSession: vi.fn(),
  typeIntoSession: vi.fn(),
  resizeSession: vi.fn(),
  spawnSession: vi.fn(),
  stopSession: vi.fn(),
  writeTerminal: vi.fn()
}))
vi.mock('../title-generator', () => ({ notifyChatMessage: vi.fn() }))
vi.mock('./attachments', () => ({ preparePrompt: vi.fn() }))
vi.mock('./chat-model-default', () => ({ rememberChatEffort: vi.fn(), rememberChatModel: vi.fn() }))
vi.mock('./chat-view-default', () => ({ rememberChatView: vi.fn() }))
vi.mock('./records', () => ({ sessionRecords: {} }))
import { createSessionHost } from './host'
import { rememberChatEffort, rememberChatModel } from './chat-model-default'

const record: Session = {
  id: 'a',
  provider: 'claude',
  adapterId: 'claude-chat',
  transport: 'events',
  cwd: '/project',
  windowKey: 'w',
  state: 'idle',
  createdAt: 1,
  title: 'Claude'
}

type Emit = (event: Extract<SessionStream, { kind: 'event' }>['event']) => void

function setup(): {
  manager: SessionManager
  emit: Emit
  write: ReturnType<typeof vi.fn>
} {
  const manager = new SessionManager()
  const emitter = new EventEmitter()
  const write = vi.fn()
  const adapter: SessionAdapter = {
    id: 'claude-chat',
    provider: 'claude',
    transports: ['events'],
    spawn: vi.fn(),
    attach: vi.fn(async (id: string) => ({ id })),
    write,
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
  manager.adopt(record, { id: 'a' }, adapter)
  const emit: Emit = (event) => emitter.emit('stream', { kind: 'event', event })
  return { manager, emit, write }
}
const host = (manager: SessionManager): ReturnType<typeof createSessionHost> =>
  createSessionHost({
    manager,
    lifecycle: { spawn: vi.fn(), stop: vi.fn(), resize: vi.fn(), writeTerminal: vi.fn() }
  })

describe('a composer pick is remembered once the provider took it (#423)', () => {
  beforeEach(() => {
    vi.mocked(rememberChatModel).mockClear()
    vi.mocked(rememberChatEffort).mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('remembers a model the provider confirms, and not before', async () => {
    const { manager, emit } = setup()
    await host(manager).write('a', { type: 'set_model', model: 'claude-sonnet-5-5' })
    expect(rememberChatModel).not.toHaveBeenCalled()
    emit({ type: 'session_meta', model: 'claude-sonnet-5-5', providerSessionId: null })
    expect(rememberChatModel).toHaveBeenCalledWith('claude-chat', 'claude-sonnet-5-5')
  })

  it('does not remember a model the provider refuses after the write returned', async () => {
    const { manager, emit } = setup()
    await host(manager).write('a', { type: 'set_model', model: 'claude-opus-9' })
    emit({ type: 'error', message: 'Claude refused to switch to claude-opus-9', fatal: false })
    // A later meta (the settings read the session makes anyway) is not the pick's.
    emit({ type: 'session_meta', model: 'claude-fable-5-1', providerSessionId: null })
    expect(rememberChatModel).not.toHaveBeenCalled()
  })

  it('remembers an effort the provider confirms, and not one it refuses', async () => {
    const { manager, emit } = setup()
    const h = host(manager)
    await h.write('a', { type: 'set_effort', effort: 'max' })
    expect(rememberChatEffort).not.toHaveBeenCalled()
    emit({ type: 'effort', effort: 'max' })
    expect(rememberChatEffort).toHaveBeenCalledWith('claude-chat', 'max')
    vi.mocked(rememberChatEffort).mockClear()
    await h.write('a', { type: 'set_effort', effort: 'ultra' })
    emit({ type: 'error', message: 'Claude refused the Ultra effort', fatal: false })
    emit({ type: 'effort', effort: 'high' })
    expect(rememberChatEffort).not.toHaveBeenCalled()
  })

  it('forgets a pick nobody confirms, so a much later meta is not taken for it', async () => {
    vi.useFakeTimers()
    const { manager, emit } = setup()
    await host(manager).write('a', { type: 'set_model', model: 'claude-sonnet-5-5' })
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    emit({ type: 'session_meta', model: 'claude-sonnet-5-5', providerSessionId: null })
    expect(rememberChatModel).not.toHaveBeenCalled()
  })

  it('remembers nothing when the write itself fails, synchronously or not', async () => {
    const { manager, emit, write } = setup()
    const h = host(manager)
    write.mockImplementationOnce(() => {
      throw new Error('Invalid model name')
    })
    await expect(h.write('a', { type: 'set_model', model: 'bad' })).rejects.toThrow()
    write.mockImplementationOnce(async () => {
      throw new Error('gone')
    })
    await expect(h.write('a', { type: 'set_effort', effort: 'low' })).rejects.toThrow('gone')
    emit({ type: 'session_meta', model: 'bad', providerSessionId: null })
    emit({ type: 'effort', effort: 'low' })
    expect(rememberChatModel).not.toHaveBeenCalled()
    expect(rememberChatEffort).not.toHaveBeenCalled()
  })

  it('answers the newer of two quick picks with the provider’s next word', async () => {
    const { manager, emit } = setup()
    const h = host(manager)
    await h.write('a', { type: 'set_effort', effort: 'low' })
    await h.write('a', { type: 'set_effort', effort: 'max' })
    emit({ type: 'error', message: 'Claude refused the Max effort', fatal: false })
    emit({ type: 'effort', effort: 'low' })
    expect(rememberChatEffort).not.toHaveBeenCalled()
  })

  it('keeps a pick the policy makes at a cap the tab’s own (PRDCT-4302)', async () => {
    const { manager, emit } = setup()
    await host(manager).write('a', { type: 'set_model', model: 'claude-opus-5-5', remember: false })
    emit({ type: 'session_meta', model: 'claude-opus-5-5', providerSessionId: null })
    expect(rememberChatModel).not.toHaveBeenCalled()
  })
})

describe('a view that opens later is told the effort and the mode (#423)', () => {
  const told = (calls: unknown[][], type: string): unknown[] =>
    calls
      .map(([stream]) => stream as SessionStream)
      .flatMap((s) => (s.kind === 'event' && s.event.type === type ? [s.event] : []))

  it('replays the last effort and permission mode to a late subscriber', () => {
    const { manager, emit } = setup()
    emit({ type: 'effort', effort: 'low' })
    emit({ type: 'effort', effort: 'xhigh' })
    emit({ type: 'permission_mode', mode: 'plan', modes: [{ id: 'plan', label: 'Plan' }] })
    const listener = vi.fn()
    host(manager).subscribe('a', listener)
    expect(told(listener.mock.calls, 'effort')).toEqual([{ type: 'effort', effort: 'xhigh' }])
    expect(told(listener.mock.calls, 'permission_mode')).toEqual([
      { type: 'permission_mode', mode: 'plan', modes: [{ id: 'plan', label: 'Plan' }] }
    ])
  })

  it('replays a model that takes no effort as no effort', () => {
    const { manager, emit } = setup()
    emit({ type: 'effort', effort: 'high' })
    emit({ type: 'effort', effort: null })
    const listener = vi.fn()
    host(manager).subscribe('a', listener)
    expect(told(listener.mock.calls, 'effort')).toEqual([{ type: 'effort', effort: null }])
  })

  it('tells nothing of either before the provider said it', () => {
    const { manager } = setup()
    const listener = vi.fn()
    host(manager).subscribe('a', listener)
    expect(told(listener.mock.calls, 'effort')).toEqual([])
    expect(told(listener.mock.calls, 'permission_mode')).toEqual([])
  })
})
