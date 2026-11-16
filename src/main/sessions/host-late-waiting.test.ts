import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { Session, SessionStream } from '../../shared/session-model'
import type { SessionAdapter, SessionAdapterEvents } from './adapter'
import { SessionManager } from './session-manager'

/**
 * A view that opens while a message waits for the agent shows it (PRDCT-4566):
 * the OpenCode and Pi adapters list what waits each time the list changes,
 * and a pane mounted after that (another skin of the same tab, a window
 * reloaded) would otherwise show nothing waiting until the next change.
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

const record: Session = {
  id: 'a',
  provider: 'opencode',
  adapterId: 'opencode-chat',
  transport: 'events',
  cwd: '/tmp',
  windowKey: 'w',
  state: 'idle',
  createdAt: 1,
  title: 'OpenCode'
}

function setup(): { manager: SessionManager; emitter: EventEmitter } {
  const manager = new SessionManager()
  const emitter = new EventEmitter()
  const adapter: SessionAdapter = {
    id: 'opencode-chat',
    provider: 'opencode',
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
  manager.adopt(record, { id: 'a' }, adapter)
  return { manager, emitter }
}
const host = (manager: SessionManager): ReturnType<typeof createSessionHost> =>
  createSessionHost({
    manager,
    lifecycle: { spawn: vi.fn(), stop: vi.fn(), resize: vi.fn(), writeTerminal: vi.fn() }
  })
const waitingOf = (calls: unknown[][]): unknown[] =>
  calls
    .map(([stream]) => stream as SessionStream)
    .flatMap((s) => (s.kind === 'event' && s.event.type === 'waiting_messages' ? [s.event] : []))
const listed = (messages: { id: string; text: string }[], returned?: unknown): SessionStream => ({
  kind: 'event',
  event: {
    type: 'waiting_messages',
    messages,
    takes: 'turn',
    ...(returned ? { returned } : {})
  } as Extract<SessionStream, { kind: 'event' }>['event']
})

describe('the host shows a late view what waits for the agent (PRDCT-4566)', () => {
  it('a view that subscribes while a message waits is told the list, without what was handed back', () => {
    const { manager, emitter } = setup()
    const sessions = host(manager)
    sessions.subscribe('a', vi.fn())
    emitter.emit(
      'stream',
      listed([{ id: 'w2', text: 'and then this' }], {
        why: 'withdrawn',
        messages: [{ id: 'w1', text: 'first thought' }]
      })
    )
    const late = vi.fn()
    sessions.subscribe('a', late)
    expect(waitingOf(late.mock.calls)).toEqual([
      { type: 'waiting_messages', messages: [{ id: 'w2', text: 'and then this' }], takes: 'turn' }
    ])
  })

  it('nothing is told once the list is empty, nor after the process ended', () => {
    const { manager, emitter } = setup()
    const sessions = host(manager)
    sessions.subscribe('a', vi.fn())
    emitter.emit('stream', listed([{ id: 'w1', text: 'one' }]))
    emitter.emit('stream', listed([]))
    const afterTaken = vi.fn()
    sessions.subscribe('a', afterTaken)
    expect(waitingOf(afterTaken.mock.calls)).toEqual([])
    emitter.emit('stream', listed([{ id: 'w2', text: 'two' }]))
    expect(manager.waiting('a')?.messages).toEqual([{ id: 'w2', text: 'two' }])
    emitter.emit('exit', 0)
    expect(manager.waiting('a')).toBeNull()
    expect(manager.waiting('absent')).toBeNull()
  })
})
