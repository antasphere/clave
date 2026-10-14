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
      requestedBackground: false,
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
      requestedBackground: false,
      type: 'shell',
      description: 'npm run dev',
      background: true,
      // The card opened at the call, and the promotion keeps it.
      startedAt: 1000,
      lastAction: null,
      lastActiveAt: 1000,
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

it('shows a Codex command while it runs, as running rather than background, until its result', () => {
  const running = run([
    call('c1', 'commandExecution', {
      command: "/bin/zsh -lc 'echo fg'",
      commandActions: [{ type: 'unknown', command: 'echo fg' }]
    })
  ])
  expect(running.agents).toEqual([
    {
      id: 'c1',
      taskId: null,
      kind: 'shell',
      fromAgentTool: false,
      requestedBackground: false,
      type: 'shell',
      description: 'echo fg',
      background: false,
      startedAt: 1000,
      lastAction: null,
      lastActiveAt: 1000,
      toolCount: 0,
      contextUsed: null,
      model: null
    }
  ])
  expect(run([{ type: 'tool_result', id: 'c1', output: 'fg' }], running).agents).toEqual([])
})

it('keeps one row when a running command outlives the turn and becomes background work', () => {
  const running = run([call('c1', 'commandExecution', { command: 'sleep 30', commandActions: [] })])
  const promoted = run(
    [
      {
        type: 'background_tasks',
        tasks: [
          { id: 'c1', kind: 'shell', description: 'sleep 30', toolUseId: 'c1', startedAt: 5000 }
        ]
      },
      { type: 'state_change', state: 'done' }
    ],
    running
  )
  expect(promoted.agents.map((a) => [a.id, a.background, a.startedAt])).toEqual([
    ['c1', true, 1000]
  ])
  // Its completion's result leaves it to the list, which drops it.
  const resulted = run([{ type: 'tool_result', id: 'c1', output: 'ok' }], promoted)
  expect(resulted.agents).toHaveLength(1)
  expect(run([{ type: 'background_tasks', tasks: [] }], resulted).agents).toEqual([])
})

