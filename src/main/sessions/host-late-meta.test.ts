import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { Session, SessionStream } from '../../shared/session-model'
import type { SessionAdapter, SessionAdapterEvents } from './adapter'
import { SessionManager } from './session-manager'

/**
 * A pane that subscribes after the provider named its model still names it
 * (PRDCT-4427): OpenCode's and Pi's adapters say `session_meta` once, at the
 * handshake, and the chip of any later pane read `…` for the tab's life.
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

/** An adapter that holds its handshake's `session_meta` until `ready`, as
 *  the ACP and Pi adapters do. */
function setup(): { manager: SessionManager; emitter: EventEmitter } {
  const manager = new SessionManager()
  const emitter = new EventEmitter()
  const held: SessionStream[] = [
    {
      kind: 'event',
      event: { type: 'session_meta', model: 'kimi-code-plan-global/k3', providerSessionId: 'ses_1' }
    }
  ]
  const adapter: SessionAdapter = {
    id: 'opencode-chat',
    provider: 'opencode',
    transports: ['events'],
    spawn: vi.fn(),
    attach: vi.fn(async (id: string) => ({ id })),
    write: vi.fn(),
    kill: vi.fn(),
    ready: () => {
      for (const stream of held.splice(0)) emitter.emit('stream', stream)
    },
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

const metaOf = (calls: unknown[][]): unknown[] =>
  calls
    .map(([stream]) => stream as SessionStream)
    .filter((s) => s.kind === 'event' && s.event.type === 'session_meta')
    .map((s) => (s.kind === 'event' && s.event.type === 'session_meta' ? s.event.model : null))

describe('the host tells a late subscriber the model (PRDCT-4427)', () => {
  it('the first pane hears the handshake once, a later pane is told the same model', () => {
    const { manager } = setup()
    const host = createSessionHost({
      manager,
      lifecycle: { spawn: vi.fn(), stop: vi.fn(), resize: vi.fn(), writeTerminal: vi.fn() }
    })
    expect(manager.meta('a')).toBeNull()
    const first = vi.fn()
    host.subscribe('a', first)
    expect(metaOf(first.mock.calls)).toEqual(['kimi-code-plan-global/k3'])
    const late = vi.fn()
    host.subscribe('a', late)
    expect(metaOf(late.mock.calls)).toEqual(['kimi-code-plan-global/k3'])
    // The first pane is not told again.
    expect(metaOf(first.mock.calls)).toHaveLength(1)
  })

  it('a switch is what the next pane is told', () => {
    const { manager, emitter } = setup()
    const host = createSessionHost({
      manager,
      lifecycle: { spawn: vi.fn(), stop: vi.fn(), resize: vi.fn(), writeTerminal: vi.fn() }
    })
    host.subscribe('a', vi.fn())
    emitter.emit('stream', {
      kind: 'event',
      event: {
        type: 'session_meta',
        model: 'kimi-code-plan-global/k3.1-pro',
        providerSessionId: 'ses_1'
      }
    })
    const late = vi.fn()
    host.subscribe('a', late)
    expect(metaOf(late.mock.calls)).toEqual(['kimi-code-plan-global/k3.1-pro'])
    expect(manager.meta('absent')).toBeNull()
  })
})
