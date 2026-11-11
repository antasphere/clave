import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UserMessageInput } from '../shared/session-model'

vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/clave-limit-resend-test' },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./mcp/mcp-runtime', () => ({
  getMcpRuntime: () => null,
  writeSessionMcpConfig: () => null,
  deleteSessionMcpConfig: () => undefined
}))
vi.mock('./server/session-events', () => ({
  sessionModelChanged: vi.fn(),
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
 * The message a cap rejected goes again on the model the provider confirms
 * next (ADR 0002, PRDCT-4302): once, while the report is open and the message
 * is still the person's last, by whichever hand the model changed, whatever
 * cap the CLI typed (a Fable rejection comes typed as a plain week, and the
 * window decides the rung from its read). One after the person moved on
 * would send a stale question; two would ask twice; none on the week-typed
 * report would leave the ADR's own case unanswered (round 1, F1).
 */
const ask: UserMessageInput = { type: 'user_message', text: 'the question the cap refused' }
const rejected = (rateLimitType: string): unknown => ({
  kind: 'event',
  event: {
    type: 'provider_event',
    provider: 'claude',
    payload: { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType } }
  }
})
const synthetic = (text: string): unknown => ({
  kind: 'event',
  event: {
    type: 'provider_event',
    provider: 'claude',
    payload: {
      type: 'assistant',
      message: { model: '<synthetic>', content: [{ type: 'text', text }] }
    }
  }
})
const modelNow = (model: string): unknown => ({
  kind: 'event',
  event: { type: 'session_meta', model }
})

type Internals = {
  eventSessions: Map<string, { id: string; model?: string; alive: boolean }>
}
const internals = ptyManager as unknown as Internals

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
  fake.lastUserMessage.clear()
  fake.streams.clear()
  fake.writes.length = 0
  fake.sessions.clear()
  internals.eventSessions.clear()
})

describe('the limit report and the owed resend', () => {
  it('hands the listener the report with its scope, for every frame that is one', () => {
    const reports: unknown[] = []
    const stop = ptyManager.onLimitReported((id, report) => reports.push([id, report]))
    const emit = attach('s1')
    fake.lastUserMessage.set('s1', ask)
    emit(rejected('seven_day_oi'))
    emit(rejected('five_hour'))
    emit(synthetic("You're out of usage credits. Switch to another model."))
    emit({
      kind: 'event',
      event: { type: 'provider_event', provider: 'claude', payload: { type: 'system' } }
    })
    stop()
    expect(reports).toEqual([
      ['s1', { scope: { family: 'Fable' } }],
      ['s1', { scope: 'shared' }],
      ['s1', { scope: 'credits' }]
    ])
  })

  it("a family's cap, then a model change: the rejected message goes again, once", () => {
    const emit = attach('s1')
    fake.lastUserMessage.set('s1', ask)
    emit(rejected('seven_day_oi'))
    expect(fake.writes).toEqual([])
    emit(modelNow('claude-opus-5-5'))
    expect(fake.writes).toEqual([{ id: 's1', input: ask }])
    // A second change, a repeat of the same model: nothing more.
    emit(modelNow('claude-sonnet-5-5'))
    emit(modelNow('claude-sonnet-5-5'))
    expect(fake.writes).toHaveLength(1)
  })

  it("a cap the CLI typed as the week, then a model change: the same resend (the ADR's own Fable case)", () => {
    const emit = attach('s1')
    fake.lastUserMessage.set('s1', ask)
    emit(rejected('seven_day'))
    emit(modelNow('claude-opus-5-5'))
    expect(fake.writes).toEqual([{ id: 's1', input: ask }])
    emit(modelNow('claude-sonnet-5-5'))
    expect(fake.writes).toHaveLength(1)
  })

  it('an untyped rejection, and the credits reply, open the same resend', () => {
    const emit = attach('s1')
    fake.lastUserMessage.set('s1', ask)
    emit(rejected(''))
    emit(modelNow('claude-opus-5-5'))
    expect(fake.writes).toEqual([{ id: 's1', input: ask }])
    const two = attach('s2')
    fake.lastUserMessage.set('s2', ask)
    two(synthetic('Your organization is out of usage credits.'))
    two(modelNow('claude-opus-5-5'))
    expect(fake.writes).toHaveLength(2)
  })

  it('the model the session already runs is no change: nothing is resent', () => {
    const emit = attach('s1', 'claude-fable-5-1')
    fake.lastUserMessage.set('s1', ask)
    emit(rejected('seven_day_opus'))
    emit(modelNow('claude-fable-5-1'))
    expect(fake.writes).toEqual([])
  })

  it('a later report keeps the latest rejected message open', () => {
    const emit = attach('s1')
    fake.lastUserMessage.set('s1', ask)
    emit(rejected('seven_day_oi'))
    const again: UserMessageInput = { type: 'user_message', text: 'asked again, refused again' }
    fake.lastUserMessage.set('s1', again)
    emit(rejected('five_hour'))
    emit(modelNow('claude-opus-5-5'))
    expect(fake.writes).toEqual([{ id: 's1', input: again }])
  })

  it('the person moved on: a message written since is not what the cap rejected, nothing is resent', () => {
    const emit = attach('s1')
    fake.lastUserMessage.set('s1', ask)
    emit(rejected('seven_day_oi'))
    fake.lastUserMessage.set('s1', { type: 'user_message', text: 'something else' })
    emit(modelNow('claude-opus-5-5'))
    expect(fake.writes).toEqual([])
    // And the report is closed by that: a further change resends nothing either.
    fake.lastUserMessage.set('s1', ask)
    emit(modelNow('claude-sonnet-5-5'))
    expect(fake.writes).toEqual([])
  })

  it('a family report with no message of the person opens nothing', () => {
    const emit = attach('s1')
    emit(rejected('seven_day_oi'))
    fake.lastUserMessage.set('s1', ask)
    emit(modelNow('claude-opus-5-5'))
    expect(fake.writes).toEqual([])
  })

  it('two sessions keep their own reports apart', () => {
    const one = attach('s1')
    const two = attach('s2')
    const other: UserMessageInput = { type: 'user_message', text: 'the other tab' }
    fake.lastUserMessage.set('s1', ask)
    fake.lastUserMessage.set('s2', other)
    one(rejected('seven_day_oi'))
    two(modelNow('claude-opus-5-5'))
    expect(fake.writes).toEqual([])
    one(modelNow('claude-opus-5-5'))
    expect(fake.writes).toEqual([{ id: 's1', input: ask }])
  })
})

