import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CodexAdapter, CodexTranslator } from './codex-adapter'
import { createAgentTokenStore } from '../agent-tokens'
import { installTerminalPorts, resetTerminalPorts } from '../../ports/terminals'
import type { CodexCallbacks, RpcNotification } from './codex-app-server'
import { CodexRpcError } from './codex-app-server'
import type { SessionHandle } from '../adapter'
import type { SessionEvent } from '../../../shared/session-model'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clave-codex-followup-'))
  const tokens = createAgentTokenStore(root)
  tokens.announce('http://127.0.0.1:12345/mcp')
  installTerminalPorts({ mcpConfig: tokens.mcpConfig })
})
afterEach(() => {
  resetTerminalPorts()
  rmSync(root, { recursive: true, force: true })
})
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const deferred = (): { promise: Promise<unknown>; resolve(value: unknown): void } => {
  let resolve!: (value: unknown) => void
  return { promise: new Promise((r) => (resolve = r)), resolve: (value) => resolve(value) }
}
type Request = (method: string, params?: unknown) => Promise<unknown>
async function setup(): Promise<{
  adapter: CodexAdapter
  handle: SessionHandle
  request: ReturnType<typeof vi.fn<Request>>
  events: SessionEvent[]
  send(text: string): void
  complete(): void
  notify(frame: RpcNotification): void
}> {
  let callbacks!: CodexCallbacks
  let turn = 0
  const request = vi.fn<Request>(async (method): Promise<unknown> => {
    if (method === 'thread/start') return { thread: { id: 'thread' } }
    if (method === 'turn/start') return { turn: { id: `turn-${++turn}`, status: 'inProgress' } }
    if (method === 'turn/steer') return { turnId: `turn-${turn}` }
    return {}
  })
  const adapter = new CodexAdapter((_cwd, cb) => {
    callbacks = cb
    return {
      request,
      notify: vi.fn(),
      respond: vi.fn(),
      reject: vi.fn(),
      close: async () => callbacks.exit(0)
    }
  })
  const handle = await adapter.spawn({
    id: 'followup',
    provider: 'codex',
    adapterId: adapter.id,
    transport: 'events',
    cwd: root,
    windowKey: 'test',
    state: 'idle',
    title: 'Follow-up',
    createdAt: 1
  })
  const events: SessionEvent[] = []
  adapter.on(handle, 'stream', (stream) => {
    if (stream.kind === 'event') events.push(stream.event)
  })
  const send = (text: string): void => {
    void adapter.write(handle, { type: 'user_message', text })
  }
  const complete = (): void =>
    callbacks.notification({
      method: 'turn/completed',
      params: { threadId: 'thread', turn: { id: 'turn-1', status: 'completed' } }
    })
  return {
    adapter,
    handle,
    request,
    events,
    send,
    complete,
    notify: (frame) => callbacks.notification(frame)
  }
}

