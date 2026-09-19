import { describe, expect, it } from 'vitest'
import {
  applyConversationEvent,
  type ConversationEnvelope,
  type ConversationSnapshot
} from './agent-session'

const base: ConversationSnapshot = {
  session: {
    id: 'conversation-test',
    provider: 'claude',
    cwd: '/tmp',
    status: 'idle',
    createdAt: '',
    updatedAt: '',
    capabilities: { permissions: true, questions: true, resume: true }
  },
  sequence: 0,
  entries: [],
  requests: []
}

describe('conversation projection', () => {
  it('deduplicates replayed deltas and ignores another session', () => {
    const event: ConversationEnvelope = {
      sessionId: base.session.id,
      sequence: 1,
      timestamp: 'now',
      event: { type: 'text-delta', messageId: 'm1', text: 'hello' }
    }
    const state = applyConversationEvent(base, event)
    expect(applyConversationEvent(state, event)).toBe(state)
    expect(applyConversationEvent(base, { ...event, sessionId: 'other' })).toBe(base)
    expect(state.entries).toEqual([{ kind: 'message', id: 'm1', role: 'assistant', text: 'hello' }])
    expect(base.entries).toEqual([])
  })

  it('cancels pending requests at the end of a turn and on disconnection from the provider', () => {
    const state = {
      ...base,
      requests: [{ id: 'r', kind: 'permission' as const, title: 'Run command?' }]
    }
    for (const event of [
      { type: 'turn-end' as const, outcome: 'interrupted' as const },
      { type: 'status' as const, status: 'stopped' as const }
    ]) {
      expect(
        applyConversationEvent(state, {
          sessionId: base.session.id,
          sequence: 1,
          timestamp: '',
          event
        }).requests
      ).toEqual([])
    }
  })
})
