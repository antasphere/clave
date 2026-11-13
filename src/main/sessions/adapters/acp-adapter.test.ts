import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpAdapter, type AcpSpawnOptions } from './acp-adapter'
import type { SessionHandle } from '../adapter'
import type { SessionEvent } from '../../../shared/session-model'

const STAND_IN = resolve(__dirname, '../../../../tests/e2e/fixtures/acp-agent.mjs')

const dirs: string[] = []
const live: { adapter: AcpAdapter; handle: SessionHandle }[] = []
afterEach(async () => {
  for (const { adapter, handle } of live.splice(0)) {
    const pid = childPid(adapter, handle)
    await adapter.kill(handle).catch(() => {})
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function childPid(adapter: AcpAdapter, handle: SessionHandle): number | undefined {
  const state = (
    adapter as unknown as { handles: Map<string, { connection?: unknown }> }
  ).handles.get(handle.id)
  const connection = state?.connection as { child?: { pid?: number } } | undefined
  return connection?.child?.pid
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'acp-adapter-'))
  dirs.push(dir)
  return dir
}

let sequence = 0
interface Session {
  adapter: AcpAdapter
  handle: SessionHandle
  events: SessionEvent[]
  exits: number[]
  state: string
  pid: number
}
async function open(
  options: AcpSpawnOptions = {},
  {
    state = tmp(),
    env = {},
    initialPrompt,
    ready = true
  }: { state?: string; env?: Record<string, string>; initialPrompt?: string; ready?: boolean } = {}
): Promise<Session> {
  const adapter = new AcpAdapter({ id: 'opencode-chat', provider: 'opencode', label: 'OpenCode' })
  const id = `acp-${++sequence}`
  adapter.configure(id, {
    command: [process.execPath, STAND_IN, 'acp'],
    env: { ...process.env, ACP_STAND_IN_STATE: state, ...env },
    ...(initialPrompt ? { initialPrompt } : {})
  })
  const handle = await adapter.spawn({
    id,
    provider: 'opencode',
    transport: 'events',
    cwd: state,
    windowKey: 'w',
    state: 'idle',
    createdAt: 0,
    adapterId: 'opencode-chat',
    title: 'OpenCode',
    options
  })
  live.push({ adapter, handle })
  const events: SessionEvent[] = []
  const exits: number[] = []
  const pid = childPid(adapter, handle)!
  adapter.on(handle, 'stream', (stream) => {
    if (stream.kind === 'event') events.push(stream.event)
  })
  adapter.on(handle, 'exit', (code) => exits.push(code))
  if (ready) adapter.ready(handle)
  return { adapter, handle, events, exits, state, pid }
}
const frames = (state: string): { method?: string; params?: Record<string, unknown> }[] =>
  existsSync(join(state, 'frames.jsonl'))
    ? readFileSync(join(state, 'frames.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).frame)
    : []
const done = (events: SessionEvent[], from = 0): boolean =>
  events.slice(from).some((e) => e.type === 'state_change' && e.state === 'done')
const states = (events: SessionEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'state_change' ? [e.state] : []))

describe('AcpAdapter against the stand-in agent', () => {
  it('opens a session and names its id and model', async () => {
    const { events } = await open()
    const meta = events.find((e) => e.type === 'session_meta')
    expect(meta).toEqual({
      type: 'session_meta',
      model: 'stand-in/one',
      providerSessionId: expect.stringMatching(/^ses_[0-9a-f]{16}$/)
    })
  })

  it('turns a message into the stream Codex speaks, in order', async () => {
    const s = await open()
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'user_message', text: 'hello' })
    await expect.poll(() => done(s.events)).toBe(true)
    const callId = (s.events.find((e) => e.type === 'tool_call') as { id: string }).id
    expect(s.events).toEqual([
      { type: 'user_message', text: 'hello' },
      { type: 'state_change', state: 'working' },
      { type: 'assistant_text', delta: 'You said: ', final: false },
      { type: 'assistant_text', delta: 'hel', final: false },
      { type: 'assistant_text', delta: 'lo', final: false },
      { type: 'assistant_text', delta: '', final: true },
      { type: 'tool_call', id: callId, name: 'Read README.md', input: { path: 'README.md' } },
      { type: 'tool_result', id: callId, output: '# Stand-in' },
      { type: 'state_change', state: 'done' }
    ])
    const prompt = frames(s.state).find((f) => f.method === 'session/prompt')
    expect(prompt?.params?.prompt).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('sends a file attachment as a resource link', async () => {
    const s = await open()
    s.adapter.write(s.handle, {
      type: 'user_message',
      text: 'look',
      attachments: [
        {
          id: 'a1',
          label: 'notes.md',
          path: '/tmp/notes.md',
          name: 'notes.md',
          mimeType: 'text/markdown',
          size: 3,
          delivery: 'reference'
        }
      ]
    })
    await expect.poll(() => done(s.events)).toBe(true)
    const prompt = frames(s.state).find((f) => f.method === 'session/prompt')
    expect(prompt?.params?.prompt).toEqual([
      { type: 'text', text: 'look' },
      { type: 'resource_link', uri: 'file:///tmp/notes.md', name: 'notes.md' }
    ])
  })

  it('answers the permission itself under autoApprove, with allow_always', async () => {
    const s = await open({ autoApprove: true })
    s.adapter.write(s.handle, { type: 'user_message', text: 'ask permission' })
    await expect.poll(() => done(s.events)).toBe(true)
    expect(s.events.some((e) => e.type === 'permission_request')).toBe(false)
    expect(
      s.events.some((e) => e.type === 'assistant_text' && e.delta === 'permission: allow_always')
    ).toBe(true)
  })

  it('without autoApprove, asks the reader (blocked) and answers with the chosen option', async () => {
    const s = await open()
    s.adapter.write(s.handle, { type: 'user_message', text: 'ask permission' })
    await expect.poll(() => s.events.some((e) => e.type === 'permission_request')).toBe(true)
    const request = s.events.find((e) => e.type === 'permission_request')!
    expect(request).toEqual({
      type: 'permission_request',
      id: expect.any(String),
      description: 'Write notes.md',
      options: [
        { id: 'allow_once', label: 'Allow once' },
        { id: 'allow_always', label: 'Always allow' },
        { id: 'reject_once', label: 'Reject' }
      ],
      toolName: 'edit',
      input: { path: 'notes.md' }
    })
    expect(states(s.events)).toEqual(['working', 'blocked'])
    // A response to no pending request is ignored.
    s.adapter.write(s.handle, { type: 'permission_response', id: 'nope', optionId: 'deny' })
    s.adapter.write(s.handle, {
      type: 'permission_response',
      id: (request as { id: string }).id,
      optionId: 'deny'
    })
    await expect.poll(() => done(s.events)).toBe(true)
    expect(
      s.events.some((e) => e.type === 'assistant_text' && e.delta === 'permission: reject_once')
    ).toBe(true)
    expect(states(s.events)).toEqual(['working', 'blocked', 'working', 'done'])
  })

  it('interrupt ends a slow turn cancelled and the chat idle', async () => {
    const s = await open()
    s.adapter.write(s.handle, { type: 'user_message', text: 'be slow' })
    await expect.poll(() => frames(s.state).some((f) => f.method === 'session/prompt')).toBe(true)
    const started = Date.now()
    s.adapter.write(s.handle, { type: 'interrupt' })
    await expect.poll(() => done(s.events)).toBe(true)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(frames(s.state).some((f) => f.method === 'session/cancel')).toBe(true)
    expect(s.events.slice(-2)).toEqual([
      { type: 'turn_interrupted' },
      { type: 'state_change', state: 'done' }
    ])
  })

  // Verifier round 1, gap (mutation 22): the protocol asks a client that
  // cancels a turn to settle its open permission requests as cancelled.
  it('an interrupt while a permission is asked answers it cancelled and withdraws the card', async () => {
    const s = await open()
    s.adapter.write(s.handle, { type: 'user_message', text: 'ask permission' })
    await expect.poll(() => s.events.some((e) => e.type === 'permission_request')).toBe(true)
    const request = s.events.find((e) => e.type === 'permission_request') as { id: string }
    s.adapter.write(s.handle, { type: 'interrupt' })
    await expect
      .poll(() =>
        frames(s.state).find(
          (f) => (f as { id?: unknown }).id === JSON.parse(request.id) && !f.method
        )
      )
      .toMatchObject({ result: { outcome: { outcome: 'cancelled' } } })
    expect(s.events).toContainEqual({ type: 'permission_withdrawn', id: request.id })
    // The stand-in records the cancel after its cancelled answer: polled
    // (verifier round 2, Minor 2).
    await expect.poll(() => frames(s.state).some((f) => f.method === 'session/cancel')).toBe(true)
    await expect.poll(() => done(s.events)).toBe(true)
  })

  // Verifier round 1, gap (mutation 25): OpenCode streams its subagents'
  // child sessions beside the parent's; only the tab's own session is shown.
  it("ignores a session/update of another session, a subagent's text never in the chat", async () => {
    const s = await open({}, { env: { ACP_STAND_IN_STRAY_UPDATE: '1' } })
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'user_message', text: 'hello' })
    await expect.poll(() => done(s.events)).toBe(true)
    expect(frames(s.state).some((f) => f.method === 'session/prompt')).toBe(true)
    expect(
      s.events.filter((e) => e.type === 'assistant_text').map((e) => (e as { delta: string }).delta)
    ).toEqual(['You said: ', 'hel', 'lo', ''])
  })

  it('set_model sends set_config_option and names the new model', async () => {
    const s = await open()
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'set_model', model: 'stand-in/two' })
    await expect
      .poll(() => s.events.find((e) => e.type === 'session_meta'))
      .toMatchObject({
        model: 'stand-in/two'
      })
    expect(
      frames(s.state).find((f) => f.method === 'session/set_config_option')?.params
    ).toMatchObject({ configId: 'model', value: 'stand-in/two' })
  })

  it('a spawn with a listed model sets it after session/new', async () => {
    const s = await open({ model: 'stand-in/three' })
    const metas = s.events.filter((e) => e.type === 'session_meta').map((e) => e.model)
    expect(metas).toEqual(['stand-in/one', 'stand-in/three'])
    const methods = frames(s.state).map((f) => f.method)
    expect(methods.indexOf('session/set_config_option')).toBeGreaterThan(
      methods.indexOf('session/new')
    )
  })

  it('a model the agent does not list is a notice, and the current one stays', async () => {
    const s = await open({ model: 'other/unknown' })
    expect(s.events.filter((e) => e.type === 'session_meta').map((e) => e.model)).toEqual([
      'stand-in/one'
    ])
    expect(s.events).toContainEqual({
      type: 'error',
      message: expect.stringContaining('other/unknown'),
      fatal: false
    })
    expect(frames(s.state).some((f) => f.method === 'session/set_config_option')).toBe(false)
  })

  it('resumes a known session through session/load, its past in history, with no session/new', async () => {
    const state = tmp()
    const first = await open({}, { state })
    first.adapter.write(first.handle, { type: 'user_message', text: 'remember me' })
    await expect.poll(() => done(first.events)).toBe(true)
    const sessionId = (
      first.events.find((e) => e.type === 'session_meta') as {
        providerSessionId: string
      }
    ).providerSessionId
    await first.adapter.kill(first.handle)
    rmSync(join(state, 'frames.jsonl'))

    const second = await open({ resume: sessionId }, { state })
    const methods = frames(state).map((f) => f.method)
    expect(methods).toContain('session/load')
    expect(methods).not.toContain('session/new')
    const history = second.adapter.history(second.handle).map((item) => item.event)
    expect(history).toEqual([
      { type: 'user_message', text: 'remember me' },
      { type: 'assistant_text', delta: 'You said: remember me', final: true },
      {
        type: 'tool_call',
        id: expect.any(String),
        name: 'Read README.md',
        input: { path: 'README.md' }
      },
      { type: 'tool_result', id: expect.any(String), output: '# Stand-in' }
    ])
    expect(second.events.find((e) => e.type === 'session_meta')).toMatchObject({
      providerSessionId: sessionId
    })
    // The replay never reaches the live stream.
    expect(second.events.some((e) => e.type === 'user_message')).toBe(false)
  })

  it('a resume of an unknown id falls back to a new session, with a notice', async () => {
    const s = await open({ resume: 'ses_0000000000000000' })
    expect(s.events[0]).toEqual({
      type: 'error',
      message: expect.stringContaining('Unknown session'),
      fatal: false
    })
    expect(frames(s.state).map((f) => f.method)).toEqual([
      'initialize',
      'session/load',
      'session/new'
    ])
    expect(s.adapter.history(s.handle)).toEqual([])
    expect(s.events.find((e) => e.type === 'session_meta')).toMatchObject({
      providerSessionId: expect.stringMatching(/^ses_/)
    })
  })

  it('sends the launch prompt once, at ready', async () => {
    const s = await open({}, { initialPrompt: 'first words', ready: false })
    expect(frames(s.state).some((f) => f.method === 'session/prompt')).toBe(false)
    s.adapter.ready(s.handle)
    s.adapter.ready(s.handle)
    await expect.poll(() => done(s.events)).toBe(true)
    const prompts = frames(s.state).filter((f) => f.method === 'session/prompt')
    expect(prompts).toHaveLength(1)
    expect(prompts[0].params?.prompt).toEqual([{ type: 'text', text: 'first words' }])
  })

  it('a refused session/new gives the notice with the sign-in, ended and exit 1', async () => {
    const s = await open({}, { env: { ACP_STAND_IN_REFUSE: 'auth' } })
    await expect.poll(() => s.exits).toEqual([1])
    expect(s.events).toEqual([
      {
        type: 'error',
        message: expect.stringMatching(/Not signed in.*Run `stand-in login` in the terminal/),
        fatal: false
      },
      { type: 'state_change', state: 'ended' }
    ])
    expect(alive(s.pid)).toBe(false)
    // Kept in the past too, for a pane that subscribes after it was said.
    expect(s.adapter.history(s.handle).map((item) => item.event)).toEqual([s.events[0]])
  })

  it('an agent that prints a line and exits 1 before it speaks: that line and the status, never its environment', async () => {
    const secret = 'made-up-key-value-0002'
    const adapter = new AcpAdapter({ id: 'opencode-chat', provider: 'opencode', label: 'OpenCode' })
    const id = `acp-${++sequence}`
    adapter.configure(id, {
      command: [
        process.execPath,
        '-e',
        'process.stderr.write("Error: no provider configured (key " + process.env.DEEPSEEK_API_KEY + ")\\n"); process.exit(1)'
      ],
      env: { ...process.env, DEEPSEEK_API_KEY: secret }
    })
    const handle = await adapter.spawn({
      id,
      provider: 'opencode',
      transport: 'events',
      cwd: tmp(),
      windowKey: 'w',
      state: 'idle',
      createdAt: 0,
      adapterId: 'opencode-chat',
      title: 'OpenCode',
      options: {}
    })
    live.push({ adapter, handle })
    const events: SessionEvent[] = []
    const exits: number[] = []
    adapter.on(handle, 'stream', (stream) => {
      if (stream.kind === 'event') events.push(stream.event)
    })
    adapter.on(handle, 'exit', (code) => exits.push(code))
    adapter.ready(handle)
    await expect.poll(() => exits).toEqual([1])
    const refusal = {
      type: 'error',
      message:
        'OpenCode could not start: Error: no provider configured (key ‹hidden›) (exit status 1)',
      fatal: false
    }
    expect(events).toEqual([refusal, { type: 'state_change', state: 'ended' }])
    expect(JSON.stringify(events)).not.toContain(secret)
    expect(adapter.history(handle).map((item) => item.event)).toEqual([refusal])
  })

  it('kill ends the child', async () => {
    const s = await open()
    expect(alive(s.pid)).toBe(true)
    await s.adapter.kill(s.handle)
    expect(alive(s.pid)).toBe(false)
    expect(() => s.adapter.history(s.handle)).toThrow('Unknown OpenCode session')
  })

  it('the child dying mid-turn ends the chat with exit and ended', async () => {
    const s = await open()
    s.adapter.write(s.handle, { type: 'user_message', text: 'be slow' })
    await expect.poll(() => frames(s.state).some((f) => f.method === 'session/prompt')).toBe(true)
    process.kill(s.pid, 'SIGKILL')
    await expect.poll(() => s.exits.length).toBe(1)
    expect(s.exits[0]).not.toBe(0)
    expect(s.events.slice(-2)).toEqual([
      { type: 'error', message: expect.stringContaining('stopped during the turn'), fatal: false },
      { type: 'state_change', state: 'ended' }
    ])
  })

  it('ignores raw bytes', async () => {
    const s = await open()
    const before = s.events.length
    s.adapter.write(s.handle, new TextEncoder().encode('hello\r'))
    await new Promise((r) => setTimeout(r, 100))
    expect(s.events.length).toBe(before)
    expect(frames(s.state).some((f) => f.method === 'session/prompt')).toBe(false)
  })

  it('offers the agent commands under "/"', async () => {
    const s = await open()
    await expect
      .poll(() => s.adapter.commands(s.handle))
      .toEqual([
        { name: 'init', description: expect.any(String), insert: '/init ' },
        { name: 'compact', description: expect.any(String), insert: '/compact ' }
      ])
  })

  it('listSessions returns the agent sessions for a folder', async () => {
    const state = tmp()
    const a = await open({}, { state })
    const b = await open({}, { state })
    const id = (s: Session): string =>
      (s.events.find((e) => e.type === 'session_meta') as { providerSessionId: string })
        .providerSessionId
    const listed = await a.adapter.listSessions(state, {
      command: [process.execPath, STAND_IN, 'acp'],
      env: { ...process.env, ACP_STAND_IN_STATE: state }
    })
    expect(listed.map((s) => s.sessionId).sort()).toEqual([id(a), id(b)].sort())
    expect(listed[0]).toMatchObject({ cwd: state, updatedAt: expect.any(String) })
  })

  it('listSessions stops on a cursor that brings nothing new (OpenCode answers one on every page)', async () => {
    const state = tmp()
    const a = await open({}, { state })
    const listed = await a.adapter.listSessions(state, {
      command: [process.execPath, STAND_IN, 'acp'],
      env: { ...process.env, ACP_STAND_IN_STATE: state, ACP_STAND_IN_LIST_CURSOR: 'always' }
    })
    expect(listed).toHaveLength(1)
    expect(frames(state).filter((f) => f.method === 'session/list')).toHaveLength(2)
  })
})
