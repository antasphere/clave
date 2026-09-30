import { readFileSync } from 'node:fs'
import { describe, it, expect, vi } from 'vitest'
import { CodexAdapter, CodexTranslator } from './codex-adapter'
import { SessionEventSchema, type SessionEvent } from '../../../shared/session-model'
import type { SpawnSpec } from '../adapter'
import type { LaunchProfile } from '../../../shared/agent-launch'
import type { CodexCallbacks, CodexConnection } from './codex-app-server'
const rows = readFileSync(
  new URL('../fixtures/codex-app-server/live.ndjson', import.meta.url),
  'utf8'
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
const spec: SpawnSpec = {
  id: 'test',
  provider: 'codex',
  transport: 'events',
  cwd: '/tmp',
  windowKey: 'w',
  state: 'idle',
  adapterId: 'codex-chat',
  title: 'Test',
  createdAt: 1
}
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('Codex translation', () => {
  it('translates every recorded notification in order without silently dropping any', () => {
    const events: SessionEvent[] = []
    const translator = new CodexTranslator((e) => events.push(SessionEventSchema.parse(e)))
    for (const { direction, frame } of rows) {
      if (direction !== 'server' || !frame.method) continue
      const before = events.length
      if (frame.id !== undefined) translator.request(frame)
      else translator.notification(frame)
      expect(events.length, frame.method).toBeGreaterThan(before)
      const added = events.slice(before)
      if (frame.method === 'item/agentMessage/delta')
        expect(added).toEqual([{ type: 'assistant_text', delta: frame.params.delta, final: false }])
      if (frame.method === 'item/completed' && frame.params.item.type === 'agentMessage')
        expect(added).toEqual([{ type: 'assistant_text', delta: '', final: true }])
      if (frame.method === 'turn/completed') {
        expect(added.at(-1)).toEqual({ type: 'state_change', state: 'done' })
        // The recorded interrupted turn is the reader's stop, not a failure.
        expect(added.some((e) => e.type === 'turn_interrupted')).toBe(
          frame.params.turn.status === 'interrupted'
        )
        expect(added.some((e) => e.type === 'error')).toBe(false)
      }
      if (frame.method === 'turn/started')
        expect(added).toEqual([{ type: 'state_change', state: 'working' }])
      if (frame.method === 'thread/tokenUsage/updated')
        expect(added).toEqual([
          {
            type: 'context_usage',
            used:
              frame.params.tokenUsage.last.totalTokens -
              frame.params.tokenUsage.last.reasoningOutputTokens,
            window: frame.params.tokenUsage.modelContextWindow
          }
        ])
    }
    // The recording's last call held 34,859 tokens of a 258,400-token window.
    expect(events.findLast((e) => e.type === 'context_usage')).toEqual({
      type: 'context_usage',
      used: 34859,
      window: 258400
    })
    const text = events
      .filter((e) => e.type === 'assistant_text')
      .map((e) => e.delta)
      .join('')
    expect(text).toContain('Clave protocol ready.')
    expect(events.filter((e) => e.type === 'assistant_text' && e.final)).toHaveLength(3)
    const call = events.find((e) => e.type === 'tool_call')!
    const result = events.find((e) => e.type === 'tool_result')!
    expect('id' in call && 'id' in result && call.id === result.id).toBe(true)
    expect(events.filter((e) => e.type === 'provider_event').length).toBeGreaterThan(0)
  })
  it('preserves offered structured approval decisions and rejects forged/repeated answers', () => {
    const events: SessionEvent[] = []
    const translator = new CodexTranslator((e) => events.push(e))
    translator.turnId = 'turn-approval'
    const approval = rows.find(
      (r) => r.frame.method === 'item/commandExecution/requestApproval'
    ).frame
    translator.request(approval)
    const event = events[0]
    expect(event.type).toBe('permission_request')
    if (event.type !== 'permission_request') throw new Error('missing approval')
    expect(event.options.map((o) => o.id)).toEqual(
      approval.params.availableDecisions.map((d: unknown) =>
        typeof d === 'string' ? d : JSON.stringify(d)
      )
    )
    const connection = { respond: vi.fn() } as unknown as CodexConnection
    expect(() => translator.answer(event.id, 'forged', connection)).toThrow()
    translator.answer(event.id, event.options[1].id, connection)
    expect(connection.respond).toHaveBeenCalledWith(0, {
      decision: approval.params.availableDecisions[1]
    })
    expect(events.at(-1)).toEqual({ type: 'state_change', state: 'working' })
    expect(() => translator.answer(event.id, 'accept', connection)).toThrow()
  })
  it('handles completed-only text and schema-derived file changes/MCP results', () => {
    const events: SessionEvent[] = []
    const translator = new CodexTranslator((e) => events.push(e))
    translator.notification({
      method: 'item/completed',
      params: { item: { type: 'agentMessage', id: 'msg', text: 'whole' } }
    })
    expect(events.shift()).toEqual({ type: 'assistant_text', delta: 'whole', final: true })
    for (const item of [
      {
        type: 'fileChange',
        id: 'patch',
        changes: [{ path: 'a', diff: '+ok', kind: { type: 'add' } }]
      },
      {
        type: 'mcpToolCall',
        id: 'mcp',
        server: 's',
        tool: 't',
        arguments: { a: 1 },
        result: { content: [{ type: 'text', text: 'ok' }] }
      }
    ]) {
      translator.notification({ method: 'item/started', params: { item } })
      translator.notification({ method: 'item/completed', params: { item } })
      expect(events.shift()).toEqual({
        type: 'tool_call',
        id: item.id,
        name: item.type === 'fileChange' ? 'fileChange' : 's/t',
        input: item
      })
      expect(events.shift()).toEqual({
        type: 'tool_result',
        id: item.id,
        output: item.changes ?? item.result
      })
    }
  })
  it('reads the context off the last call, never the thread total, and forwards a report it cannot read', () => {
    const events: SessionEvent[] = []
    const translator = new CodexTranslator((e) => events.push(SessionEventSchema.parse(e)))
    const usage = (tokenUsage: unknown): void =>
      translator.notification({
        method: 'thread/tokenUsage/updated',
        params: { threadId: 't', turnId: 'u', tokenUsage }
      })
    usage({
      total: { totalTokens: 90000 },
      last: { totalTokens: 30000, reasoningOutputTokens: 2000 },
      modelContextWindow: 258400
    })
    usage({ total: { totalTokens: 95000 }, last: { totalTokens: 31000 }, modelContextWindow: null })
    usage({ total: { totalTokens: 95000 }, last: {}, modelContextWindow: 258400 })
    usage({ total: { totalTokens: 95000 }, last: { totalTokens: 0 }, modelContextWindow: 258400 })
    expect(events.map((e) => e.type)).toEqual([
      'context_usage',
      'context_usage',
      'provider_event',
      'provider_event'
    ])
    // The call's reasoning is not carried into the next one.
    expect(events[0]).toEqual({ type: 'context_usage', used: 28000, window: 258400 })
    // No window named: the meter keeps the one it already knows.
    expect(events[1]).toEqual({ type: 'context_usage', used: 31000, window: null })
  })
  it('forwards unknowns and reports errors instead of silently swallowing requests', () => {
    const events: SessionEvent[] = []
    const translator = new CodexTranslator((e) => events.push(e))
    const frame = { method: 'future/event', params: { a: true } }
    translator.notification(frame)
    expect(events[0]).toEqual({ type: 'provider_event', provider: 'codex', payload: frame })
    expect(translator.request({ id: 8, method: 'unknown' })).toBe(false)
    translator.notification({
      method: 'error',
      params: { error: { message: 'failed' }, willRetry: false }
    })
    expect(events.at(-1)).toEqual({ type: 'error', message: 'failed', fatal: true })
  })
})

function fake(): {
  adapter: CodexAdapter
  connection: CodexConnection
  connect: ReturnType<typeof vi.fn>
  callback(): CodexCallbacks
} {
  let callbacks!: CodexCallbacks
  const connection: CodexConnection = {
    request: vi.fn(async (method: string) => {
      if (method === 'thread/start' || method === 'thread/resume')
        return { thread: { id: 'thread' }, model: 'model' }
      if (method === 'turn/start') {
        callbacks.notification({ method: 'turn/started', params: { turn: { id: 'turn' } } })
        return { turn: { id: 'turn', status: 'inProgress' } }
      }
      return {}
    }),
    notify: vi.fn(),
    respond: vi.fn(),
    reject: vi.fn(),
    close: vi.fn(async () => callbacks.exit(0))
  }
  const connect = vi.fn((_cwd: string, cb: CodexCallbacks) => {
    callbacks = cb
    return connection
  })
  return { adapter: new CodexAdapter(connect), connection, connect, callback: () => callbacks }
}
describe('Codex adapter lifecycle', () => {
  it('sends attached images as image input items and streams the message without them', async () => {
    const { adapter, connection } = fake()
    expect(adapter.images).toBe(true)
    const handle = await adapter.spawn(spec)
    const events: unknown[] = []
    adapter.on(handle, 'stream', (e) => events.push(e))
    const shot = {
      id: 'shot',
      path: '/pictures/shot.png',
      name: 'shot.png',
      mimeType: 'image/png',
      size: 3,
      delivery: 'image' as const
    }
    adapter.write(handle, {
      type: 'user_message',
      text: '',
      attachments: [shot],
      prepared: { text: '', images: [{ name: 'shot.png', mimeType: 'image/png', data: 'AQID' }] }
    })
    await tick()
    expect(connection.request).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread',
      input: [{ type: 'image', url: 'data:image/png;base64,AQID' }]
    })
    expect(events[0]).toEqual({
      kind: 'event',
      event: { type: 'user_message', text: '', attachments: [shot] }
    })
    expect(JSON.stringify(events)).not.toContain('AQID')
    await adapter.kill(handle)
  })
  it('keeps each configured launch profile through deferred startup', async () => {
    const { adapter, connect } = fake()
    const profile = {
      id: 'work',
      name: 'Work',
      family: 'codex' as const,
      command: ['wrapper', 'codex'],
      additionalArgs: ['--profile', 'work']
    }
    adapter.configure(spec.id, profile)
    const handle = await adapter.spawn(spec)
    profile.command[0] = 'changed-after-launch'
    expect(connect).not.toHaveBeenCalled()
    adapter.write(handle, { type: 'user_message', text: 'hello' })
    await tick()
    expect(connect).toHaveBeenCalledWith(
      spec.cwd,
      expect.any(Object),
      expect.objectContaining({
        command: ['wrapper', 'codex'],
        additionalArgs: ['--profile', 'work']
      }),
      undefined
    )
    await adapter.kill(handle)
    const next = await adapter.spawn(spec)
    adapter.write(next, { type: 'user_message', text: 'hello' })
    await tick()
    expect(connect).toHaveBeenLastCalledWith(spec.cwd, expect.any(Object), undefined, undefined)
    await adapter.kill(next)
  })

  it('defers startup for subscribers, sends model/resume safely, interrupts, and exits in order', async () => {
    const { adapter, connection, connect } = fake()
    const handle = await adapter.spawn({
      ...spec,
      options: { resume: 'saved', model: 'model; no shell', permissionMode: 'on-request' }
    })
    expect(connect).not.toHaveBeenCalled()
    const events: unknown[] = []
    adapter.on(handle, 'stream', (e) => events.push(e))
    adapter.on(handle, 'exit', (e) => events.push(e))
    expect(() => adapter.write(handle, new Uint8Array())).toThrow('structured')
    adapter.write(handle, { type: 'user_message', text: 'hello' })
    adapter.write(handle, { type: 'interrupt' })
    await tick()
    expect(connection.request).toHaveBeenCalledWith('thread/resume', {
      threadId: 'saved',
      cwd: '/tmp',
      model: 'model; no shell',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user'
    })
    expect(connection.request).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread',
      input: [{ type: 'text', text: 'hello', text_elements: [] }]
    })
    expect(connection.request).toHaveBeenCalledWith('turn/interrupt', {
      threadId: 'thread',
      turnId: 'turn'
    })
    expect(events[0]).toEqual({ kind: 'event', event: { type: 'user_message', text: 'hello' } })
    await adapter.kill(handle)
    expect(events.slice(-2)).toEqual([
      { kind: 'event', event: { type: 'state_change', state: 'ended' } },
      0
    ])
  })
  it('sends the configured initial prompt once, at ready, and never on a later spawn', async () => {
    const { adapter, connection, connect } = fake()
    const profile = {
      id: 'default',
      name: 'Default',
      family: 'codex' as const,
      command: ['codex'],
      additionalArgs: []
    }
    adapter.configure(spec.id, profile, undefined, 'initial prompt')
    const handle = await adapter.spawn(spec)
    const events: unknown[] = []
    adapter.on(handle, 'stream', (e) => events.push(e))
    expect(connect).not.toHaveBeenCalled()
    adapter.ready(handle)
    adapter.ready(handle)
    // The prompt is the reader's first message the moment the view is looking.
    expect(events).toEqual([
      { kind: 'event', event: { type: 'user_message', text: 'initial prompt' } }
    ])
    await tick()
    const turns = (connection.request as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([method]) => method === 'turn/start'
    )
    expect(turns).toEqual([
      [
        'turn/start',
        { threadId: 'thread', input: [{ type: 'text', text: 'initial prompt', text_elements: [] }] }
      ]
    ])
    await adapter.kill(handle)
    // The one-shot went with the context that carried it: a fresh spawn of
    // the same id, configured without one, sends nothing on ready.
    adapter.configure(spec.id, profile)
    const next = await adapter.spawn(spec)
    const later: unknown[] = []
    adapter.on(next, 'stream', (e) => later.push(e))
    adapter.ready(next)
    await tick()
    expect(
      later.filter((e) => (e as { event: { type: string } }).event.type === 'user_message')
    ).toEqual([])
    expect(
      (connection.request as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([method]) => method === 'turn/start'
      )
    ).toHaveLength(1)
    await adapter.kill(next)
  })
  it('sends the initial prompt at ready even when the model picker started the thread first', async () => {
    const { adapter, connection } = fake()
    adapter.configure(
      spec.id,
      { id: 'd', name: 'D', family: 'codex' as const, command: ['codex'], additionalArgs: [] },
      undefined,
      'prompt'
    )
    const handle = await adapter.spawn(spec)
    const events: unknown[] = []
    adapter.on(handle, 'stream', (e) => events.push(e))
    await adapter.models(handle)
    adapter.ready(handle)
    await tick()
    expect(events).toContainEqual({
      kind: 'event',
      event: { type: 'user_message', text: 'prompt' }
    })
    expect(connection.request).toHaveBeenCalledWith('turn/start', {
      threadId: 'thread',
      input: [{ type: 'text', text: 'prompt', text_elements: [] }]
    })
    await adapter.kill(handle)
  })
  it('does not spawn after a prepared session is killed', async () => {
    const { adapter, connect } = fake()
    const handle = await adapter.spawn(spec)
    await adapter.kill(handle)
    expect(connect).not.toHaveBeenCalled()
    expect(() => adapter.write(handle, { type: 'user_message', text: 'hello' })).toThrow('Unknown')
  })
  it('routes permission replies and rejects concurrent turns and unsupported requests', async () => {
    const { adapter, connection, callback } = fake()
    const handle = await adapter.spawn(spec)
    adapter.write(handle, { type: 'user_message', text: 'hello' })
    await tick()
    expect(() => adapter.write(handle, { type: 'user_message', text: 'second' })).toThrow(
      'active turn'
    )
    callback().request({
      id: 'approval',
      method: 'item/fileChange/requestApproval',
      params: { turnId: 'turn' }
    })
    adapter.write(handle, { type: 'permission_response', id: '"approval"', optionId: 'decline' })
    expect(connection.respond).toHaveBeenCalledWith('approval', { decision: 'decline' })
    callback().request({ id: 9, method: 'future' })
    expect(connection.reject).toHaveBeenCalledWith(9, 'Unsupported request: future')
    await adapter.kill(handle)
  })
})

