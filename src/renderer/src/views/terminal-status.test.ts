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
const call = (id: string, name: string, input: unknown, parent?: string): SessionEvent => ({
  type: 'tool_call',
  id,
  name,
  input,
  ...(parent ? { parent } : {})
})

it('keeps the context the adapter reports, and a window once one is named', () => {
  const early = run([{ type: 'context_usage', used: 12_010, window: null }])
  expect([early.contextUsed, early.contextWindow]).toEqual([12_010, null])
  const named = run([{ type: 'context_usage', used: 12_500, window: 1_000_000 }], early)
  expect([named.contextUsed, named.contextWindow]).toEqual([12_500, 1_000_000])
  // A later reading without a window keeps the one already known.
  expect(run([{ type: 'context_usage', used: 13_000, window: null }], named).contextWindow).toBe(
    1_000_000
  )
})

it('stacks a subagent from its call, follows its own calls, and drops it on its result', () => {
  const started = run([
    call('agent-1', 'Agent', { subagent_type: 'Explore', description: 'Find the reducer' }),
    call('t1', 'Grep', { pattern: 'reduce' }, 'agent-1'),
    call('t2', 'Read', { file_path: '/repo/reducer.ts' }, 'agent-1'),
    { type: 'context_usage', used: 42_000, window: null, parent: 'agent-1' }
  ])
  expect(started.agents).toEqual([
    {
      id: 'agent-1',
      type: 'Explore',
      description: 'Find the reducer',
      background: false,
      startedAt: 1000,
      lastAction: expect.stringContaining('reducer.ts'),
      toolCount: 2,
      contextUsed: 42_000
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
    { type: 'state_change', state: 'done' }
  ])
  expect(launched.agents.map((a) => [a.id, a.background, a.startedAt])).toEqual([
    ['bg-call', true, 1000]
  ])
  expect(run([{ type: 'background_tasks', tasks: [] }], launched).agents).toEqual([])
})

it('clears what the turn waited on when the reader interrupts it', () => {
  const status = run([call('a', 'Task', { description: 'x' }), { type: 'turn_interrupted' }])
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
