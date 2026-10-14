import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CodexTranslator } from './codex-adapter'
import {
  SessionEventSchema,
  type BackgroundTask,
  type SessionEvent
} from '../../../shared/session-model'
import type { RpcNotification } from './codex-app-server'

/* The capture behind these tests is agent-tasks.ndjson: Codex 0.162.1 asked
   for one subagent that outlives the turn, one background command, and one
   foreground command (fixtures/codex-app-server/README.md). */
const rows: { at: number; direction: string; frame: RpcNotification & { id?: unknown } }[] =
  readFileSync(new URL('../fixtures/codex-app-server/agent-tasks.ndjson', import.meta.url), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
const startReply = rows.find((r) => r.direction === 'server' && r.frame.id === 2)!
  .frame as unknown as { result: unknown }
const notifications = rows
  .filter((r) => r.direction === 'server' && r.frame.method && r.frame.id === undefined)
  .map((r) => r.frame)

function translator(): { translator: CodexTranslator; events: SessionEvent[] } {
  const events: SessionEvent[] = []
  const translator = new CodexTranslator((e) => events.push(SessionEventSchema.parse(e)))
  translator.metadata(startReply.result)
  return { translator, events }
}
const snapshots = (events: SessionEvent[]): BackgroundTask[][] =>
  events.flatMap((e) => (e.type === 'background_tasks' ? [e.tasks] : []))
const lastSnapshot = (events: SessionEvent[]): BackgroundTask[] | undefined =>
  snapshots(events).at(-1)
const isItem = (frame: RpcNotification, method: string, id: string): boolean =>
  frame.method === method && (frame.params as { item?: { id?: string } }).item?.id === id
/** Replays the capture up to and including the first frame `until` matches. */
function replayUntil(t: CodexTranslator, until: (frame: RpcNotification) => boolean): number {
  const index = notifications.findIndex(until)
  if (index < 0) throw new Error('fixture frame not found')
  for (const frame of notifications.slice(0, index + 1)) t.notification(frame)
  return index
}
const BACKGROUND = 'exec-466909ea-f9c9-47bb-8534-47350b3b1a60'
const FOREGROUND = 'exec-dd741450-709a-478b-88e3-418eca00c348'
const CHILD_COMMAND = 'exec-2f3cf0d1-d69d-4ccc-bf14-ed27c2176054'

describe('Codex agent tasks, from the recorded lifecycle', () => {
  it('lists a spawned subagent once, with its name and the model Codex resolved', () => {
    const { translator: t, events } = translator()
    replayUntil(t, (f) => isItem(f, 'item/completed', 'call_bd3d891bb23740df879d93be67bb3e4c'))
    // item/started and item/completed both carry the start: one snapshot.
    expect(snapshots(events)).toEqual([
      [
        {
          id: 'thread-child',
          kind: 'agent',
          description: 'sleep_test',
          model: 'gpt-6.1-sol',
          startedAt: expect.any(Number)
        }
      ]
    ])
  })

  it("keeps the child thread's text and tools out of the parent transcript", () => {
    const { translator: t, events } = translator()
    for (const frame of notifications) t.notification(frame)
    const text = events
      .filter((e) => e.type === 'assistant_text')
      .map((e) => (e.type === 'assistant_text' ? e.delta : ''))
      .join('')
    expect(text).toContain('I’ll run the protocol in the requested order.')
    expect(text).not.toMatch(/20-second wait|Done\./)
    const calls = events.flatMap((e) => (e.type === 'tool_call' ? [e.id] : []))
    expect(calls).toEqual([BACKGROUND, FOREGROUND])
    expect(calls).not.toContain(CHILD_COMMAND)
    // Exactly one done: the parent's turn, never the child's.
    expect(events.filter((e) => e.type === 'state_change' && e.state === 'done')).toHaveLength(1)
  })

  it("reads the subagent's own context under its row, and the parent's on the meter", () => {
    const { translator: t, events } = translator()
    for (const frame of notifications) t.notification(frame)
    const usage = events.filter((e) => e.type === 'context_usage')
    expect(usage.some((e) => e.type === 'context_usage' && e.parent === 'thread-child')).toBe(true)
    expect(usage.some((e) => e.type === 'context_usage' && e.parent === undefined)).toBe(true)
  })

  it('lists a command still running when the turn ends, and never a foreground one', () => {
    const { translator: t, events } = translator()
    replayUntil(t, (f) => isItem(f, 'item/completed', FOREGROUND))
    // Mid-turn nothing says a command was left running: no shell row yet.
    expect(
      snapshots(events)
        .flat()
        .some((task) => task.kind === 'shell')
    ).toBe(false)
    replayUntil(t, (f) => f.method === 'turn/completed')
    const done = events.findIndex((e) => e.type === 'state_change' && e.state === 'done')
    const listed = events.findLastIndex((e) => e.type === 'background_tasks')
    expect(listed).toBeGreaterThan(-1)
    expect(listed).toBeLessThan(done)
    expect(lastSnapshot(events)).toEqual([
      expect.objectContaining({ id: 'thread-child', kind: 'agent' }),
      {
        id: BACKGROUND,
        kind: 'shell',
        description: 'sleep 30 && echo bg2',
        toolUseId: BACKGROUND,
        startedAt: expect.any(Number)
      }
    ])
    expect(
      snapshots(events)
        .flat()
        .map((task) => task.id)
    ).not.toContain(FOREGROUND)
  })

  it('drops the command at its own completion and the agent at its own, after the turn', () => {
    const { translator: t, events } = translator()
    replayUntil(t, (f) => isItem(f, 'item/completed', BACKGROUND))
    expect(lastSnapshot(events)?.map((task) => task.id)).toEqual(['thread-child'])
    for (const frame of notifications) t.notification(frame)
    expect(lastSnapshot(events)).toEqual([])
    // The command's own completion still closes its transcript row.
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_result', id: BACKGROUND }))
  })

  it('publishes nothing for a frame that changes nothing', () => {
    const { translator: t, events } = translator()
    for (const frame of notifications) t.notification(frame)
    const lists = snapshots(events).map((tasks) => tasks.map((task) => task.id).join(','))
    // started agent → +shell at turn end → shell done → agent done.
    expect(lists).toEqual(['thread-child', `thread-child,${BACKGROUND}`, 'thread-child', ''])
  })
})

describe('Codex agent tasks, an interrupted turn', () => {
  // agent-tasks-interrupt.ndjson: a background command, then a foreground
  // one, and turn/interrupt three seconds into it. Both processes outlive the
  // interrupted turn; the foreground one completes 27 seconds after it.
  const frames = readFileSync(
    new URL('../fixtures/codex-app-server/agent-tasks-interrupt.ndjson', import.meta.url),
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  it('lists what the interrupt left running, and drops each at its own completion', () => {
    const { translator: t, events } = translator()
    for (const { direction, frame } of frames)
      if (direction === 'server' && frame.method && frame.id === undefined) t.notification(frame)
    expect(events.some((e) => e.type === 'turn_interrupted')).toBe(true)
    expect(snapshots(events).map((tasks) => tasks.map((task) => task.description))).toEqual([
      ['sleep 40 && echo bgi', 'sleep 30 && echo fgi'],
      ['sleep 40 && echo bgi']
    ])
  })
})

const at = (params: Record<string, unknown>, method = 'item/started'): RpcNotification => ({
  method,
  params: { threadId: 'thread-parent', turnId: 'turn-parent', ...params }
})
const started = (
  id: string,
  thread: string,
  extra: Record<string, unknown> = {}
): RpcNotification =>
  at({
    item: {
      type: 'subAgentActivity',
      id,
      kind: 'started',
      agentThreadId: thread,
      agentPath: `/root/${id}`,
      model: null,
      reasoningEffort: null,
      ...extra
    }
  })

describe('Codex agent tasks, schema-derived edges', () => {
  it('drops an agent Codex reports interrupted, and keeps an interaction as no change', () => {
    const { translator: t, events } = translator()
    t.notification(started('a', 'child-a'))
    t.notification(
      at({
        item: { type: 'subAgentActivity', id: 'i', kind: 'interacted', agentThreadId: 'child-a' }
      })
    )
    expect(snapshots(events)).toHaveLength(1)
    t.notification(
      at({
        item: { type: 'subAgentActivity', id: 'x', kind: 'interrupted', agentThreadId: 'child-a' }
      })
    )
    expect(lastSnapshot(events)).toEqual([])
  })

  it('follows the v1 collaboration tools: spawn lists, a terminal state or a close drops', () => {
    const { translator: t, events } = translator()
    const collab = (
      tool: string,
      status: string,
      extra: Record<string, unknown>
    ): RpcNotification =>
      at(
        {
          item: {
            type: 'collabAgentToolCall',
            id: `${tool}-1`,
            tool,
            status,
            senderThreadId: 'thread-parent',
            receiverThreadIds: [],
            prompt: null,
            model: null,
            reasoningEffort: null,
            agentsStates: {},
            ...extra
          }
        },
        'item/completed'
      )
    t.notification(
      collab('spawnAgent', 'completed', {
        receiverThreadIds: ['child-1', 'child-2'],
        prompt: 'Audit the reducer',
        model: 'gpt-6.1-mini',
        agentsStates: {
          'child-1': { status: 'running', message: null },
          'child-2': { status: 'pendingInit', message: null }
        }
      })
    )
    expect(lastSnapshot(events)).toEqual([
      expect.objectContaining({
        id: 'child-1',
        kind: 'agent',
        description: 'Audit the reducer',
        model: 'gpt-6.1-mini'
      }),
      expect.objectContaining({ id: 'child-2', kind: 'agent' })
    ])
    t.notification(
      collab('wait', 'completed', {
        receiverThreadIds: ['child-1'],
        agentsStates: { 'child-1': { status: 'completed', message: 'done' } }
      })
    )
    expect(lastSnapshot(events)?.map((task) => task.id)).toEqual(['child-2'])
    t.notification(collab('closeAgent', 'completed', { receiverThreadIds: ['child-2'] }))
    expect(lastSnapshot(events)).toEqual([])
  })

  it('does not list a spawn that failed', () => {
    const { translator: t, events } = translator()
    t.notification(
      at(
        {
          item: {
            type: 'collabAgentToolCall',
            id: 'spawn-x',
            tool: 'spawnAgent',
            status: 'failed',
            senderThreadId: 'thread-parent',
            receiverThreadIds: ['child-x'],
            prompt: 'x',
            model: null,
            reasoningEffort: null,
            agentsStates: {}
          }
        },
        'item/completed'
      )
    )
    expect(snapshots(events)).toEqual([])
  })

  it('drops an agent whose thread Codex closes', () => {
    const { translator: t, events } = translator()
    t.notification(started('a', 'child-a'))
    t.notification({ method: 'thread/closed', params: { threadId: 'child-a' } })
    expect(lastSnapshot(events)).toEqual([])
  })

  it("keeps an unknown thread's frames as provider events, and nothing else", () => {
    const { translator: t, events } = translator()
    const stranger = [
      {
        method: 'item/agentMessage/delta',
        params: { threadId: 'stranger', turnId: 's', itemId: 'm', delta: 'leak' }
      },
      {
        method: 'item/started',
        params: {
          threadId: 'stranger',
          turnId: 's',
          item: { type: 'commandExecution', id: 'c', command: 'ls', status: 'inProgress' }
        }
      },
      {
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: 'stranger',
          turnId: 's',
          tokenUsage: { last: { totalTokens: 500, reasoningOutputTokens: 0 } }
        }
      },
      { method: 'turn/completed', params: { threadId: 'stranger', turn: { id: 's' } } }
    ]
    const before = events.length
    for (const frame of stranger) t.notification(frame)
    expect(events.slice(before).map((e) => e.type)).toEqual(stranger.map(() => 'provider_event'))
  })

  it('keeps a known child thread to its row: its text, tools and turns stay out', () => {
    const { translator: t, events } = translator()
    t.notification(started('a', 'child-a'))
    const before = events.length
    t.notification({
      method: 'item/agentMessage/delta',
      params: { threadId: 'child-a', turnId: 'c', itemId: 'm', delta: 'leak' }
    })
    t.notification({ method: 'turn/completed', params: { threadId: 'child-a', turn: { id: 'c' } } })
    expect(events.slice(before).map((e) => e.type)).toEqual(['provider_event', 'provider_event'])
  })

  it('never promotes a poll of a running process into a row of its own', () => {
    const { translator: t, events } = translator()
    t.notification({
      method: 'turn/started',
      params: { threadId: 'thread-parent', turn: { id: 'turn-parent' } }
    })
    t.notification(
      at({
        item: {
          type: 'commandExecution',
          id: 'poll',
          command: 'sleep 9',
          commandActions: [],
          processId: '7',
          source: 'unifiedExecInteraction',
          status: 'inProgress'
        }
      })
    )
    t.notification(at({ turn: { id: 'turn-parent', status: 'completed' } }, 'turn/completed'))
    expect(snapshots(events)).toEqual([])
  })

  it('empties the list when the app-server goes away', () => {
    const { translator: t, events } = translator()
    t.notification(started('a', 'child-a'))
    t.clearBackground()
    expect(lastSnapshot(events)).toEqual([])
    const count = snapshots(events).length
    t.clearBackground()
    expect(snapshots(events)).toHaveLength(count)
  })
})