describe('Codex races and failure boundaries', () => {
  it('does not resurrect a turn completed before the turn/start reply', async () => {
    let cb!: CodexCallbacks
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/start') return { thread: { id: 'thread' } }
      if (method === 'turn/start') {
        cb.notification({ method: 'turn/started', params: { turn: { id: 'fast' } } })
        cb.notification({
          method: 'turn/completed',
          params: { turn: { id: 'fast', status: 'completed' } }
        })
        return { turn: { id: 'fast', status: 'inProgress' } }
      }
      return {}
    })
    const adapter = new CodexAdapter((_cwd, callbacks) => {
      cb = callbacks
      return {
        request,
        notify: vi.fn(),
        respond: vi.fn(),
        reject: vi.fn(),
        close: async () => cb.exit(0)
      }
    })
    const handle = await adapter.spawn(spec)
    adapter.write(handle, { type: 'user_message', text: 'one' })
    await tick()
    expect(() => adapter.write(handle, { type: 'user_message', text: 'two' })).not.toThrow()
    await tick()
    await adapter.kill(handle)
  })
  it('fails unsupported permission modes without spawning and emits fatal error before exit', async () => {
    const { adapter, connect } = fake()
    const handle = await adapter.spawn({ ...spec, options: { permissionMode: 'untrusted' } })
    const events: unknown[] = []
    adapter.on(handle, 'stream', (stream) => events.push(stream))
    adapter.on(handle, 'exit', (code) => events.push(code))
    adapter.write(handle, { type: 'user_message', text: 'hello' })
    await tick()
    expect(connect).not.toHaveBeenCalled()
    expect(events.slice(-3)).toEqual([
      {
        kind: 'event',
        event: {
          type: 'error',
          message: 'Unsupported Codex permissionMode: untrusted',
          fatal: true
        }
      },
      { kind: 'event', event: { type: 'state_change', state: 'ended' } },
      1
    ])
    await adapter.kill(handle)
  })
  it('expires approvals on external resolution and preserves blocked with another pending request', () => {
    const events: SessionEvent[] = []
    const translator = new CodexTranslator((e) => events.push(e))
    translator.turnId = 'turn'
    translator.request({
      id: 1,
      method: 'item/fileChange/requestApproval',
      params: { turnId: 'turn' }
    })
    translator.request({
      id: '1',
      method: 'item/fileChange/requestApproval',
      params: { turnId: 'turn' }
    })
    const connection = { respond: vi.fn() } as unknown as CodexConnection
    translator.answer('1', 'cancel', connection)
    expect(connection.respond).toHaveBeenCalledExactlyOnceWith(1, { decision: 'cancel' })
    expect(events.at(-1)).toEqual({ type: 'state_change', state: 'blocked' })
    translator.notification({ method: 'serverRequest/resolved', params: { requestId: '1' } })
    expect(() => translator.answer('"1"', 'accept', connection)).toThrow()
    expect(events.at(-1)).toEqual({ type: 'state_change', state: 'working' })
  })
  it('offers schema-valid scoped permission grants without granting null fields', () => {
    const events: SessionEvent[] = []
    const translator = new CodexTranslator((e) => events.push(e))
    translator.request({
      id: 3,
      method: 'item/permissions/requestApproval',
      params: { permissions: { network: { enabled: true }, fileSystem: null } }
    })
    const event = events[0]
    if (event.type !== 'permission_request') throw new Error('missing approval')
    const connection = { respond: vi.fn() } as unknown as CodexConnection
    translator.answer(event.id, event.options[1].id, connection)
    expect(connection.respond).toHaveBeenCalledWith(3, {
      permissions: { network: { enabled: true } },
      scope: 'turn'
    })
  })
})

