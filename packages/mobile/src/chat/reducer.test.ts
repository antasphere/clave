import { describe, expect, it } from 'vitest'
import type { HistoryItem, SessionEvent } from '../contract/types'
import { type Conversation, emptyConversation, reduceConversation } from './reducer'

const run = (events: SessionEvent[], from: Conversation = emptyConversation): Conversation =>
  events.reduce((state, event) => reduceConversation(state, { event, at: 1 }), from)

describe('the ported reducer keeps the desktop semantics', () => {
  it('joins assistant deltas until final and the closing frame closes the open answer', () => {
    const c = run([
      { type: 'assistant_text', delta: 'Hel', final: false },
      { type: 'assistant_text', delta: 'lo', final: false },
      { type: 'tool_call', id: 't', name: 'Read', input: {} },
      { type: 'assistant_text', delta: '', final: true }
    ])
    expect(c.entries.map((e) => e.kind)).toEqual(['assistant', 'tool'])
    expect(c.entries[0]).toMatchObject({ kind: 'assistant', text: 'Hello', final: true })
  })
  it("pairs a tool call with its result by id, the adapter's failure flag carried", () => {
    const c = run([
      { type: 'tool_call', id: 't1', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_call', id: 't2', name: 'Read', input: { path: '/x' } },
      { type: 'tool_result', id: 't1', output: 'a b', error: true },
      { type: 'tool_result', id: 't2', output: 'text' }
    ])
    expect(c.entries).toHaveLength(2)
    expect(c.entries[0]).toMatchObject({
      kind: 'tool',
      id: 't1',
      complete: true,
      failed: true,
      output: 'a b'
    })
    expect(c.entries[1]).toMatchObject({
      kind: 'tool',
      id: 't2',
      complete: true,
      failed: undefined
    })
  })
  it("a permission request blocks, the view's answer unblocks, the kernel's word closes a card", () => {
    const request: SessionEvent = {
      type: 'permission_request',
      id: 'r1',
      description: 'Run?',
      options: [{ id: 'allow-once', label: 'Allow' }]
    }
    let c = run([request])
    expect(c.state).toBe('blocked')
    const answered = reduceConversation(c, { answer: 'r1', optionId: 'allow-once' })
    expect(answered.state).toBe('working')
    expect(answered.entries[0]).toMatchObject({ kind: 'permission', answer: 'allow-once' })
    c = run([{ type: 'state_change', state: 'working' }], c)
    expect(c.entries[0]).toMatchObject({ kind: 'permission', answeredElsewhere: true })
    c = run([{ type: 'state_change', state: 'blocked' }], c)
    expect(c.entries[0]).toMatchObject({ kind: 'permission', answeredElsewhere: undefined })
  })
  it('a fatal error ends the conversation and is kept for the error state', () => {
    const c = run([{ type: 'error', message: 'account limit reached', fatal: true }])
    expect(c.state).toBe('ended')
    expect(c.fatal).toBe('account limit reached')
    const soft = run([{ type: 'error', message: 'retrying', fatal: false }])
    expect(soft.state).toBe('idle')
    expect(soft.fatal).toBeUndefined()
  })
  it('sync rebuilds from the page and prepend puts the past in front, the keys stable', () => {
    const page: HistoryItem[] = [
      { event: { type: 'user_message', text: 'second' }, at: 2 },
      { event: { type: 'assistant_text', delta: 'two', final: true }, at: 2 }
    ]
    const synced = reduceConversation(emptyConversation, { sync: page })
    expect(synced.entries.map((e) => e.kind)).toEqual(['user', 'assistant'])
    expect(synced.first).toBe(0)
    const older: HistoryItem[] = [
      { event: { type: 'user_message', text: 'first' }, at: 1 },
      { event: { type: 'tool_call', id: 't', name: 'Read', input: {} }, at: 1 },
      { event: { type: 'tool_result', id: 't', output: 'x' }, at: 1 }
    ]
    const whole = reduceConversation(synced, { prepend: older })
    expect(whole.entries.map((e) => e.kind)).toEqual(['user', 'tool', 'user', 'assistant'])
    expect(whole.first).toBe(-2)
    expect(reduceConversation(whole, { prepend: [] })).toBe(whole)
  })
  it('an interrupted turn mutes the message and closes the open answer', () => {
    const c = run([
      { type: 'user_message', text: 'go' },
      { type: 'assistant_text', delta: 'half', final: false },
      { type: 'turn_interrupted' }
    ])
    expect(c.entries[0]).toMatchObject({ kind: 'user', interrupted: true })
    expect(c.entries[1]).toMatchObject({ kind: 'assistant', final: true })
  })
  it('session_meta, effort and permission_mode land on the conversation, provider events nowhere', () => {
    const c = run([
      { type: 'session_meta', model: 'echo-1', providerSessionId: null },
      { type: 'effort', effort: 'low' },
      { type: 'permission_mode', mode: 'default', modes: [{ id: 'default', label: 'Default' }] },
      { type: 'provider_event', provider: 'codex', payload: {} },
      { type: 'context_usage', used: 1, window: 2 }
    ])
    expect(c.model).toBe('echo-1')
    expect(c.effort).toBe('low')
    expect(c.permissionMode?.mode).toBe('default')
    expect(c.entries).toHaveLength(0)
  })
  it('exit ends the conversation with its code', () => {
    const c = reduceConversation(emptyConversation, { exit: 1 })
    expect(c).toMatchObject({ state: 'ended', exitCode: 1 })
  })
})