describe('a restart or a kill closes the report (round 1, M6, M7)', () => {
  it('a restart carries the message itself and closes the report: the model change after it resends nothing', () => {
    const emit = attach('s1')
    fake.lastUserMessage.set('s1', ask)
    emit(rejected('seven_day_oi'))
    ;(ptyManager as unknown as { spawns: Map<string, unknown> }).spawns.set('s1', {
      cwd: '/tmp',
      options: {}
    })
    const restart = ptyManager.restartSpawn('s1', { resendRejected: true })
    expect(restart?.options.initialInput).toEqual(ask)
    emit(modelNow('claude-opus-5-5'))
    expect(fake.writes).toEqual([])
  })

  it('a kill forgets the report: a session attached again under the same id owes nothing', async () => {
    const emit = attach('s1')
    fake.lastUserMessage.set('s1', ask)
    emit(rejected('seven_day_oi'))
    await ptyManager.kill('s1')
    const again = attach('s1')
    fake.lastUserMessage.set('s1', ask)
    again(modelNow('claude-opus-5-5'))
    expect(fake.writes).toEqual([])
  })
})

/**
 * The window's report closes once the account serves the session again
 * (PRDCT-4415): a reply the model wrote after the report, on this Mac or on a
 * server, since a server tab is never moved by the window's policy and so
 * never settled there. Once per report; the CLI's own synthetic refusal is
 * no reply; a turn refused again reports again and the next reply clears it.
 */
const served = (model = 'claude-opus-5-5'): unknown => ({
  kind: 'event',
  event: {
    type: 'provider_event',
    provider: 'claude',
    payload: { type: 'assistant', message: { model, content: [{ type: 'text', text: 'ok' }] } }
  }
})

describe('the report closes when the account serves again (PRDCT-4415)', () => {
  it('a real reply after a report clears it once; a synthetic one does not', () => {
    const cleared: string[] = []
    const stop = ptyManager.onLimitCleared((id) => cleared.push(id))
    const emit = attach('s9')
    fake.lastUserMessage.set('s9', ask)
    // No report open: a reply clears nothing.
    emit(served())
    expect(cleared).toEqual([])
    emit(rejected('seven_day_oi'))
    emit(synthetic('No response requested.'))
    expect(cleared).toEqual([])
    emit(served())
    emit(served())
    expect(cleared).toEqual(['s9'])
    // Refused again, then served: cleared again.
    emit(synthetic('Fable limit reached'))
    emit(served())
    stop()
    expect(cleared).toEqual(['s9', 's9'])
  })

  it('a subagent reply leaves the report open; the session model clears it', () => {
    const cleared: string[] = []
    const stop = ptyManager.onLimitCleared((id) => cleared.push(id))
    const emit = attach('s8')
    emit(rejected('seven_day_oi'))
    emit({
      kind: 'event',
      event: {
        type: 'provider_event',
        provider: 'claude',
        payload: {
          type: 'assistant',
          parent_tool_use_id: 'toolu_1',
          message: { model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'ok' }] }
        }
      }
    })
    expect(cleared).toEqual([])
    emit(served())
    stop()
    expect(cleared).toEqual(['s8'])
  })

  it('a restart on the same tab keeps the report open: its first served turn clears it (PRDCT-4422)', async () => {
    const cleared: string[] = []
    const stop = ptyManager.onLimitCleared((id) => cleared.push(id))
    const emit = attach('s7')
    emit(rejected('seven_day_oi'))
    ;(ptyManager as unknown as { spawns: Map<string, unknown> }).spawns.set('s7', {
      cwd: '/tmp',
      options: {}
    })
    ptyManager.restartSpawn('s7', {})
    await ptyManager.kill('s7')
    const again = attach('s7')
    again(served())
    expect(cleared).toEqual(['s7'])
    // A close for good forgets it: a later session under the id clears nothing.
    again(rejected('seven_day_oi'))
    await ptyManager.kill('s7')
    attach('s7')(served())
    stop()
    expect(cleared).toEqual(['s7'])
  })
})