it('keeps another thread notification visible without changing this session interrupt target', () => {
  const events: SessionEvent[] = []
  const translator = new CodexTranslator((e) => events.push(e))
  translator.metadata({ thread: { id: 'parent' }, model: 'model' })
  translator.notification({
    method: 'turn/started',
    params: { threadId: 'parent', turn: { id: 'parent-turn' } }
  })
  const other = {
    method: 'turn/started',
    params: { threadId: 'child', turn: { id: 'child-turn' } }
  }
  translator.notification(other)
  expect(translator.threadId).toBe('parent')
  expect(translator.turnId).toBe('parent-turn')
  expect(events.at(-1)).toEqual({ type: 'provider_event', provider: 'codex', payload: other })
})

it.each(['execCommandApproval', 'applyPatchApproval'])(
  'answers legacy %s with its generated decision values',
  (method) => {
    const events: SessionEvent[] = []
    const translator = new CodexTranslator((e) => events.push(e))
    translator.request({ id: 4, method })
    const event = events[0]
    if (event.type !== 'permission_request') throw new Error('missing approval')
    const connection = { respond: vi.fn() } as unknown as CodexConnection
    translator.answer(event.id, 'abort', connection)
    expect(connection.respond).toHaveBeenCalledWith(4, { decision: 'abort' })
  }
)

