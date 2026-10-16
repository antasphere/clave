import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createAgentTokenStore } from '../agent-tokens'
import { installTerminalPorts, resetTerminalPorts } from '../../ports/terminals'
import { CodexAdapter } from './codex-adapter'
import { replayCodexHistory } from './codex-history'
import { SessionManager } from '../session-manager'
import { SessionEventSchema, type SessionStream } from '../../../shared/session-model'

const roots: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const at = '2026-10-12T10:10:24.000Z'
const line = (type: string, payload: unknown): string =>
  JSON.stringify({ timestamp: at, type, payload })
const completed = (item: unknown): string =>
  line('event_msg', { type: 'item_completed', thread_id: 'saved', turn_id: 'turn', item })
const message = (type: string, id: string, text: string): string =>
  completed({ type, id, content: [{ type: type === 'AgentMessage' ? 'Text' : 'text', text }] })

async function setup(
  lines: string[],
  resume: string | undefined = 'saved'
): Promise<{
  manager: SessionManager
  adapter: CodexAdapter
  connect: ReturnType<typeof vi.fn>
  file: string
  root: string
}> {
  const root = mkdtempSync(join(tmpdir(), 'clave-codex-history-'))
  roots.push(root)
  const sessions = join(root, 'sessions', '2026', '10', '12')
  mkdirSync(sessions, { recursive: true })
  const file = join(sessions, 'rollout-2026-10-12T10-10-24-saved.jsonl')
  writeFileSync(
    file,
    [line('event_msg', { type: 'task_started', turn_id: 'turn' }), ...lines].join('\n') + '\n'
  )
  // Exercise the configured account home, not the developer's ~/.codex.
  const connect = vi.fn(() => {
    throw new Error('History must be available before the provider connects')
  })
  const adapter = new CodexAdapter(connect)
  adapter.configure(
    'tab',
    { id: 'codex', name: 'Codex', family: 'codex', command: ['codex'], additionalArgs: [] },
    { CODEX_HOME: root }
  )
  const manager = new SessionManager()
  manager.registerAdapter(adapter)
  await manager.create({
    id: 'tab',
    provider: 'codex',
    adapterId: adapter.id,
    transport: 'events',
    cwd: root,
    title: 'Saved chat',
    windowKey: 'window',
    state: 'idle',
    createdAt: 1,
    options: { resume }
  })
  return { manager, adapter, connect, file, root }
}