it('steers the active turn and emits each follow-up once, without interrupting', async () => {
  const s = await setup()
  try {
    s.send('first')
    await tick()
    s.send('follow-up')
    s.send('another')
    await tick()
    expect(s.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(1)
    expect(s.request.mock.calls.filter(([m]) => m === 'turn/steer').map(([, p]) => p)).toEqual([
      {
        threadId: 'thread',
        expectedTurnId: 'turn-1',
        input: [{ type: 'text', text: 'follow-up', text_elements: [] }]
      },
      {
        threadId: 'thread',
        expectedTurnId: 'turn-1',
        input: [{ type: 'text', text: 'another', text_elements: [] }]
      }
    ])
    expect(s.request.mock.calls.some(([m]) => m === 'turn/interrupt')).toBe(false)
    expect(s.events.filter((e) => e.type === 'user_message').map((e) => e.text)).toEqual([
      'first',
      'follow-up',
      'another'
    ])
  } finally {
    await s.adapter.kill(s.handle)
  }
})

it('waits for a pending start reply before sending the follow-up', async () => {
  const s = await setup()
  const pending = deferred()
  const original = s.request.getMockImplementation()!
  s.request.mockImplementation((method, params) =>
    method === 'turn/start' ? pending.promise : original(method, params)
  )
  try {
    s.send('first')
    s.send('follow-up during startup')
    await tick()
    expect(s.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(1)
    expect(s.request.mock.calls.some(([m]) => m === 'turn/steer')).toBe(false)
    pending.resolve({ turn: { id: 'pending', status: 'inProgress' } })
    await tick()
    expect(s.request).toHaveBeenCalledWith(
      'turn/steer',
      expect.objectContaining({ expectedTurnId: 'pending' })
    )
  } finally {
    await s.adapter.kill(s.handle)
  }
})

it('starts a new turn when the preceding turn finished before dispatch', async () => {
  const s = await setup()
  try {
    s.send('first')
    await tick()
    s.send('at completion')
    s.complete()
    await tick()
    expect(s.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(2)
    expect(s.request.mock.calls.some(([m]) => m === 'turn/steer')).toBe(false)
  } finally {
    await s.adapter.kill(s.handle)
  }
})

it('reports a rejected steer and never automatically replays ambiguous input', async () => {
  const s = await setup()
  const original = s.request.getMockImplementation()!
  s.request.mockImplementation((method, params) =>
    method === 'turn/steer' ? Promise.reject(new Error('Turn changed')) : original(method, params)
  )
  try {
    s.send('first')
    await tick()
    s.send('rejected')
    await tick()
    expect(s.events).toContainEqual({ type: 'error', message: 'Turn changed', fatal: false })
    expect(s.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(1)
    s.complete()
    s.send('retry explicitly')
    await tick()
    expect(s.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(2)
  } finally {
    await s.adapter.kill(s.handle)
  }
})

it('does not dispatch queued input after the session closes during startup', async () => {
  const s = await setup()
  const pending = deferred()
  const original = s.request.getMockImplementation()!
  s.request.mockImplementation((method, params) =>
    method === 'thread/start' ? pending.promise : original(method, params)
  )
  s.send('first')
  s.send('follow-up')
  await tick()
  await s.adapter.kill(s.handle)
  pending.resolve({ thread: { id: 'thread' } })
  await tick()
  expect(s.request.mock.calls.some(([m]) => m === 'turn/start' || m === 'turn/steer')).toBe(false)
})

it('serializes pending steers and retargets the next message after completion', async () => {
  const s = await setup()
  const pending = deferred()
  const original = s.request.getMockImplementation()!
  s.request.mockImplementation((method, params) =>
    method === 'turn/steer' ? pending.promise : original(method, params)
  )
  try {
    s.send('first')
    await tick()
    s.send('pending steer')
    await tick()
    s.send('queued behind steer')
    await tick()
    expect(s.request.mock.calls.filter(([m]) => m === 'turn/steer')).toHaveLength(1)
    s.complete()
    pending.resolve({ turnId: 'turn-1' })
    await tick()
    expect(s.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(2)
    expect(s.request.mock.calls.filter(([m]) => m === 'turn/steer')).toHaveLength(1)
  } finally {
    await s.adapter.kill(s.handle)
  }
})

it('preserves images in a steer and applies a selected model only to the next turn', async () => {
  const s = await setup()
  try {
    s.send('first')
    await tick()
    s.adapter.write(s.handle, { type: 'set_model', model: 'chosen-model' })
    s.adapter.write(s.handle, {
      type: 'user_message',
      text: '',
      attachments: [
        {
          id: 'shot',
          path: '/fixture/shot.png',
          name: 'shot.png',
          mimeType: 'image/png',
          size: 3,
          delivery: 'image'
        }
      ],
      prepared: { text: '', images: [{ name: 'shot.png', mimeType: 'image/png', data: 'AQID' }] }
    })
    await tick()
    expect(s.request).toHaveBeenCalledWith('turn/steer', {
      threadId: 'thread',
      expectedTurnId: 'turn-1',
      input: [{ type: 'image', url: 'data:image/png;base64,AQID' }]
    })
    s.complete()
    s.send('new turn')
    await tick()
    expect(s.request).toHaveBeenLastCalledWith(
      'turn/start',
      expect.objectContaining({ model: 'chosen-model' })
    )
    expect(s.request.mock.calls.filter(([m]) => m === 'thread/start')).toHaveLength(1)
  } finally {
    await s.adapter.kill(s.handle)
  }
})

it('delivers once as a new turn after an explicit no-active-turn refusal', async () => {
  const s = await setup()
  const original = s.request.getMockImplementation()!
  let refuse = true
  s.request.mockImplementation((method, params) => {
    if (method === 'turn/steer' && refuse) {
      refuse = false
      return Promise.reject(new CodexRpcError(-32600, 'no active turn to steer'))
    }
    return original(method, params)
  })
  try {
    s.send('first')
    await tick()
    s.send('sent as the turn ends')
    await tick()
    expect(s.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(2)
    expect(s.request).toHaveBeenLastCalledWith(
      'turn/start',
      expect.objectContaining({
        input: [{ type: 'text', text: 'sent as the turn ends', text_elements: [] }]
      })
    )
    expect(s.events.filter((e) => e.type === 'error')).toEqual([])
    expect(s.events.filter((e) => e.type === 'user_message')).toHaveLength(2)
    // The old completion can arrive after the recovery has started turn 2.
    s.complete()
    s.send('follow up on recovered turn')
    await tick()
    expect(s.request).toHaveBeenLastCalledWith(
      'turn/steer',
      expect.objectContaining({ expectedTurnId: 'turn-2' })
    )
    expect(s.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(2)
  } finally {
    await s.adapter.kill(s.handle)
  }
})

it.each([
  new Error('no active turn to steer'),
  new CodexRpcError(-32603, 'no active turn to steer'),
  new CodexRpcError(-32600, 'different active turn'),
  new Error('Codex request timed out: turn/steer')
])('does not replay input for an ambiguous or different rejection: %s', async (error) => {
  const s = await setup()
  const original = s.request.getMockImplementation()!
  s.request.mockImplementation((method, params) =>
    method === 'turn/steer' ? Promise.reject(error) : original(method, params)
  )
  try {
    s.send('first')
    await tick()
    s.send('uncertain')
    await tick()
    expect(s.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(1)
    expect(s.events).toContainEqual({ type: 'error', message: error.message, fatal: false })
  } finally {
    await s.adapter.kill(s.handle)
  }
})

it('does not recover onto a different turn that became active while the steer was pending', async () => {
  const s = await setup()
  const pending = deferred()
  const original = s.request.getMockImplementation()!
  let refused = false
  s.request.mockImplementation((method, params) => {
    if (method === 'turn/steer' && !refused) {
      refused = true
      return pending.promise
    }
    return original(method, params)
  })
  try {
    s.send('first')
    await tick()
    s.send('during switch')
    await tick()
    s.complete()
    s.notify({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn-9' } } })
    pending.resolve(Promise.reject(new CodexRpcError(-32600, 'no active turn to steer')))
    await tick()
    expect(s.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(1)
    expect(s.events).toContainEqual({
      type: 'error',
      message: 'no active turn to steer',
      fatal: false
    })
    s.send('after switch')
    await tick()
    expect(s.request).toHaveBeenLastCalledWith(
      'turn/steer',
      expect.objectContaining({ expectedTurnId: 'turn-9' })
    )
  } finally {
    await s.adapter.kill(s.handle)
  }
})

it.each(['failed', 'interrupted'])(
  'preserves late old-turn %s cleanup without resetting the new turn',
  (status) => {
    const events: SessionEvent[] = []
    const translator = new CodexTranslator((event) => events.push(event))
    translator.threadId = 'thread'
    const start = (id: string): void =>
      translator.notification({
        method: 'turn/started',
        params: { threadId: 'thread', turn: { id } }
      })
    const command = (id: string, turnId: string): void =>
      translator.notification({
        method: 'item/started',
        params: {
          threadId: 'thread',
          turnId,
          item: { id, type: 'commandExecution', command: `sleep ${id}` }
        }
      })
    start('old')
    command('old-command', 'old')
    translator.request({
      id: 1,
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread', turnId: 'old' }
    })
    start('new')
    command('new-command', 'new')
    translator.request({
      id: 2,
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread', turnId: 'new' }
    })
    translator.notification({
      method: 'item/agentMessage/delta',
      params: { threadId: 'thread', turnId: 'new', itemId: 'answer', delta: 'Hel' }
    })
    const before = events.length
    translator.notification({
      method: 'turn/completed',
      params: {
        threadId: 'thread',
        turn: {
          id: 'old',
          status,
          ...(status === 'failed' ? { error: { message: 'old turn failed late' } } : {})
        }
      }
    })
    const late = events.slice(before)
    if (status === 'failed')
      expect(late).toContainEqual({ type: 'error', message: 'old turn failed late', fatal: false })
    else {
      expect(late.some((event) => event.type === 'provider_event')).toBe(true)
      expect(late.some((event) => event.type === 'turn_interrupted')).toBe(false)
    }
    expect(late.some((e) => e.type === 'state_change')).toBe(false)
    expect(translator.turnId).toBe('new')
    expect([...translator.approvals.values()].map((approval) => approval.turnId)).toEqual(['new'])
    const tasks = late.find((e) => e.type === 'background_tasks')
    expect(tasks?.type === 'background_tasks' && tasks.tasks.map((task) => task.id)).toEqual([
      'old-command'
    ])
    translator.notification({
      method: 'item/completed',
      params: {
        threadId: 'thread',
        turnId: 'new',
        item: { id: 'answer', type: 'agentMessage', text: 'Hello' }
      }
    })
    expect(
      events
        .filter((event) => event.type === 'assistant_text')
        .map((event) => event.delta)
        .join('')
    ).toBe('Hello')
    translator.notification({
      method: 'turn/completed',
      params: { threadId: 'thread', turn: { id: 'new', status: 'completed' } }
    })
    const finalTasks = events.findLast((e) => e.type === 'background_tasks')
    expect(
      finalTasks?.type === 'background_tasks' && finalTasks.tasks.map((task) => task.id)
    ).toEqual(['old-command', 'new-command'])
    expect(translator.turnId).toBe('')
  }
)
it('an identified write has no durable acceptance before provider dispatch', async () => {
  const { WriteLedger, memoryWriteLedgerStorage } =
    await import('../../../../packages/server/src/sessions/writes')
  const storage = memoryWriteLedgerStorage()
  const ledger = new WriteLedger(
    storage,
    () => 1,
    () => {}
  )
  const s = await setup()
  const id = 'phone-00000001'
  ledger.initialize('followup')
  ledger.receive('followup', id)
  ledger.dispatch('followup', id)
  s.adapter.on(s.handle, 'stream', (stream) => {
    if (
      stream.kind === 'event' &&
      stream.event.type === 'user_message' &&
      stream.event.clientMessageId
    )
      ledger.evidence('followup', id, 2)
  })
  s.adapter.write(s.handle, { type: 'user_message', text: 'NEVER SENT YET', clientMessageId: id })
  expect(s.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(0)
  const reboot = new WriteLedger(
    storage,
    () => 3,
    () => {}
  )
  const actual = reboot.status('followup', id)
  await tick()
  await s.adapter.kill(s.handle)
  expect(actual.status).toBe('unknown')
})

it('an identified Codex write waits for provider acknowledgement and then emits its history', async () => {
  const s = await setup()
  const gate = deferred()
  const original = s.request.getMockImplementation()!
  s.request.mockImplementation((method, params) =>
    method === 'turn/start' ? gate.promise : original(method, params)
  )
  const accepted = s.adapter.write(s.handle, {
    type: 'user_message',
    text: 'hello',
    clientMessageId: 'phone-00000002'
  })
  expect(accepted).toBeInstanceOf(Promise)
  await tick()
  expect(s.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(1)
  expect(s.events.filter((e) => e.type === 'user_message')).toEqual([])
  let settled = false
  void Promise.resolve(accepted).then(() => {
    settled = true
  })
  await tick()
  expect(settled).toBe(false)
  gate.resolve({ turn: { id: 'turn', status: 'inProgress' } })
  await accepted
  expect(s.events.filter((e) => e.type === 'user_message')).toEqual([
    { type: 'user_message', text: 'hello', clientMessageId: 'phone-00000002' }
  ])
  await s.adapter.kill(s.handle)
})

it('an identified Codex write with a lost acknowledgement remains unknown', async () => {
  const s = await setup()
  s.request.mockRejectedValue(new Error('transport timed out'))
  await expect(
    s.adapter.write(s.handle, {
      type: 'user_message',
      text: 'hello',
      clientMessageId: 'phone-00000003'
    })
  ).rejects.toMatchObject({ _tag: 'UnconfirmedSessionWrite', clientMessageId: 'phone-00000003' })
  expect(s.events.filter((e) => e.type === 'user_message')).toEqual([])
  await s.adapter.kill(s.handle)
})
it('known provider refusal stays refused without evidence', async () => {
  const s = await setup()
  const original = s.request.getMockImplementation()!
  s.request.mockImplementation((method, params) =>
    method === 'turn/start'
      ? Promise.reject(new CodexRpcError(-32600, 'not allowed'))
      : original(method, params)
  )
  try {
    await expect(
      s.adapter.write(s.handle, {
        type: 'user_message',
        text: 'hello',
        clientMessageId: 'phone-00000009'
      })
    ).rejects.toBeInstanceOf(CodexRpcError)
    expect(s.events.filter((e) => e.type === 'user_message')).toHaveLength(0)
  } finally {
    await s.adapter.kill(s.handle)
  }
})
it('close before dispatch never accepts', async () => {
  const s = await setup()
  const result = s.adapter.write(s.handle, {
    type: 'user_message',
    text: 'hello',
    clientMessageId: 'phone-00000010'
  })
  const assertion = expect(result).rejects.toBeInstanceOf(CodexRpcError)
  await s.adapter.kill(s.handle)
  await assertion
  expect(s.request.mock.calls.filter(([m]) => m === 'turn/start')).toHaveLength(0)
  expect(s.events.filter((e) => e.type === 'user_message')).toHaveLength(0)
})
it('provider response before RPC acknowledgement must retain conversation order', async () => {
  const s = await setup()
  const gate = deferred()
  const original = s.request.getMockImplementation()!
  s.request.mockImplementation((method, params) =>
    method === 'turn/start' ? gate.promise : original(method, params)
  )
  const result = s.adapter.write(s.handle, {
    type: 'user_message',
    text: 'hello',
    clientMessageId: 'phone-00000011'
  })
  await tick()
  s.notify({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread', turnId: 'turn', itemId: 'a', delta: 'answer' }
  })
  gate.resolve({ turn: { id: 'turn', status: 'inProgress' } })
  await result
  const order = s.events
    .filter((e) => e.type === 'user_message' || e.type === 'assistant_text')
    .map((e) => e.type)
  await s.adapter.kill(s.handle)
  expect(order[0]).toBe('user_message')
})
it('failed ACK flushes provider frames without identified acceptance', async () => {
  const s = await setup()
  let reject!: (e: Error) => void
  const gate = new Promise((_, r) => (reject = r))
  const original = s.request.getMockImplementation()!
  s.request.mockImplementation((method, params) =>
    method === 'turn/start' ? gate : original(method, params)
  )
  const accepted = s.adapter.write(s.handle, {
    type: 'user_message',
    text: 'hello',
    clientMessageId: 'phone-00000021'
  })
  const failure = expect(accepted).rejects.toMatchObject({ _tag: 'UnconfirmedSessionWrite' })
  await tick()
  s.notify({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread', turnId: 'turn', itemId: 'a', delta: 'answer' }
  })
  expect(s.events.filter((e) => e.type === 'assistant_text')).toHaveLength(0)
  reject(new Error('lost response'))
  await failure
  expect(s.events.filter((e) => e.type === 'user_message')).toHaveLength(0)
  expect(s.events.filter((e) => e.type === 'assistant_text')).toHaveLength(1)
  await s.adapter.kill(s.handle)
})
it('queued identified writes retain user order and one send each', async () => {
  const s = await setup()
  const first = deferred()
  const second = deferred()
  const original = s.request.getMockImplementation()!
  s.request.mockImplementation((method, params) =>
    method === 'turn/start'
      ? first.promise
      : method === 'turn/steer'
        ? second.promise
        : original(method, params)
  )
  const a = s.adapter.write(s.handle, {
    type: 'user_message',
    text: 'first',
    clientMessageId: 'phone-00000022'
  })
  const b = s.adapter.write(s.handle, {
    type: 'user_message',
    text: 'second',
    clientMessageId: 'phone-00000023'
  })
  await tick()
  expect(s.request.mock.calls.filter(([m]) => m === 'turn/steer')).toHaveLength(0)
  first.resolve({ turn: { id: 'turn', status: 'inProgress' } })
  await a
  await tick()
  expect(s.events.filter((e) => e.type === 'user_message').map((e) => e.text)).toEqual(['first'])
  second.resolve({ turnId: 'turn' })
  await b
  expect(s.events.filter((e) => e.type === 'user_message').map((e) => e.text)).toEqual([
    'first',
    'second'
  ])
  expect(
    s.request.mock.calls.filter(([m]) => m === 'turn/start' || m === 'turn/steer')
  ).toHaveLength(2)
  await s.adapter.kill(s.handle)
})
it.each([true, false])(
  'mixed desktop and phone writes preserve dispatch order, same tick %s',
  async (sameTick) => {
    const s = await setup()
    const gate = deferred()
    const original = s.request.getMockImplementation()!
    s.request.mockImplementation((method, params) =>
      method === 'turn/start' ? gate.promise : original(method, params)
    )
    const first = s.adapter.write(s.handle, {
      type: 'user_message',
      text: 'phone first',
      clientMessageId: 'phone-00000024'
    })
    if (!sameTick) await tick()
    s.adapter.write(s.handle, { type: 'user_message', text: 'desktop second' })
    gate.resolve({ turn: { id: 'turn', status: 'inProgress' } })
    await first
    await tick()
    const texts = s.events.filter((e) => e.type === 'user_message').map((e) => e.text)
    await s.adapter.kill(s.handle)
    expect(texts).toEqual(['phone first', 'desktop second'])
  }
)
it('coalesced response and notification preserve order through real JSON-RPC reader', async () => {
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  const { CodexAppServer } = await import('./codex-app-server')
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit('close', 0))
      return true
    })
  })
  let turn: { id: number; method: string } | undefined
  child.stdin.on('data', (chunk) => {
    for (const line of chunk.toString().trim().split('\n')) {
      const frame = JSON.parse(line)
      if (frame.id === undefined) continue
      if (frame.method === 'turn/start') {
        turn = frame
        continue
      }
      const result = frame.method === 'thread/start' ? { thread: { id: 'thread' } } : {}
      child.stdout.write(JSON.stringify({ id: frame.id, result }) + '\n')
    }
  })
  const adapter = new CodexAdapter(
    (_cwd, callbacks) =>
      new CodexAppServer(
        child as unknown as ConstructorParameters<typeof CodexAppServer>[0],
        callbacks
      )
  )
  const handle = await adapter.spawn({
    id: 'coalesced',
    provider: 'codex',
    adapterId: adapter.id,
    transport: 'events',
    cwd: root,
    windowKey: 'test',
    state: 'idle',
    title: 'test',
    createdAt: 1
  })
  const events: SessionEvent[] = []
  adapter.on(handle, 'stream', (s) => {
    if (s.kind === 'event') events.push(s.event)
  })
  const result = adapter.write(handle, {
    type: 'user_message',
    text: 'question',
    clientMessageId: 'phone-00000025'
  })
  await tick()
  expect(turn!.method).toBe('turn/start')
  child.stdout.write(
    JSON.stringify({ id: turn!.id, result: { turn: { id: 'turn', status: 'inProgress' } } }) +
      '\n' +
      JSON.stringify({
        method: 'item/agentMessage/delta',
        params: { threadId: 'thread', turnId: 'turn', itemId: 'a', delta: 'answer' }
      }) +
      '\n'
  )
  await result
  const order = events
    .filter((e) => e.type === 'user_message' || e.type === 'assistant_text')
    .map((e) => e.type)
  await adapter.kill(handle)
  expect(order).toEqual(['user_message', 'assistant_text'])
})

it('reentrant desktop input does not overtake an already deferred desktop input', async () => {
  const s = await setup()
  const gate = deferred()
  const original = s.request.getMockImplementation()!
  s.request.mockImplementation((method, params) =>
    method === 'turn/start' ? gate.promise : original(method, params)
  )
  const first = s.adapter.write(s.handle, {
    type: 'user_message',
    text: 'phone first',
    clientMessageId: 'phone-00000026'
  })
  await tick()
  s.adapter.write(s.handle, { type: 'user_message', text: 'desktop second' })
  s.adapter.on(s.handle, 'stream', (stream) => {
    if (stream.kind === 'event' && stream.event.type === 'assistant_text')
      s.adapter.write(s.handle, { type: 'user_message', text: 'desktop third' })
  })
  s.notify({
    method: 'item/agentMessage/delta',
    params: { threadId: 'thread', turnId: 'turn', itemId: 'a', delta: 'answer' }
  })
  gate.resolve({ turn: { id: 'turn', status: 'inProgress' } })
  await first
  await tick()
  const order = s.events.filter((e) => e.type === 'user_message').map((e) => e.text)
  await s.adapter.kill(s.handle)
  expect(order).toEqual(['phone first', 'desktop second', 'desktop third'])
})