it('reports an interrupted turn as interrupted even when Codex attaches an error to it', () => {
  const events: SessionEvent[] = []
  const translator = new CodexTranslator((e) => events.push(e))
  translator.notification({
    method: 'turn/completed',
    params: { turn: { id: 't', status: 'interrupted', error: { message: 'Turn interrupted' } } }
  })
  expect(events).toEqual([{ type: 'turn_interrupted' }, { type: 'state_change', state: 'done' }])
})
it('expires legacy approvals with the active turn even without a turnId field', () => {
  const translator = new CodexTranslator(() => {})
  translator.turnId = 'active'
  translator.request({ id: 1, method: 'execCommandApproval', params: {} })
  translator.notification({ method: 'turn/completed', params: { turn: { id: 'active' } } })
  const connection = { respond: vi.fn() } as unknown as CodexConnection
  expect(() => translator.answer('1', 'approved', connection)).toThrow('expired')
  expect(connection.respond).not.toHaveBeenCalled()
})

it('intentional close during initialization does not publish a fatal error or accept new input', async () => {
  let cb!: CodexCallbacks
  let rejectInit!: (error: Error) => void
  let finishClose!: () => void
  const closed = new Promise<void>((resolve) => {
    finishClose = resolve
  })
  const adapter = new CodexAdapter((_cwd, callbacks) => {
    cb = callbacks
    return {
      request: () =>
        new Promise((_resolve, reject) => {
          rejectInit = reject
        }),
      notify: vi.fn(),
      respond: vi.fn(),
      reject: vi.fn(),
      close: () => {
        rejectInit(new Error('Codex app-server closed'))
        return closed
      }
    }
  })
  const handle = await adapter.spawn(spec)
  const events: SessionEvent[] = []
  adapter.on(handle, 'stream', (stream) => {
    if (stream.kind === 'event') events.push(stream.event)
  })
  adapter.write(handle, { type: 'user_message', text: 'hello' })
  const closing = adapter.kill(handle)
  await tick()
  expect(() => adapter.write(handle, { type: 'user_message', text: 'too late' })).toThrow('ended')
  expect(events.filter((e) => e.type === 'error')).toEqual([])
  cb.exit(0)
  finishClose()
  await closing
  expect(events.at(-1)).toEqual({ type: 'state_change', state: 'ended' })
})

