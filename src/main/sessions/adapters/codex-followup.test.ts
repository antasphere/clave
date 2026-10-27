import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CodexAdapter } from './codex-adapter'
import { createAgentTokenStore } from '../agent-tokens'
import { installTerminalPorts, resetTerminalPorts } from '../../ports/terminals'
import type { CodexCallbacks } from './codex-app-server'
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
  const send = (text: string): void => adapter.write(handle, { type: 'user_message', text })
  const complete = (): void =>
    callbacks.notification({
      method: 'turn/completed',
      params: { threadId: 'thread', turn: { id: 'turn-1', status: 'completed' } }
    })
  return { adapter, handle, request, events, send, complete }
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