it('drops a running command the turn ends without listing', () => {
  const status = run([
    call('c1', 'commandExecution', { command: 'echo fg', commandActions: [] }),
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

it("never makes a second row of a poll of a running command, and the poll's end keeps the first", () => {
  const polled = run([
    call('exec-1', 'commandExecution', { command: 'sleep 30', source: 'unifiedExecStartup' }),
    call('poll-1', 'commandExecution', { command: 'sleep 30', source: 'unifiedExecInteraction' })
  ])
  expect(polled.agents.map((a) => [a.id, a.kind, a.background])).toEqual([
    ['exec-1', 'shell', false]
  ])
  const pollDone = run([{ type: 'tool_result', id: 'poll-1', output: '' }], polled)
  expect(pollDone.agents.map((a) => a.id)).toEqual(['exec-1'])
  expect(run([{ type: 'tool_result', id: 'exec-1', output: 'ok' }], pollDone).agents).toEqual([])
})

it("starts a reused agent's next run fresh, never quiet off the last run, keeping its context", () => {
  const at = (events: SessionEvent[], time: number, start: TerminalStatus): TerminalStatus =>
    events.reduce((status, event) => reduceStatus(status, event, time), start)
  const task = (startedAt: number): SessionEvent => ({
    type: 'background_tasks',
    tasks: [
      {
        id: 'thread-child',
        kind: 'agent' as const,
        description: 'echoer',
        model: 'gpt-6.1-sol',
        startedAt
      }
    ]
  })
  const firstRun = at(
    [task(500), { type: 'context_usage', used: 23_000, window: null, parent: 'thread-child' }],
    1_000,
    emptyStatus
  )
  const ended = at([{ type: 'background_tasks', tasks: [] }], 2_000, firstRun)
  const [rerun] = at([task(100_000)], 100_000, ended).agents
  expect(rerun).toEqual(
    expect.objectContaining({
      id: 'thread-child',
      startedAt: 100_000,
      lastActiveAt: 100_000,
      contextUsed: 23_000,
      model: 'gpt-6.1-sol'
    })
  )
})

/* Claude Bash, in the order the installed CLI sends it (claude-stream/
   background-bash.ndjson): a backgrounded call's tool_use, then the
   background list and task_started naming the call, then the "running in
   background" result; a waited-on call's tool_use, then its result. */
const bash = (id: string, command: string, background = false): SessionEvent =>
  call(id, 'Bash', { command, ...(background ? { run_in_background: true } : {}) })
const listed = (...tasks: { id: string; call: string; command: string }[]): SessionEvent => ({
  type: 'background_tasks',
  tasks: tasks.map((t) => ({
    id: t.id,
    kind: 'shell',
    description: t.command,
    toolUseId: t.call,
    startedAt: 3000
  }))
})
const at = (
  events: SessionEvent[],
  time: number,
  start: TerminalStatus = emptyStatus
): TerminalStatus => events.reduce((status, event) => reduceStatus(status, event, time), start)
const rowsOf = (status: TerminalStatus): string[] =>
  status.agents.map((a) => `${a.kind}:${a.id}:${a.background ? 'bg' : 'run'}:${a.startedAt}`)

it('shows a Claude Bash call as a running card until its result, success or error', () => {
  const running = at([bash('b1', 'npm test')], 1000)
  expect(running.agents).toEqual([
    expect.objectContaining({
      id: 'b1',
      taskId: null,
      kind: 'shell',
      type: 'shell',
      description: 'npm test',
      background: false,
      model: null,
      fromAgentTool: false
    })
  ])
  expect(at([{ type: 'tool_result', id: 'b1', output: 'ok' }], 2000, running).agents).toEqual([])
  expect(
    at([{ type: 'tool_result', id: 'b1', output: 'exit 1', error: true }], 2000, running).agents
  ).toEqual([])
})

it('runs a Claude agent and a Bash card side by side, each leaving at its own result', () => {
  const both = at(
    [call('a1', 'Agent', { subagent_type: 'Explore', description: 'Map' }), bash('b1', 'ls')],
    1000
  )
  expect(both.agents.map((a) => `${a.kind}:${a.id}`)).toEqual(['agent:a1', 'shell:b1'])
  const shellDone = at([{ type: 'tool_result', id: 'b1', output: '' }], 2000, both)
  expect(shellDone.agents.map((a) => a.id)).toEqual(['a1'])
  expect(at([{ type: 'tool_result', id: 'a1', output: '' }], 3000, shellDone).agents).toEqual([])
})

it('promotes a backgrounded Bash card in place, through its acknowledgement and the turn, to its completion', () => {
  const call1 = at([bash('b1', 'sleep 10 && echo bgc', true)], 1000)
  expect(rowsOf(call1)).toEqual(['shell:b1:run:1000'])
  const promoted = at(
    [
      listed({ id: 'task-1', call: 'b1', command: 'sleep 10 && echo bgc' }),
      { type: 'tool_result', id: 'b1', output: 'Command running in background with ID: task-1' },
      { type: 'state_change', state: 'done' }
    ],
    3000,
    call1
  )
  expect(rowsOf(promoted)).toEqual(['shell:b1:bg:1000'])
  expect(promoted.agents[0].taskId).toBe('task-1')
  expect(at([{ type: 'background_tasks', tasks: [] }], 13_000, promoted).agents).toEqual([])
})

it('keeps a backgrounded card whose acknowledgement arrives before the list, and promotes the same card', () => {
  const acked = at(
    [
      bash('b1', 'sleep 10', true),
      { type: 'tool_result', id: 'b1', output: 'Command running in background with ID: task-1' }
    ],
    1000
  )
  expect(rowsOf(acked)).toEqual(['shell:b1:run:1000'])
  const promoted = at([listed({ id: 'task-1', call: 'b1', command: 'sleep 10' })], 3000, acked)
  expect(rowsOf(promoted)).toEqual(['shell:b1:bg:1000'])
  // Never listed: the turn's end takes it, so no card outlives it unconfirmed.
  expect(at([{ type: 'state_change', state: 'done' }], 4000, acked).agents).toEqual([])
})

it('never doubles a Bash card through a repeated call, a repeated list, or a waited-on call beside it', () => {
  const status = at(
    [
      bash('b1', 'sleep 10', true),
      bash('b1', 'sleep 10', true),
      bash('b2', 'echo fgc'),
      listed({ id: 'task-1', call: 'b1', command: 'sleep 10' }),
      listed({ id: 'task-1', call: 'b1', command: 'sleep 10' }),
      { type: 'tool_result', id: 'b1', output: 'running in background' },
      { type: 'tool_result', id: 'b2', output: 'fgc' }
    ],
    1000
  )
  expect(rowsOf(status)).toEqual(['shell:b1:bg:1000'])
})

it('clears a waited-on Bash card at an interruption, and keeps a backgrounded one', () => {
  const status = at(
    [
      bash('b1', 'sleep 10', true),
      listed({ id: 'task-1', call: 'b1', command: 'sleep 10' }),
      bash('b2', 'sleep 60'),
      { type: 'turn_interrupted' }
    ],
    1000
  )
  expect(rowsOf(status)).toEqual(['shell:b1:bg:1000'])
})

it("counts a subagent's own Bash call as its activity, never as a card of its own", () => {
  const status = at(
    [
      call('a1', 'Agent', { subagent_type: 'Explore', description: 'Map' }),
      call('s1', 'Bash', { command: 'ls' }, 'a1')
    ],
    1000
  )
  expect(status.agents.map((a) => `${a.kind}:${a.id}:${a.toolCount}`)).toEqual(['agent:a1:1'])
})

it('promotes a card where it stands, never moving it below a card that came after it', () => {
  const status = at(
    [
      bash('b1', 'sleep 10 && echo bgc', true),
      bash('b2', 'echo fgc'),
      listed({ id: 'task-1', call: 'b1', command: 'sleep 10 && echo bgc' })
    ],
    1000
  )
  expect(rowsOf(status)).toEqual(['shell:b1:bg:1000', 'shell:b2:run:1000'])
})

it('clears a backgrounding Bash card whose call failed or was denied before any list confirmed it', () => {
  const denied = at(
    [
      bash('b1', 'sleep 10', true),
      { type: 'tool_result', id: 'b1', output: 'Permission denied', error: true }
    ],
    1000
  )
  expect(denied.agents).toEqual([])
  // Once the provider listed it, its own list decides, whatever a result says.
  const confirmed = at(
    [
      bash('b2', 'sleep 10', true),
      listed({ id: 'task-2', call: 'b2', command: 'sleep 10' }),
      { type: 'tool_result', id: 'b2', output: 'odd', error: true }
    ],
    1000
  )
  expect(rowsOf(confirmed)).toEqual(['shell:b2:bg:1000'])
  expect(at([{ type: 'background_tasks', tasks: [] }], 2000, confirmed).agents).toEqual([])
})

it('keeps nothing when the command completes before its acknowledgement arrives', () => {
  const status = at(
    [
      bash('b1', 'echo quick', true),
      listed({ id: 'task-1', call: 'b1', command: 'echo quick' }),
      { type: 'background_tasks', tasks: [] },
      { type: 'tool_result', id: 'b1', output: 'Command running in background with ID: task-1' }
    ],
    1000
  )
  expect(status.agents).toEqual([])
})

it('keeps two same-named commands apart, each card promoted by its own call id', () => {
  const status = at(
    [
      bash('b1', 'sleep 10', true),
      bash('b2', 'sleep 10', true),
      {
        type: 'background_tasks',
        tasks: [
          {
            id: 'task-2',
            kind: 'shell',
            description: 'sleep 10',
            toolUseId: 'b2',
            startedAt: 3000
          },
          { id: 'task-1', kind: 'shell', description: 'sleep 10', toolUseId: 'b1', startedAt: 3000 }
        ]
      }
    ],
    1000
  )
  expect(status.agents.map((a) => `${a.id}:${a.taskId}:${a.background}`)).toEqual([
    'b1:task-1:true',
    'b2:task-2:true'
  ])
})

it('settles to one card when the list named the task before its call id was known', () => {
  const unlinked: SessionEvent = {
    type: 'background_tasks',
    tasks: [{ id: 'task-1', kind: 'shell', description: 'sleep 10', startedAt: 3000 }]
  }
  const linked = listed({ id: 'task-1', call: 'b1', command: 'sleep 10' })
  const status = at([bash('b1', 'sleep 10', true), unlinked, linked], 1000)
  expect(rowsOf(status)).toEqual(['shell:b1:bg:1000'])
})