it('attaches stderr to a fatal exit event and releases the spontaneously exited handle', async () => {
  const { adapter, callback } = fake()
  const handle = await adapter.spawn(spec)
  const events: SessionEvent[] = []
  adapter.on(handle, 'stream', (stream) => {
    if (stream.kind === 'event') events.push(stream.event)
  })
  adapter.write(handle, { type: 'user_message', text: 'hello' })
  await tick()
  callback().exit(1, 'Error: invalid Codex configuration\n')
  expect(events.slice(-2)).toEqual([
    {
      type: 'error',
      message: 'Codex app-server exited with code 1: Error: invalid Codex configuration',
      fatal: true
    },
    { type: 'state_change', state: 'ended' }
  ])
  await expect(adapter.attach(handle.id)).rejects.toThrow('Unknown')
  // Reusing the id also proves the adapter released its retained HandleState.
  const replacement = await adapter.spawn(spec)
  await adapter.kill(replacement)
})

it.each(['notification-first', 'reply-first'])(
  'emits metadata once with the authoritative model (%s)',
  (order) => {
    const events: SessionEvent[] = []
    const translator = new CodexTranslator((e) => events.push(e))
    const notification = (): void =>
      translator.notification({ method: 'thread/started', params: { thread: { id: 'thread' } } })
    const reply = (): void => translator.metadata({ thread: { id: 'thread' }, model: 'model' })
    if (order === 'notification-first') {
      notification()
      reply()
    } else {
      reply()
      notification()
    }
    expect(events.filter((e) => e.type === 'session_meta')).toEqual([
      { type: 'session_meta', model: 'model', providerSessionId: 'thread' }
    ])
    expect(events.filter((e) => e.type === 'provider_event')).toHaveLength(1)
  }
)

it('labels permission grants as choices while retaining real JSON response ids', () => {
  const events: SessionEvent[] = []
  new CodexTranslator((e) => events.push(e)).request({
    id: 1,
    method: 'item/permissions/requestApproval',
    params: { permissions: { network: { enabled: true } } }
  })
  const event = events[0]
  if (event.type !== 'permission_request') throw new Error('missing approval')
  expect(event.options.map((o) => o.label)).toEqual([
    'Deny extra permissions',
    'Allow for this turn'
  ])
  expect(event.options.map((o) => JSON.parse(o.id))).toEqual([
    { permissions: {}, scope: 'turn' },
    { permissions: { network: { enabled: true } }, scope: 'turn' }
  ])
})

it.each(['on-request', 'never'])(
  'never overrides the configured sandbox in %s mode',
  async (permissionMode) => {
    const { adapter, connection } = fake()
    const handle = await adapter.spawn({ ...spec, options: { permissionMode } })
    adapter.write(handle, { type: 'user_message', text: 'hello' })
    await tick()
    const call = vi
      .mocked(connection.request)
      .mock.calls.find(([method]) => method === 'thread/start')
    expect(call).toBeDefined()
    expect(call![1]).not.toHaveProperty('sandbox')
    expect(JSON.stringify(call![1])).not.toContain('danger-full-access')
    await adapter.kill(handle)
  }
)

