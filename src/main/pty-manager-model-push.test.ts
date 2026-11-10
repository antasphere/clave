import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UserMessageInput } from '../shared/session-model'

vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/clave-model-push-test' },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./mcp/mcp-runtime', () => ({
  getMcpRuntime: () => null,
  writeSessionMcpConfig: () => null,
  deleteSessionMcpConfig: () => undefined
}))
const events = vi.hoisted(() => ({ sessionModelChanged: vi.fn() }))
vi.mock('./server/session-events', () => ({
  sessionModelChanged: events.sessionModelChanged,
  sessionLimitReported: vi.fn(),
  publishOrSend: vi.fn(),
  hasServerEventPublisher: () => false,
  setServerEventPublisher: vi.fn()
}))
const fake = vi.hoisted(() => ({
  lastUserMessage: new Map<string, UserMessageInput | undefined>(),
  streams: new Map<string, (stream: unknown) => void>(),
  writes: [] as { id: string; input: unknown }[],
  sessions: new Set<string>()
}))
vi.mock('./sessions/adapters/claude-adapter', () => ({
  ClaudeAdapter: class {
    id = 'claude-chat'
    lastUserMessage(id: string): UserMessageInput | undefined {
      return fake.lastUserMessage.get(id)
    }
  },
  findTranscript: () => null
}))
vi.mock('./sessions/session-manager', () => ({
  sessionManager: {
    registerAdapter: vi.fn(),
    getAdapter: vi.fn(),
    get: (id: string) => (fake.sessions.has(id) ? { id, adapterId: 'claude-chat' } : undefined),
    subscribe: (id: string, cb: (stream: unknown) => void) => {
      fake.streams.set(id, cb)
      return () => fake.streams.delete(id)
    },
    subscribeExit: () => () => {},
    subscribeAll: () => () => {},
    write: (id: string, input: unknown) => {
      fake.writes.push({ id, input })
    },
    setState: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    forget: vi.fn()
  }
}))

import { ptyManager } from './pty-manager'

/**
 * Main tells the windows the model the provider says the chat is on
 * (PRDCT-4256, integration round 1, G1): every model a session_meta names
 * goes out with its session id, so the sidebar's store follows the chip. A
 * meta naming no model is the provider's default and pushes nothing.
 */
type Internals = {
  eventSessions: Map<string, { id: string; model?: string; alive: boolean }>
}
const internals = ptyManager as unknown as Internals
const meta = (model?: string): unknown => ({
  kind: 'event',
  event: { type: 'session_meta', ...(model ? { model } : {}) }
})

function attach(id: string, model = 'claude-fable-5-1'): (stream: unknown) => void {
  fake.sessions.add(id)
  internals.eventSessions.set(id, { id, model, alive: true })
  ptyManager.attachListeners(
    id,
    () => {},
    () => {}
  )
  const emit = fake.streams.get(id)
  if (!emit) throw new Error('no stream subscription')
  return emit
}

beforeEach(() => {
  events.sessionModelChanged.mockClear()
  fake.streams.clear()
  fake.sessions.clear()
  internals.eventSessions.clear()
})

describe('the model push to the windows', () => {
  it('sends every model the provider names, with its session', () => {
    const one = attach('s1')
    const two = attach('s2')
    one(meta('claude-opus-5-5'))
    two(meta('claude-sonnet-5-5'))
    one(meta('claude-fable-5-1[1m]'))
    expect(events.sessionModelChanged.mock.calls).toEqual([
      ['s1', 'claude-opus-5-5'],
      ['s2', 'claude-sonnet-5-5'],
      ['s1', 'claude-fable-5-1[1m]']
    ])
  })

  it('a meta naming no model pushes nothing', () => {
    const emit = attach('s1')
    emit(meta())
    expect(events.sessionModelChanged).not.toHaveBeenCalled()
  })
})
