import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '../../../../../../packages/shared/src/session-model'
import {
  foldSubagents,
  noSubagents,
  parentOf,
  reduceSubagents
} from '../../../../../plugins/chat-view/src/subagents'
import { emptyConversation, reduceConversation } from '../../../../../plugins/chat-view/src/reducer'

const run = (events: SessionEvent[], at = 1000): ReturnType<typeof reduceSubagents> =>
  events.reduce((logs, event) => reduceSubagents(logs, event, at), noSubagents)

describe('reduceSubagents', () => {
  it("builds a subagent's own conversation from the events that name its call", () => {
    const logs = run([
      { type: 'tool_call', id: 'agent-1', name: 'Agent', input: { description: 'Map' } },
      { type: 'user_message', text: 'Find every view', parent: 'agent-1' },
      { type: 'tool_call', id: 's1', name: 'Grep', input: { pattern: 'view' }, parent: 'agent-1' },
      { type: 'tool_result', id: 's1', output: 'registry.tsx', parent: 'agent-1' },
      { type: 'assistant_text', delta: 'Two views.', final: true, parent: 'agent-1' }
    ])
    expect(Object.keys(logs)).toEqual(['agent-1'])
    expect(logs['agent-1'].entries.map((e) => e.kind)).toEqual(['user', 'tool', 'assistant'])
    const tool = logs['agent-1'].entries[1]
    expect(tool.kind === 'tool' && tool.complete && tool.output).toBe('registry.tsx')
  })

  it('keeps each agent apart, and leaves the logs alone for an event with no parent', () => {
    const logs = run([
      { type: 'assistant_text', delta: 'Hello', final: true },
      { type: 'assistant_text', delta: 'A', final: true, parent: 'a' },
      { type: 'assistant_text', delta: 'B', final: true, parent: 'b' },
      { type: 'context_usage', used: 10, window: null, parent: 'a' },
      { type: 'subagent_model', parent: 'a', model: 'claude-haiku-5-5' }
    ])
    expect(Object.keys(logs)).toEqual(['a', 'b'])
    expect(logs.a.entries).toHaveLength(1)
    expect(reduceSubagents(logs, { type: 'state_change', state: 'done' })).toBe(logs)
  })

  it('keeps the newest two dozen agents, the oldest going first', () => {
    const logs = run(
      Array.from({ length: 30 }, (_, i) => ({
        type: 'assistant_text' as const,
        delta: 'x',
        final: true,
        parent: `p${i}`
      }))
    )
    const keys = Object.keys(logs)
    expect(keys).toHaveLength(24)
    expect(keys[0]).toBe('p6')
    expect(keys.at(-1)).toBe('p29')
  })

  it('folds a page of the past in the order it happened', () => {
    const logs = foldSubagents(noSubagents, [
      { event: { type: 'user_message', text: 'Brief', parent: 'a' }, at: 1 },
      { event: { type: 'assistant_text', delta: 'Done', final: true, parent: 'a' }, at: 2 }
    ])
    expect(logs.a.entries.map((e) => [e.kind, e.at])).toEqual([
      ['user', 1],
      ['assistant', 2]
    ])
  })

  it('names the parent of an event, and nothing for the conversation’s own', () => {
    expect(parentOf({ type: 'tool_result', id: 'x', output: null, parent: 'p' })).toBe('p')
    expect(parentOf({ type: 'tool_result', id: 'x', output: null })).toBeUndefined()
    expect(parentOf({ type: 'user_message', text: 'hi', parent: '' })).toBeUndefined()
  })
})

describe('the transcript and a subagent’s events', () => {
  it("never takes a subagent's message, text, call or result into the conversation", () => {
    const events: SessionEvent[] = [
      { type: 'user_message', text: 'Brief', parent: 'agent-1' },
      { type: 'assistant_text', delta: 'Working', final: false, parent: 'agent-1' },
      { type: 'tool_call', id: 's1', name: 'Read', input: {}, parent: 'agent-1' },
      { type: 'tool_result', id: 's1', output: 'x', parent: 'agent-1' }
    ]
    const state = events.reduce((c, event) => reduceConversation(c, { event }), emptyConversation)
    expect(state).toBe(emptyConversation)
    // The conversation's own still lands.
    const own = reduceConversation(emptyConversation, {
      event: { type: 'tool_call', id: 'm1', name: 'Read', input: {} }
    })
    expect(own.entries.map((e) => e.kind)).toEqual(['tool'])
  })
})