describe('Codex tool failure', () => {
  const resultFor = (
    item: Record<string, unknown>
  ): Extract<SessionEvent, { type: 'tool_result' }> => {
    const events: SessionEvent[] = []
    const translator = new CodexTranslator((e) => events.push(e))
    translator.notification({ method: 'item/started', params: { item } })
    translator.notification({ method: 'item/completed', params: { item } })
    const result = events.find((e) => e.type === 'tool_result')
    if (result?.type !== 'tool_result') throw new Error('no tool_result emitted')
    return result
  }
  it('reads a command failure off its exit status, never off its output', () => {
    const failing = resultFor({
      id: 'c1',
      type: 'commandExecution',
      exitCode: 1,
      aggregatedOutput: 'nope'
    })
    expect(failing).toMatchObject({ type: 'tool_result', id: 'c1', error: true })
    const passing = resultFor({
      id: 'c2',
      type: 'commandExecution',
      exitCode: 0,
      // Reads like a failure and is not one: exit 0 is the only word that counts.
      aggregatedOutput: 'Error: 3 warnings emitted'
    })
    expect(passing).toMatchObject({ error: false })
  })
  it('says nothing when the server reported no exit status and no error', () => {
    expect(resultFor({ id: 'c3', type: 'commandExecution', aggregatedOutput: 'x' }).error).toBe(
      undefined
    )
  })
  it('keeps a command failure that arrives as an error with no exit status', () => {
    // A command that never ran has no exit code; reading only the status
    // dropped the failure AND its reason, and the row read as a clean success.
    const spawnFailed = resultFor({ id: 'c5', type: 'commandExecution', error: 'spawn failed' })
    expect(spawnFailed).toMatchObject({ error: true, output: 'spawn failed' })
  })
  it('still prefers the aggregated output when there is one', () => {
    const both = resultFor({
      id: 'c6',
      type: 'commandExecution',
      exitCode: 0,
      aggregatedOutput: 'all good',
      error: ''
    })
    expect(both).toMatchObject({ error: false, output: 'all good' })
  })
  it('flags a tool call that carried an error, and leaves a clean one alone', () => {
    expect(resultFor({ id: 'm1', type: 'mcpToolCall', error: 'upstream refused' })).toMatchObject({
      error: true
    })
    expect(resultFor({ id: 'm2', type: 'mcpToolCall', result: 'ok' }).error).toBe(undefined)
  })
  it('carries the flag THROUGH the contract, not merely past it', () => {
    const event = resultFor({
      id: 'c4',
      type: 'commandExecution',
      exitCode: 2,
      aggregatedOutput: ''
    })
    // zod strips an unknown key silently, so asserting "did not throw" would
    // pass just as well with `error` removed from the schema altogether.
    expect(SessionEventSchema.parse(event)).toMatchObject({ type: 'tool_result', error: true })
  })
})

describe('Codex chat permissions', () => {
  const profile = (...flags: string[]): LaunchProfile => ({
    id: 'p',
    name: 'P',
    family: 'codex',
    command: ['codex', ...flags],
    additionalArgs: []
  })
  const threadParams = async (
    options: Record<string, unknown>,
    launchProfile?: LaunchProfile
  ): Promise<unknown> => {
    const { adapter, connection } = fake()
    if (launchProfile) adapter.configure(spec.id, launchProfile)
    const handle = await adapter.spawn({ ...spec, options })
    adapter.write(handle, { type: 'user_message', text: 'hello' })
    await tick()
    const call = vi
      .mocked(connection.request)
      .mock.calls.find(([method]) => method === 'thread/start' || method === 'thread/resume')
    await adapter.kill(handle)
    return call?.[1]
  }
  it('starts a yolo profile thread with full access and no approvals', async () => {
    expect(await threadParams({}, profile('--yolo'))).toMatchObject({
      sandbox: 'danger-full-access',
      approvalPolicy: 'never',
      approvalsReviewer: 'user'
    })
  })
  it('resumes a thread under the profile it was launched on', async () => {
    expect(await threadParams({ resume: 'saved' }, profile('-s', 'workspace-write'))).toMatchObject(
      { threadId: 'saved', sandbox: 'workspace-write', approvalPolicy: 'on-request' }
    )
  })
  it("lets the launch's own choice win over the profile's flags", async () => {
    expect(
      await threadParams(
        { permissionMode: 'never', sandbox: 'danger-full-access' },
        profile('-s', 'read-only', '-a', 'untrusted')
      )
    ).toMatchObject({ sandbox: 'danger-full-access', approvalPolicy: 'never' })
  })
  it('refuses a sandbox Codex does not know', async () => {
    const { adapter } = fake()
    const handle = await adapter.spawn({ ...spec, options: { sandbox: 'everything' } })
    const events: SessionEvent[] = []
    adapter.on(handle, 'stream', (s) => s.kind === 'event' && events.push(s.event))
    adapter.write(handle, { type: 'user_message', text: 'hello' })
    await tick()
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'error', message: 'Unsupported Codex sandbox: everything' })
    )
  })
})

