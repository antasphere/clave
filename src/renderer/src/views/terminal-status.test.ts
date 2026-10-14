import { expect, it } from 'vitest'
import type { SessionEvent } from '../../../shared/session-model'
import {
  compactTokens,
  emptyStatus,
  reduceStatus,
  relaunchRequest,
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
      taskId: null,
      kind: 'agent',
      fromAgentTool: true,
      type: 'Explore',
      description: 'Find the reducer',
      background: false,
      startedAt: 1000,
      lastAction: expect.stringContaining('reducer.ts'),
      lastActiveAt: 1000,
      toolCount: 2,
      contextUsed: 42_000,
      model: null
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
  expect(launched.agents.map((a) => [a.id, a.kind, a.background, a.startedAt])).toEqual([
    ['bg-call', 'agent', true, 1000],
    ['shell-1', 'shell', true, 600]
  ])
  expect(run([{ type: 'background_tasks', tasks: [] }], launched).agents).toEqual([])
})

it('stacks a background shell beside the agents, named by its command', () => {
  const status = run([
    call('bash-1', 'Bash', { command: 'npm run dev', run_in_background: true }),
    { type: 'tool_result', id: 'bash-1', output: 'Command running in background with ID: b1' },
    {
      type: 'background_tasks',
      tasks: [
        { id: 'b1', kind: 'shell', description: 'npm run dev', toolUseId: 'bash-1', startedAt: 600 }
      ]
    }
  ])
  expect(status.agents).toEqual([
    {
      id: 'bash-1',
      taskId: 'b1',
      kind: 'shell',
      fromAgentTool: false,
      type: 'shell',
      description: 'npm run dev',
      background: true,
      startedAt: 600,
      lastAction: null,
      lastActiveAt: 600,
      toolCount: 0,
      contextUsed: null,
      model: null
    }
  ])
  // Its own completion is the list dropping it, never the turn's end.
  const after = run([{ type: 'state_change', state: 'done' }], status)
  expect(after.agents).toHaveLength(1)
  expect(run([{ type: 'background_tasks', tasks: [] }], after).agents).toEqual([])
})

it('never makes a row of a foreground command', () => {
  const status = run([
    call('c1', 'commandExecution', { command: 'echo fg' }),
    { type: 'tool_result', id: 'c1', output: 'fg' },
    call('b2', 'Bash', { command: 'ls' }),
    { type: 'state_change', state: 'done' }
  ])
  expect(status.agents).toEqual([])
})

it('lists a Codex subagent from the list alone, on the model Codex resolved', () => {
  const status = run([
    {
      type: 'background_tasks',
      tasks: [
        {
          id: 'thread-child',
          kind: 'agent',
          description: 'sleep_test',
          model: 'gpt-6.1-sol',
          startedAt: 700
        },
        {
          id: 'exec-1',
          kind: 'shell',
          description: 'sleep 30',
          toolUseId: 'exec-1',
          startedAt: 800
        }
      ]
    },
    { type: 'context_usage', used: 23_000, window: null, parent: 'thread-child' },
    { type: 'state_change', state: 'done' }
  ])
  expect(status.agents).toEqual([
    expect.objectContaining({
      id: 'thread-child',
      taskId: 'thread-child',
      kind: 'agent',
      fromAgentTool: false,
      type: 'agent',
      description: 'sleep_test',
      model: 'gpt-6.1-sol',
      contextUsed: 23_000,
      startedAt: 700
    }),
    expect.objectContaining({ id: 'exec-1', kind: 'shell', model: null })
  ])
  // The meter is the parent's: a child's reading never lands on it.
  expect(status.contextUsed).toBeNull()
})