describe('Codex resumed chat history', () => {
  it('reads older response-item turns, filters injected context, and closes unanswered calls', () => {
    const response = (payload: unknown): string => line('response_item', payload)
    const msg = (role: string, text: string): string =>
      response({ type: 'message', role, content: [{ type: 'input_text', text }] })
    const history = replayCodexHistory([
      msg('developer', 'system rules'),
      msg('user', '# AGENTS.md instructions for /project'),
      msg('user', '<environment_context>context</environment_context>'),
      msg('user', '<div> is broken'),
      response({
        type: 'function_call',
        call_id: 'c',
        name: 'shell',
        arguments: '{"command":"pwd"}'
      }),
      response({ type: 'function_call_output', call_id: 'c', output: '/project' }),
      response({
        type: 'custom_tool_call',
        call_id: 'p',
        name: 'apply_patch',
        input: 'patch text'
      }),
      line('event_msg', { type: 'turn_aborted' }),
      msg('user', 'Try again'),
      msg('assistant', 'Done'),
      line('event_msg', {
        type: 'token_count',
        info: {
          last_token_usage: { total_tokens: 1200, reasoning_output_tokens: 200 },
          model_context_window: 10000
        }
      })
    ]).map(({ event }) => event)
    expect(history).toEqual([
      { type: 'user_message', text: '<div> is broken' },
      { type: 'tool_call', id: 'c', name: 'shell', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'c', output: '/project' },
      { type: 'tool_call', id: 'p', name: 'apply_patch', input: 'patch text' },
      { type: 'tool_result', id: 'p', output: undefined },
      { type: 'turn_interrupted' },
      { type: 'user_message', text: 'Try again' },
      { type: 'assistant_text', delta: 'Done', final: true },
      { type: 'context_usage', used: 1000, window: 10000 }
    ])
  })

  it('keeps older turns when the same rollout later gains completed UI items', () => {
    const history = replayCodexHistory([
      line('event_msg', { type: 'task_started', turn_id: 'old' }),
      line('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Old question' }]
      }),
      line('response_item', {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Old answer' }]
      }),
      line('event_msg', { type: 'task_started', turn_id: 'turn' }),
      message('UserMessage', 'u', 'New question'),
      message('AgentMessage', 'a', 'New answer'),
      message('AgentMessage', 'a', 'New answer')
    ])
    expect(history.map(({ event }) => event.type)).toEqual([
      'user_message',
      'assistant_text',
      'user_message',
      'assistant_text'
    ])
  })
  it('restores messages and completed tools once, without leaking provider context or streaming the past', async () => {
    const { manager, connect } = await setup([
      line('response_item', {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'private context' }]
      }),
      line('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Fix the sidebar' }]
      }),
      message('UserMessage', 'u', 'Fix the sidebar'),
      line('response_item', {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Checking it.' }]
      }),
      message('AgentMessage', 'a', 'Checking it.'),
      completed({ type: 'Reasoning', id: 'r', raw_content: ['hidden reasoning'] }),
      completed({
        type: 'CommandExecution',
        id: 'c',
        command: ['echo', 'ok'],
        cwd: '/project',
        status: 'completed',
        aggregated_output: 'ok',
        exit_code: 0
      }),
      completed({
        type: 'FileChange',
        id: 'p',
        changes: { 'a.ts': { type: 'add', content: 'ok' } },
        status: 'completed'
      }),
      message('AgentMessage', 'z', 'Fixed.'),
      '{incomplete'
    ])
    const streams: SessionStream[] = []
    manager.subscribe('tab', (stream) => streams.push(stream))
    const history = manager.history('tab')
    expect(history.items.map(({ event }) => event.type)).toEqual([
      'user_message',
      'assistant_text',
      'tool_call',
      'tool_result',
      'tool_call',
      'tool_result',
      'assistant_text'
    ])
    expect(history.items[0]).toEqual({
      at: Date.parse(at),
      event: { type: 'user_message', text: 'Fix the sidebar' }
    })
    expect(history.items.at(-1)?.event).toEqual({
      type: 'assistant_text',
      delta: 'Fixed.',
      final: true
    })
    expect(history.items[3].event).toMatchObject({
      type: 'tool_result',
      id: 'c',
      output: 'ok',
      error: false
    })
    expect(JSON.stringify(history)).not.toMatch(/private context|hidden reasoning/)
    for (const { event } of history.items)
      expect(SessionEventSchema.safeParse(event).success).toBe(true)
    expect(streams).toEqual([])
    expect(connect).not.toHaveBeenCalled()
    await manager.kill('tab')
  })

  it('freezes history at its first read so later turns cannot appear both in history and the live stream', async () => {
    const { manager, file } = await setup([
      message('UserMessage', 'u', 'Earlier'),
      message('AgentMessage', 'a', 'Earlier answer')
    ])
    const first = manager.history('tab')
    appendFileSync(file, message('AgentMessage', 'new', 'New live answer') + '\n')
    expect(manager.history('tab').items.map(({ event }) => event)).toEqual([
      { type: 'user_message', text: 'Earlier' },
      { type: 'assistant_text', delta: 'Earlier answer', final: true }
    ])
    expect(manager.history('tab')).toEqual(first)
    await manager.kill('tab')
  })

  it('reads nothing of the rollout at spawn: a restore of many chats replays none of them (PRDCT-3527)', async () => {
    const { manager, file } = await setup([message('UserMessage', 'u', 'Earlier')])
    // Written after the spawn and before any read: a spawn that replayed the
    // file would not see it.
    appendFileSync(file, message('AgentMessage', 'a', 'Written after the spawn') + '\n')
    expect(manager.history('tab').items.map(({ event }) => event)).toEqual([
      { type: 'user_message', text: 'Earlier' },
      { type: 'assistant_text', delta: 'Written after the spawn', final: true }
    ])
    await manager.kill('tab')
  })

  it('snapshots the past before the process starts, even when nothing read it yet', async () => {
    const { manager, adapter, file } = await setup([message('UserMessage', 'u', 'Earlier')])
    // The view's readiness starts the process (the stub refuses to connect);
    // the snapshot must already be taken by then.
    adapter.ready({ id: 'tab' })
    appendFileSync(file, message('AgentMessage', 'a', 'Written by the process') + '\n')
    expect(manager.history('tab').items.map(({ event }) => event)).toEqual([
      { type: 'user_message', text: 'Earlier' }
    ])
    await manager.kill('tab')
  })

  it('pages older turns without splitting tool calls from their results', async () => {
    const { manager } = await setup([
      message('UserMessage', 'u1', 'First'),
      message('AgentMessage', 'a1', 'First answer'),
      message('UserMessage', 'u2', 'Second'),
      completed({
        type: 'CommandExecution',
        id: 'c',
        command: ['false'],
        exit_code: 1,
        aggregated_output: 'failed'
      }),
      message('AgentMessage', 'a2', 'Second answer')
    ])
    const newest = manager.history('tab', undefined, 2)
    expect(newest.before).toBe(2)
    expect(newest.items.map(({ event }) => event.type)).toEqual([
      'user_message',
      'tool_call',
      'tool_result',
      'assistant_text'
    ])
    expect(newest.items[2].event).toMatchObject({ error: true })
    expect(manager.history('tab', newest.before!, 2).items).toHaveLength(2)
    await manager.kill('tab')
  })

  it('does not import another conversation for fresh or missing threads', async () => {
    const fresh = await setup([message('UserMessage', 'u', 'Other chat')], '')
    expect(fresh.manager.history('tab').items).toEqual([])
    await fresh.manager.kill('tab')
    const missing = await setup([message('UserMessage', 'u', 'Other chat')], 'missing')
    expect(missing.manager.history('tab').items).toEqual([])
    await missing.manager.kill('tab')
  })
})