describe('Codex reasoning effort', () => {
  const LISTING = [
    {
      model: 'gpt-a',
      displayName: 'GPT A',
      description: 'Fast',
      supportedReasoningEfforts: [
        { reasoningEffort: 'low', description: 'Quick' },
        { reasoningEffort: 'high', description: '' },
        { reasoningEffort: 'ultra' },
        { reasoningEffort: '--x', description: 'never offered' }
      ],
      defaultReasoningEffort: 'low'
    },
    {
      model: 'gpt-b',
      displayName: 'GPT B',
      supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Balanced' }],
      defaultReasoningEffort: 'medium'
    },
    { id: 'gpt-c', displayName: 'GPT C' },
    { model: 'gpt-hidden', hidden: true }
  ]
  /** The lifecycle fake, with a model list and a thread reply of the case's choosing. */
  function effortFake(
    thread: Record<string, unknown> = {},
    list: () => Promise<unknown> = async () => ({ data: LISTING })
  ): {
    adapter: CodexAdapter
    turns: () => Record<string, unknown>[]
    lists: () => number
    complete: () => void
  } {
    let callbacks!: CodexCallbacks
    const request = vi.fn(async (method: string) => {
      if (method === 'thread/start' || method === 'thread/resume')
        return { thread: { id: 'thread' }, model: 'gpt-a', ...thread }
      if (method === 'model/list') return list()
      if (method === 'turn/start') {
        callbacks.notification({ method: 'turn/started', params: { turn: { id: 'turn' } } })
        return { turn: { id: 'turn', status: 'inProgress' } }
      }
      return {}
    })
    const connection: CodexConnection = {
      request,
      notify: vi.fn(),
      respond: vi.fn(),
      reject: vi.fn(),
      close: vi.fn(async () => callbacks.exit(0))
    }
    const adapter = new CodexAdapter((_cwd: string, cb: CodexCallbacks) => {
      callbacks = cb
      return connection
    })
    return {
      adapter,
      turns: () =>
        request.mock.calls
          .filter(([method]) => method === 'turn/start')
          .map((call) => (call as unknown[])[1] as Record<string, unknown>),
      lists: () => request.mock.calls.filter(([method]) => method === 'model/list').length,
      complete: () =>
        callbacks.notification({
          method: 'turn/completed',
          params: { turn: { id: 'turn', status: 'completed' } }
        })
    }
  }
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 6; i++) await tick()
  }
  /** The efforts the stream announced, a repeat of the same level folded:
   *  a switch made before the thread starts is announced again once it has. */
  /** Every effort the stream announced, repeats included. */
  const announced = (seen: unknown[]): (string | null)[] =>
    seen.flatMap((s) => {
      const event = (s as { kind: string; event?: SessionEvent }).event
      return event?.type === 'effort' ? [event.effort] : []
    })
  const effortsOf = (seen: unknown[]): (string | null)[] =>
    seen
      .flatMap((s) => {
        const event = (s as { kind: string; event?: SessionEvent }).event
        return event?.type === 'effort' ? [event.effort] : []
      })
      .filter((effort, i, all) => i === 0 || all[i - 1] !== effort)

  it('lists each model with the efforts it takes, their gloss, and its default', async () => {
    const { adapter } = effortFake()
    const handle = await adapter.spawn(spec)
    await expect(adapter.models(handle)).resolves.toEqual([
      {
        id: 'gpt-a',
        label: 'GPT A',
        hint: 'Fast',
        efforts: [
          { id: 'low', label: 'Low', hint: 'Quick' },
          { id: 'high', label: 'High' },
          { id: 'ultra', label: 'Ultra' }
        ],
        defaultEffort: 'low'
      },
      {
        id: 'gpt-b',
        label: 'GPT B',
        efforts: [{ id: 'medium', label: 'Medium', hint: 'Balanced' }],
        defaultEffort: 'medium'
      },
      { id: 'gpt-c', label: 'GPT C' }
    ])
    await adapter.kill(handle)
  })

  it('announces a switch at once and carries it on the next turn its model takes it', async () => {
    const { adapter, turns, complete } = effortFake()
    const handle = await adapter.spawn(spec)
    const seen: unknown[] = []
    adapter.on(handle, 'stream', (s) => seen.push(s))
    adapter.write(handle, { type: 'set_effort', effort: 'high' })
    expect(effortsOf(seen)).toEqual(['high'])
    expect(() => adapter.write(handle, { type: 'set_effort', effort: '--x' })).toThrow()
    adapter.write(handle, { type: 'user_message', text: 'one' })
    await settle()
    expect(turns()).toEqual([
      {
        threadId: 'thread',
        input: [{ type: 'text', text: 'one', text_elements: [] }],
        effort: 'high'
      }
    ])
    // Still carried by the turn after, on the same model.
    complete()
    adapter.write(handle, { type: 'user_message', text: 'two' })
    await settle()
    expect(turns()[1]).toMatchObject({ effort: 'high' })
    expect(effortsOf(seen)).toEqual(['high'])
    await adapter.kill(handle)
  })

  it("drops a level the turn's model does not list, and says what it runs at instead", async () => {
    const { adapter, turns, complete } = effortFake()
    const handle = await adapter.spawn(spec)
    const seen: unknown[] = []
    adapter.on(handle, 'stream', (s) => seen.push(s))
    adapter.write(handle, { type: 'set_model', model: 'gpt-b' })
    adapter.write(handle, { type: 'set_effort', effort: 'ultra' })
    adapter.write(handle, { type: 'user_message', text: 'one' })
    await settle()
    expect(turns()[0]).toEqual({
      threadId: 'thread',
      input: [{ type: 'text', text: 'one', text_elements: [] }],
      model: 'gpt-b'
    })
    expect(effortsOf(seen)).toEqual(['ultra', 'medium'])
    // The choice is forgotten: back on a model that lists it, no turn carries it.
    complete()
    adapter.write(handle, { type: 'set_model', model: 'gpt-a' })
    adapter.write(handle, { type: 'user_message', text: 'two' })
    await settle()
    expect(turns()[1]).not.toHaveProperty('effort')
    // A model with no default reads as none.
    complete()
    adapter.write(handle, { type: 'set_model', model: 'gpt-c' })
    adapter.write(handle, { type: 'set_effort', effort: 'high' })
    adapter.write(handle, { type: 'user_message', text: 'three' })
    await settle()
    expect(turns()[2]).not.toHaveProperty('effort')
    expect(effortsOf(seen)).toEqual(['ultra', 'medium', 'high', null])
    await adapter.kill(handle)
  })

  it('sends no effort when the model list cannot be had, and keeps the choice for when it can', async () => {
    // The app-server forwards any level and the API then fails the whole turn
    // on one the model does not take, so an unchecked level never goes out.
    let listing: () => Promise<unknown> = async () => {
      throw new Error('model/list failed')
    }
    const { adapter, turns, lists, complete } = effortFake(
      { model: 'gpt-b', reasoningEffort: 'medium' },
      () => listing()
    )
    const handle = await adapter.spawn({ ...spec, options: { effort: 'ultra' } })
    const seen: unknown[] = []
    adapter.on(handle, 'stream', (s) => seen.push(s))
    adapter.write(handle, { type: 'user_message', text: 'one' })
    await settle()
    expect(turns()[0]).not.toHaveProperty('effort')
    // The view is told what the thread runs at: its own reply's level.
    expect(effortsOf(seen).at(-1)).toBe('medium')
    // A failed list is not asked for again at every turn, and the level the
    // thread runs at is not said again at every turn either.
    const said = announced(seen).length
    complete()
    adapter.write(handle, { type: 'user_message', text: 'two' })
    await settle()
    expect(turns()[1]).not.toHaveProperty('effort')
    expect(lists()).toBe(1)
    expect(announced(seen)).toHaveLength(said)
    // The picker lists again; the kept choice then goes out where it is taken.
    listing = async () => ({ data: LISTING })
    complete()
    await adapter.models(handle)
    adapter.write(handle, { type: 'set_model', model: 'gpt-a' })
    adapter.write(handle, { type: 'user_message', text: 'three' })
    await settle()
    expect(turns()[2]).toMatchObject({ model: 'gpt-a', effort: 'ultra' })
    // What the turn carries is what the view was last told.
    expect(announced(seen).at(-1)).toBe('ultra')
    await adapter.kill(handle)
  })

  it('sends no effort for a model the list does not name, and keeps the choice for one it does', async () => {
    const { adapter, turns, complete } = effortFake({ reasoningEffort: 'low' })
    const handle = await adapter.spawn(spec)
    const seen: unknown[] = []
    adapter.on(handle, 'stream', (s) => seen.push(s))
    adapter.write(handle, { type: 'set_model', model: 'gpt-unlisted' })
    adapter.write(handle, { type: 'set_effort', effort: 'high' })
    adapter.write(handle, { type: 'user_message', text: 'one' })
    await settle()
    expect(turns()[0]).not.toHaveProperty('effort')
    expect(effortsOf(seen).at(-1)).toBe('low')
    complete()
    adapter.write(handle, { type: 'set_model', model: 'gpt-a' })
    adapter.write(handle, { type: 'user_message', text: 'two' })
    await settle()
    expect(turns()[1]).toMatchObject({ model: 'gpt-a', effort: 'high' })
    await adapter.kill(handle)
  })

  it.each([
    [{ reasoningEffort: 'medium' }, ['medium']],
    [{ reasoningEffort: null }, [null]],
    [{}, []]
  ])('reads the thread reply %j as the effort it runs at', async (thread, expected) => {
    const { adapter } = effortFake(thread)
    const handle = await adapter.spawn(spec)
    const seen: unknown[] = []
    adapter.on(handle, 'stream', (s) => seen.push(s))
    adapter.write(handle, { type: 'user_message', text: 'hello' })
    await settle()
    expect(effortsOf(seen)).toEqual(expected)
    await adapter.kill(handle)
  })

  it("takes the app-server's settings notification as its word", () => {
    const events: SessionEvent[] = []
    const translator = new CodexTranslator((e) => events.push(SessionEventSchema.parse(e)))
    translator.notification({
      method: 'thread/settings/updated',
      params: { threadSettings: { effort: 'xhigh' } }
    })
    translator.notification({
      method: 'thread/settings/updated',
      params: { threadSettings: { effort: null } }
    })
    expect(events).toEqual([
      { type: 'effort', effort: 'xhigh' },
      { type: 'effort', effort: null }
    ])
    // One that says nothing of the effort is kept as the provider's own frame.
    translator.notification({ method: 'thread/settings/updated', params: { threadSettings: {} } })
    expect(events.at(-1)).toMatchObject({ type: 'provider_event', provider: 'codex' })
  })

  it('carries the launch effort on the first turn and announces it once the thread starts', async () => {
    const { adapter, turns } = effortFake({ reasoningEffort: 'low' })
    const handle = await adapter.spawn({ ...spec, options: { effort: 'high' } })
    const seen: unknown[] = []
    adapter.on(handle, 'stream', (s) => seen.push(s))
    adapter.write(handle, { type: 'user_message', text: 'hello' })
    await settle()
    expect(turns()[0]).toMatchObject({ effort: 'high' })
    // The thread's own word first, then the launch's, which the turn carries.
    expect(effortsOf(seen)).toEqual(['low', 'high'])
    await adapter.kill(handle)
    // A launch effort that could reach a request is ignored.
    const bad = effortFake()
    const next = await bad.adapter.spawn({ ...spec, options: { effort: '--x' } })
    bad.adapter.write(next, { type: 'user_message', text: 'hello' })
    await settle()
    expect(bad.turns()[0]).not.toHaveProperty('effort')
    await bad.adapter.kill(next)
  })
})
