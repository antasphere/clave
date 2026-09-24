import { readFileSync } from 'node:fs'
import { describe, it, expect, vi } from 'vitest'
import { CodexAdapter, CodexTranslator } from './codex-adapter'
import { SessionEventSchema, type SessionEvent } from '../../../shared/session-model'
import type { SpawnSpec } from '../adapter'
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
    }
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
      })
    )
    await adapter.kill(handle)
    const next = await adapter.spawn(spec)
    adapter.write(next, { type: 'user_message', text: 'hello' })
    await tick()
    expect(connect).toHaveBeenLastCalledWith(spec.cwd, expect.any(Object), undefined)
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