describe('an ended Codex chat keeps its past until its tab closes (PRDCT-3526)', () => {
  it('answers its past after the app-server ended, and forgets it on the kill', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clave-codex-ended-'))
    roots.push(root)
    const tokens = createAgentTokenStore(join(root, 'mcp'))
    tokens.announce('http://127.0.0.1:12345/mcp')
    installTerminalPorts({ mcpConfig: tokens.mcpConfig })
    onTestFinished(() => resetTerminalPorts())
    const sessions = join(root, 'sessions', '2026', '10', '12')
    mkdirSync(sessions, { recursive: true })
    writeFileSync(
      join(sessions, 'rollout-2026-10-12T10-10-24-saved.jsonl'),
      [
        line('event_msg', { type: 'task_started', turn_id: 'turn' }),
        message('UserMessage', 'u', 'Before the end'),
        message('AgentMessage', 'a', 'Kept')
      ].join('\n') + '\n'
    )
    let callbacks!: CodexCallbacksOf
    const connect = vi.fn((_cwd: string, cb: CodexCallbacksOf) => {
      callbacks = cb
      return {
        request: vi.fn(async () => ({ thread: { id: 'saved' }, model: 'model' })),
        notify: vi.fn(),
        respond: vi.fn(),
        reject: vi.fn(),
        close: vi.fn(async () => callbacks.exit(0))
      }
    })
    const adapter = new CodexAdapter(connect as never)
    adapter.configure(
      'tab',
      { id: 'codex', name: 'Codex', family: 'codex', command: ['codex'], additionalArgs: [] },
      { CODEX_HOME: root }
    )
    const manager = new SessionManager()
    manager.registerAdapter(adapter)
    await manager.create({
      id: 'tab',
      provider: 'codex',
      adapterId: adapter.id,
      transport: 'events',
      cwd: root,
      title: 'Saved chat',
      windowKey: 'window',
      state: 'idle',
      createdAt: 1,
      options: { resume: 'saved' }
    })
    const texts = (): string[] =>
      manager
        .history('tab')
        .items.flatMap(({ event }) =>
          event.type === 'user_message'
            ? [event.text]
            : event.type === 'assistant_text'
              ? [event.delta]
              : []
        )
    expect(texts()).toEqual(['Before the end', 'Kept'])
    // The app-server starts on the first message, then dies on its own.
    adapter.write({ id: 'tab' }, { type: 'user_message', text: 'hello' })
    await new Promise((resolve) => setImmediate(resolve))
    expect(connect).toHaveBeenCalled()
    callbacks.exit(1)
    await new Promise((resolve) => setImmediate(resolve))
    expect(manager.get('tab')?.state).toBe('ended')
    expect(texts()).toEqual(['Before the end', 'Kept'])
    // The tab closed for real: the past goes with it.
    await manager.kill('tab')
    expect(() => adapter.history({ id: 'tab' })).toThrow()
  })
})
type CodexCallbacksOf = import('./codex-app-server').CodexCallbacks
