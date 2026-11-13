import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { resourceKey } from '@clave/contract/fleet'
import type { Session, SessionStream } from '../../../src/shared/session-model'
import type { ServerConnectionStatus } from '@clave/contract/fleet'
import { bindConversation } from './bind-conversation'
import type { ConversationReader } from './conversation-reader'

vi.mock('../../../src/renderer/src/views/session-end', () => ({ endIsCurrent: async () => true }))
const settle = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop()
  vi.unstubAllGlobals()
})
function setup(id = 's'): {
  api: Record<
    | 'onSessionStream'
    | 'onSessionStreamExit'
    | 'onServerConnected'
    | 'onFleetStatus'
    | 'sessionsSubscribe'
    | 'sessionsUnsubscribe'
    | 'sessionsTimeline'
    | 'sessionsHistory',
    Mock
  >
  handlers: Record<
    'page' | 'event' | 'session' | 'exit' | 'reconnected' | 'reading' | 'failed',
    Mock
  >
  reader: ConversationReader
  stream(frame: SessionStream): void
  connected(): void
  fleet(value: ServerConnectionStatus): void
  resolve(): void
} {
  let stream!: (value: SessionStream) => void
  let connected!: () => void
  let fleet!: (status: ServerConnectionStatus) => void
  let resolve!: (session: Session) => void
  const held = new Promise<Session>((done) => {
    resolve = done
  })
  const stop = vi.fn()
  const api = {
    onSessionStream: vi.fn((_id, take) => {
      stream = take
      return stop
    }),
    onSessionStreamExit: vi.fn(() => stop),
    onServerConnected: vi.fn((take) => {
      connected = take
      return stop
    }),
    onFleetStatus: vi.fn((take) => {
      fleet = take
      return stop
    }),
    sessionsSubscribe: vi.fn(() => held),
    sessionsUnsubscribe: vi.fn(async () => {}),
    sessionsTimeline: vi.fn(async () => ({
      items: [],
      before: null,
      cursor: { generation: 'g', sequence: 0 },
      truncated: false
    })),
    sessionsHistory: vi.fn()
  }
  vi.stubGlobal('window', { electronAPI: api })
  const handlers = {
    page: vi.fn(),
    event: vi.fn(),
    session: vi.fn(),
    exit: vi.fn(),
    reconnected: vi.fn(),
    reading: vi.fn(),
    failed: vi.fn()
  }
  const reader = bindConversation(id, handlers)
  cleanups.push(reader.stop)
  return {
    api,
    handlers,
    reader,
    stream: (frame: SessionStream) => stream(frame),
    connected: () => connected(),
    fleet: (value: ServerConnectionStatus) => fleet(value),
    resolve: () => resolve({ id, state: 'working', run: 4 } as Session)
  }
}
describe('the native view connection binding', () => {
  it('waits for the new subscription overlays before reading a reconnect snapshot and balances its temporary subscription', async () => {
    const h = setup()
    h.resolve()
    await settle()
    let release!: (session: Session) => void
    h.api.sessionsSubscribe.mockImplementationOnce(
      () =>
        new Promise<Session>((done) => {
          release = done
        })
    )
    h.connected()
    await settle()
    expect(h.api.sessionsTimeline).toHaveBeenCalledOnce()
    h.stream({
      kind: 'event',
      event: {
        type: 'permission_request',
        id: 'clave:new',
        input: { tool: 'clave_request_input' },
        description: 'Current form',
        options: []
      }
    })
    expect(h.handlers.event).not.toHaveBeenCalled()
    release({ id: 's', state: 'blocked', run: 4 } as Session)
    await settle()
    expect(h.api.sessionsTimeline).toHaveBeenCalledTimes(2)
    expect(h.handlers.event).toHaveBeenCalledWith(expect.objectContaining({ current: true }))
    expect(h.api.sessionsUnsubscribe).toHaveBeenCalledTimes(1)
    h.reader.stop()
    expect(h.api.sessionsUnsubscribe).toHaveBeenCalledTimes(2)
  })
  it('listens before subscribe, then snapshots only after the subscription reply, keeping the buffered live tail', async () => {
    const h = setup()
    await settle()
    expect(h.api.onSessionStream.mock.invocationCallOrder[0]).toBeLessThan(
      h.api.sessionsSubscribe.mock.invocationCallOrder[0]
    )
    expect(h.api.sessionsTimeline).not.toHaveBeenCalled()
    h.stream({
      kind: 'event',
      position: { generation: 'g', sequence: 1 },
      event: { type: 'user_message', text: 'hello' }
    })
    h.resolve()
    await settle()
    expect(h.handlers.session).toHaveBeenCalledWith(expect.objectContaining({ run: 4 }))
    expect(h.handlers.event).toHaveBeenCalledTimes(1)
  })
  it('re-snapshots on the local push welcome and withdraws every listener on stop', async () => {
    const h = setup()
    h.resolve()
    await settle()
    h.connected()
    await settle()
    expect(h.api.sessionsTimeline).toHaveBeenCalledTimes(2)
    h.reader.stop()
    h.connected()
    h.stream({ kind: 'event', event: { type: 'user_message', text: 'late' } })
    await settle()
    expect(h.api.sessionsTimeline).toHaveBeenCalledTimes(2)
    expect(h.handlers.event).not.toHaveBeenCalled()
    expect(h.api.sessionsUnsubscribe).toHaveBeenCalledWith('s')
  })
  it('re-snapshots only the qualified owner, with its run reset before the read', async () => {
    const h = setup(resourceKey('session', 'a', 's'))
    h.resolve()
    await settle()
    h.connected()
    h.fleet({ serverId: 'b', state: 'connected' })
    h.fleet({ serverId: 'a', state: 'disconnected' })
    await settle()
    expect(h.api.sessionsTimeline).toHaveBeenCalledTimes(1)
    h.fleet({ serverId: 'a', state: 'connected' })
    await settle()
    expect(h.handlers.reconnected).toHaveBeenCalledOnce()
    expect(h.api.sessionsTimeline).toHaveBeenCalledTimes(2)
    expect(h.handlers.reconnected.mock.invocationCallOrder[0]).toBeLessThan(
      h.api.sessionsTimeline.mock.invocationCallOrder[1]
    )
  })
  it('does not start a snapshot when a subscribe response arrives after unmount', async () => {
    const h = setup()
    await settle()
    h.reader.stop()
    h.resolve()
    await settle()
    expect(h.api.sessionsTimeline).not.toHaveBeenCalled()
    expect(h.handlers.session).not.toHaveBeenCalled()
  })
  it('a failed subscription stays visible and Retry can obtain a new subscription', async () => {
    const h = setup()
    h.api.sessionsSubscribe.mockRejectedValueOnce(new Error('owner unavailable'))
    await settle()
    expect(h.handlers.failed).toHaveBeenCalled()
    h.reader.retry()
    h.resolve()
    await settle()
    expect(h.api.sessionsSubscribe).toHaveBeenCalledTimes(2)
    expect(h.api.sessionsTimeline).toHaveBeenCalledOnce()
  })
})