it('reconciles a repeated or reconnected snapshot without doubling or keeping a gone row', () => {
  const tasks = [
    { id: 'thread-child', kind: 'agent' as const, description: 'a', startedAt: 700 },
    {
      id: 'exec-1',
      kind: 'shell' as const,
      description: 'sleep 30',
      toolUseId: 'exec-1',
      startedAt: 800
    }
  ]
  const twice = run([
    { type: 'background_tasks', tasks },
    { type: 'background_tasks', tasks }
  ])
  expect(twice.agents.map((a) => a.id)).toEqual(['thread-child', 'exec-1'])
  // A late view starts from nothing and reads the held snapshot whole.
  const late = run([{ type: 'background_tasks', tasks }])
  expect(late.agents).toEqual(twice.agents)
  const shrunk = run([{ type: 'background_tasks', tasks: [tasks[1]] }], twice)
  expect(shrunk.agents.map((a) => a.id)).toEqual(['exec-1'])
})

it('keeps a waited-on Claude agent beside the background work, then drops it at its result', () => {
  const status = run([
    call('fg-agent', 'Agent', { subagent_type: 'Explore', description: 'Wait on me' }),
    {
      type: 'background_tasks',
      tasks: [
        { id: 'b1', kind: 'shell', description: 'npm test', toolUseId: 'bash-1', startedAt: 600 }
      ]
    }
  ])
  expect(status.agents.map((a) => [a.id, a.kind])).toEqual([
    ['fg-agent', 'agent'],
    ['bash-1', 'shell']
  ])
  const done = run([{ type: 'tool_result', id: 'fg-agent', output: 'ok' }], status)
  expect(done.agents.map((a) => a.id)).toEqual(['bash-1'])
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

it('names an agent by the model its answer names, over the alias its call asked for', () => {
  const asked = run([
    call('agent-1', 'Agent', { subagent_type: 'Explore', description: 'Map', model: 'haiku' })
  ])
  expect(asked.agents[0].model).toBe('haiku')
  const answered = run(
    [{ type: 'subagent_model', parent: 'agent-1', model: 'claude-sonnet-5-5' }],
    asked
  )
  expect(answered.agents[0].model).toBe('claude-sonnet-5-5')
})

it('keeps the task a background agent runs as, which is what stopping it names', () => {
  const status = run([
    call('call-1', 'Agent', { subagent_type: 'Explore', description: 'Audit' }),
    { type: 'subagent_model', parent: 'call-1', model: 'claude-opus-5-5' },
    {
      type: 'background_tasks',
      tasks: [
        { id: 'task-9', kind: 'agent', description: 'Audit', toolUseId: 'call-1', startedAt: 500 }
      ]
    }
  ])
  expect(status.agents).toEqual([
    expect.objectContaining({
      id: 'call-1',
      taskId: 'task-9',
      fromAgentTool: true,
      background: true,
      model: 'claude-opus-5-5'
    })
  ])
})

it("dates an agent's last sign of work, which is what the quiet row reads", () => {
  const at = (events: SessionEvent[], time: number, start: TerminalStatus): TerminalStatus =>
    events.reduce((status, event) => reduceStatus(status, event, time), start)
  const started = at([call('agent-1', 'Agent', { description: 'x' })], 1_000, emptyStatus)
  const stepped = at([call('t1', 'Grep', { pattern: 'y' }, 'agent-1')], 50_000, started)
  expect(stepped.agents[0].lastActiveAt).toBe(50_000)
  const read = at(
    [{ type: 'context_usage', used: 9_000, window: null, parent: 'agent-1' }],
    70_000,
    stepped
  )
  expect(read.agents[0].lastActiveAt).toBe(70_000)
  // Its model being named is no step.
  const named = at(
    [{ type: 'subagent_model', parent: 'agent-1', model: 'claude-opus-5-5' }],
    90_000,
    read
  )
  expect(named.agents[0].lastActiveAt).toBe(70_000)
})

it('asks the conversation to relaunch the agent it made, on the alias picked', () => {
  const [agent] = run([
    call('agent-1', 'Agent', { subagent_type: 'Explore', description: 'Map the views' })
  ]).agents
  const text = relaunchRequest(agent, 'sonnet')
  expect(text).toContain('“Map the views” (Explore)')
  expect(text).toContain('Sonnet 5.5')
  expect(text).toContain('model "sonnet"')
})
