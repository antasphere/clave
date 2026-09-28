import { expect, it } from 'vitest'
import type { SessionEvent } from '../../../shared/session-model'
import {
  compactTokens,
  emptyStatus,
  reduceStatus,
  type TerminalStatus
} from '../../../../plugins/chat-view/src/terminal-status'

const run = (events: SessionEvent[], start: TerminalStatus = emptyStatus): TerminalStatus =>
  events.reduce((status, event) => reduceStatus(status, event, 1000), start)
const claude = (payload: unknown): SessionEvent => ({
  type: 'provider_event',
  provider: 'claude',
  payload
})
const assistant = (parent: string | null, content: unknown[], usage?: object): SessionEvent =>
  claude({ type: 'assistant', parent_tool_use_id: parent, message: { content, usage } })

it('reads the context off the main thread and its window off the result', () => {
  const status = run([
    assistant(null, [], {
      input_tokens: 2,
      cache_read_input_tokens: 10_000,
      cache_creation_input_tokens: 2_000,
      output_tokens: 8
    }),
    // A subagent's own usage is its context, not the conversation's.
    assistant('agent-1', [], { input_tokens: 90_000 }),
    claude({
      type: 'result',
      modelUsage: {
        'claude-opus-5[1m]': { contextWindow: 1_000_000 },
        'claude-haiku-4-5': { contextWindow: 200_000 }
      }
    })
  ])
  expect(status.contextUsed).toBe(12_010)
  expect(status.contextWindow).toBe(1_000_000)
})

it('stacks a subagent from its call, follows its own calls, and drops it on its result', () => {
  const started = run([
    {
      type: 'tool_call',
      id: 'agent-1',
      name: 'Agent',
      input: { subagent_type: 'Explore', description: 'Find the reducer' }
    },
    assistant('agent-1', [
      { type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'reduce' } },
      { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/repo/reducer.ts' } }
    ])
  ])
  expect(started.agents).toEqual([
    {
      id: 'agent-1',
      type: 'Explore',
      description: 'Find the reducer',
      background: false,
      startedAt: 1000,
      lastAction: expect.stringContaining('reducer.ts'),
      toolCount: 2
    }
  ])
  const done = run([{ type: 'tool_result', id: 'agent-1', output: 'found it' }], started)
  expect(done.agents).toEqual([])
})

it('keeps a background agent until the background list drops it, not past the turn', () => {
  const launched = run([
    {
      type: 'tool_call',
      id: 'bg-call',
      name: 'Agent',
      input: { description: 'Audit', run_in_background: true }
    },
    { type: 'tool_result', id: 'bg-call', output: 'running in background' },
    {
      type: 'background_tasks',
      tasks: [
        { id: 'task-9', kind: 'agent', description: 'Audit', toolUseId: 'bg-call', startedAt: 500 },
        { id: 'shell-1', kind: 'shell', description: 'npm run dev', startedAt: 600 }
      ]
    },
    claude({ type: 'result', modelUsage: {} })
  ])
  expect(launched.agents.map((a) => [a.id, a.background, a.startedAt])).toEqual([
    ['bg-call', true, 1000]
  ])
  expect(run([{ type: 'background_tasks', tasks: [] }], launched).agents).toEqual([])
})

it('clears what the turn waited on when the reader interrupts it', () => {
  const status = run([
    { type: 'tool_call', id: 'a', name: 'Task', input: { description: 'x' } },
    { type: 'turn_interrupted' }
  ])
  expect(status.agents).toEqual([])
})

it('counts tokens the way the status line shows them', () => {
  expect([
    compactTokens(0),
    compactTokens(950),
    compactTokens(12_400),
    compactTokens(1_000_000)
  ]).toEqual(['0', '950', '12k', '1M'])
})
