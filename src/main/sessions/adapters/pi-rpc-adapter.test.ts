import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PiRpcAdapter, type PiRpcSpawnOptions } from './pi-rpc-adapter'
import type { SessionHandle } from '../adapter'
import type { SessionEvent } from '../../../shared/session-model'

const STAND_IN = resolve(__dirname, '../../../../tests/e2e/fixtures/pi-rpc-agent.mjs')

const dirs: string[] = []
const live: { adapter: PiRpcAdapter; handle: SessionHandle; pid?: number }[] = []
afterEach(async () => {
  for (const { adapter, handle, pid } of live.splice(0)) {
    await adapter.kill(handle).catch(() => {})
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL')
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function childPid(adapter: PiRpcAdapter, handle: SessionHandle): number | undefined {
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
  const dir = mkdtempSync(join(tmpdir(), 'pi-adapter-'))
  dirs.push(dir)
  return dir
}

let sequence = 0
interface Session {
  adapter: PiRpcAdapter
  handle: SessionHandle
  events: SessionEvent[]
  exits: number[]
  state: string
  pid: number
}
async function open(
  options: PiRpcSpawnOptions = {},
  {
    state = tmp(),
    env = {},
    initialPrompt,
    ready = true,
    session
  }: {
    state?: string
    env?: Record<string, string>
    initialPrompt?: string
    ready?: boolean
    /** The command's session flag: a fresh id by default. */
    session?: string[]
  } = {}
): Promise<Session> {
  const adapter = new PiRpcAdapter({ id: 'pi-chat', provider: 'pi', label: 'Pi' })
  const id = `pi-${++sequence}`
  adapter.configure(id, {
    command: [
      process.execPath,
      STAND_IN,
      '--mode',
      'rpc',
      ...(session ?? ['--session-id', randomUUID()]),
      '--session-dir',
      state
    ],
    env: { ...process.env, ...env },
    ...(initialPrompt ? { initialPrompt } : {})
  })
  const handle = await adapter.spawn({
    id,
    provider: 'pi',
    transport: 'events',
    cwd: state,
    windowKey: 'w',
    state: 'idle',
    createdAt: 0,
    adapterId: 'pi-chat',
    title: 'Pi',
    options
  })
  const pid = childPid(adapter, handle)!
  live.push({ adapter, handle, pid })
  const events: SessionEvent[] = []
  const exits: number[] = []
  adapter.on(handle, 'stream', (stream) => {
    if (stream.kind === 'event') events.push(stream.event)
  })
  adapter.on(handle, 'exit', (code) => exits.push(code))
  if (ready) adapter.ready(handle)
  return { adapter, handle, events, exits, state, pid }
}
const frames = (state: string): { type?: string; [key: string]: unknown }[] =>
  existsSync(join(state, 'frames.jsonl'))
    ? readFileSync(join(state, 'frames.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).frame)
    : []
const types = (state: string): (string | undefined)[] => frames(state).map((f) => f.type)
const done = (events: SessionEvent[], from = 0): boolean =>
  events.slice(from).some((e) => e.type === 'state_change' && e.state === 'done')
const notices = (events: SessionEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'error' ? [e.message] : []))

describe('PiRpcAdapter against the stand-in Pi', () => {
  it('spawns: session_meta names the session id and the model as provider/id', async () => {
    const id = randomUUID()
    const s = await open({}, { session: ['--session-id', id] })
    expect(s.events).toEqual([
      { type: 'session_meta', model: 'stand-in/one', providerSessionId: id }
    ])
    expect(types(s.state)).toEqual(['get_state', 'get_commands'])
  })

  it('turns a message into the stream the chat speaks, in order, then the context gauge', async () => {
    const s = await open()
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'user_message', text: 'hello' })
    await expect.poll(() => s.events.some((e) => e.type === 'context_usage')).toBe(true)
    expect(s.events).toEqual([
      { type: 'user_message', text: 'hello' },
      { type: 'state_change', state: 'working' },
      { type: 'assistant_text', delta: 'You said: ', final: false },
      { type: 'assistant_text', delta: 'hello', final: false },
      { type: 'assistant_text', delta: '', final: true },
      { type: 'tool_call', id: 'tc_1', name: 'read', input: { path: 'README.md' } },
      { type: 'tool_result', id: 'tc_1', output: '# Stand-in', error: false },
      { type: 'assistant_text', delta: 'Done.', final: false },
      { type: 'assistant_text', delta: '', final: true },
      { type: 'state_change', state: 'done' },
      { type: 'context_usage', used: 48, window: 200000 }
    ])
    expect(frames(s.state).find((f) => f.type === 'prompt')).toMatchObject({ message: 'hello' })
  })

  it('appends a file attachment to the message as its path', async () => {
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
    const prompt = frames(s.state).find((f) => f.type === 'prompt')
    expect(prompt?.message).toBe('look\nAttached file: /tmp/notes.md')
    expect(prompt && 'images' in prompt).toBe(false)
  })

  it('interrupt on a slow turn: clear_queue, abort, turn_interrupted and done', async () => {
    const s = await open()
    s.adapter.write(s.handle, { type: 'user_message', text: 'be slow' })
    await expect.poll(() => types(s.state).includes('prompt')).toBe(true)
    const started = Date.now()
    s.adapter.write(s.handle, { type: 'interrupt' })
    await expect.poll(() => done(s.events)).toBe(true)
    expect(Date.now() - started).toBeLessThan(3000)
    const sent = types(s.state)
    expect(sent.slice(sent.indexOf('prompt') + 1, sent.indexOf('prompt') + 3)).toEqual([
      'clear_queue',
      'abort'
    ])
    const end = s.events.findIndex((e) => e.type === 'turn_interrupted')
    expect(s.events.slice(end, end + 2)).toEqual([
      { type: 'turn_interrupted' },
      { type: 'state_change', state: 'done' }
    ])
  })

  it('a message during a turn goes as steer and is echoed after', async () => {
    const s = await open({}, { env: { PI_STAND_IN_DELAY_MS: '40' } })
    s.adapter.write(s.handle, { type: 'user_message', text: 'first' })
    await expect.poll(() => s.events.some((e) => e.type === 'assistant_text')).toBe(true)
    s.adapter.write(s.handle, { type: 'user_message', text: 'second' })
    await expect.poll(() => done(s.events), { timeout: 10_000 }).toBe(true)
    const sent = frames(s.state).filter((f) => f.type === 'prompt' || f.type === 'steer')
    expect(sent.map((f) => [f.type, f.message])).toEqual([
      ['prompt', 'first'],
      ['steer', 'second']
    ])
    const said = s.events
      .flatMap((e) => (e.type === 'assistant_text' && e.delta ? [e.delta] : []))
      .join('')
    expect(said).toBe('You said: firstYou said: secondDone.')
    expect(s.events.filter((e) => e.type === 'state_change' && e.state === 'done')).toHaveLength(1)
  })

  it('a message written while a slow turn runs goes as steer', async () => {
    const s = await open()
    s.adapter.write(s.handle, { type: 'user_message', text: 'be slow' })
    await expect.poll(() => s.events.some((e) => e.type === 'state_change')).toBe(true)
    await expect.poll(() => types(s.state).includes('prompt')).toBe(true)
    // Pi's agent_start has come: the run is Pi's own now.
    await new Promise((r) => setTimeout(r, 100))
    s.adapter.write(s.handle, { type: 'user_message', text: 'meanwhile' })
    await expect.poll(() => types(s.state).includes('steer')).toBe(true)
    expect(frames(s.state).find((f) => f.type === 'steer')?.message).toBe('meanwhile')
    expect(frames(s.state).filter((f) => f.type === 'prompt')).toHaveLength(1)
  })

  it('a message written as the turn ends (from its done) goes as prompt, not steer', async () => {
    const s = await open()
    let sent = false
    s.adapter.on(s.handle, 'stream', (stream) => {
      if (sent || stream.kind !== 'event') return
      const e = stream.event
      if (e.type === 'state_change' && e.state === 'done') {
        sent = true
        s.adapter.write(s.handle, { type: 'user_message', text: 'right after' })
      }
    })
    s.adapter.write(s.handle, { type: 'user_message', text: 'first' })
    await expect
      .poll(() => s.events.filter((e) => e.type === 'state_change' && e.state === 'done').length, {
        timeout: 5000
      })
      .toBe(2)
    const sentFrames = frames(s.state).filter((f) => f.type === 'prompt' || f.type === 'steer')
    expect(sentFrames.map((f) => [f.type, f.message])).toEqual([
      ['prompt', 'first'],
      ['prompt', 'right after']
    ])
  })

  it('a prompt Pi refuses as streaming goes once more as steer, and the echo arrives', async () => {
    const s = await open({}, { env: { PI_STAND_IN_STREAMING_ONCE: '1' } })
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'user_message', text: 'hello' })
    await expect.poll(() => done(s.events)).toBe(true)
    const sent = frames(s.state).filter((f) => f.type === 'prompt' || f.type === 'steer')
    expect(sent.map((f) => [f.type, f.message])).toEqual([
      ['prompt', 'hello'],
      ['steer', 'hello']
    ])
    expect(notices(s.events)).toEqual([])
    expect(s.events).toContainEqual({ type: 'assistant_text', delta: 'hello', final: false })
  })

  it('ask extension: the dialog answered cancelled at once, and a notice', async () => {
    const s = await open()
    s.adapter.write(s.handle, { type: 'user_message', text: 'ask extension' })
    await expect.poll(() => done(s.events)).toBe(true)
    expect(frames(s.state).find((f) => f.type === 'extension_ui_response')).toEqual({
      type: 'extension_ui_response',
      id: expect.any(String),
      cancelled: true
    })
    expect(notices(s.events)).toEqual([
      'Pi asked « Proceed? »; answer it in a Pi terminal, this chat cannot yet.'
    ])
    expect(s.events).toContainEqual({
      type: 'assistant_text',
      delta: 'confirm: cancelled. ',
      final: false
    })
  })

  it('notify extension and retry become notices', async () => {
    const s = await open()
    s.adapter.write(s.handle, { type: 'user_message', text: 'notify extension retry' })
    await expect.poll(() => done(s.events)).toBe(true)
    expect(notices(s.events)).toEqual([
      'Pi retries in 1 s (attempt 1 of 3): rate limited',
      'Stand-in notice'
    ])
  })

  it('fail provider: a notice with Pi’s error, then done', async () => {
    const s = await open()
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'user_message', text: 'fail provider' })
    await expect.poll(() => done(s.events)).toBe(true)
    expect(s.events.slice(2, 4)).toEqual([
      { type: 'error', message: 'Pi: Provider refused: stand-in', fatal: false },
      { type: 'state_change', state: 'done' }
    ])
  })

  it('set_model sends set_model and session_meta names the new model', async () => {
    const s = await open()
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'set_model', model: 'stand-in/two' })
    await expect
      .poll(() => s.events.find((e) => e.type === 'session_meta'))
      .toMatchObject({ model: 'stand-in/two' })
    expect(frames(s.state).find((f) => f.type === 'set_model')).toMatchObject({
      provider: 'stand-in',
      modelId: 'two'
    })
  })

  it('a bare model id takes the session’s provider', async () => {
    const s = await open()
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'set_model', model: 'three' })
    await expect
      .poll(() => s.events.find((e) => e.type === 'session_meta'))
      .toMatchObject({ model: 'stand-in/three' })
  })

  it('a spawn with a model sets it after get_state', async () => {
    const s = await open({ model: 'stand-in/three' })
    expect(s.events.filter((e) => e.type === 'session_meta').map((e) => e.model)).toEqual([
      'stand-in/three'
    ])
    const sent = types(s.state)
    expect(sent.indexOf('set_model')).toBeGreaterThan(sent.indexOf('get_state'))
    // The model it already runs is not set again.
    const same = await open({ model: 'stand-in/one' })
    expect(types(same.state)).not.toContain('set_model')
  })

  it('an unlisted model is a notice, and the current one stays', async () => {
    const s = await open({ model: 'other/unknown' })
    expect(notices(s.events)).toEqual([
      'Pi could not switch to other/unknown: Model not found: other/unknown; the session stays on stand-in/one'
    ])
    expect(s.events.find((e) => e.type === 'session_meta')).toMatchObject({
      model: 'stand-in/one'
    })
  })

  it('resumes with --session: history has the past, and no prompt is sent', async () => {
    const state = tmp()
    const id = randomUUID()
    const first = await open({}, { state, session: ['--session-id', id] })
    first.adapter.write(first.handle, { type: 'user_message', text: 'remember me' })
    await expect.poll(() => done(first.events)).toBe(true)
    await first.adapter.kill(first.handle)
    rmSync(join(state, 'frames.jsonl'))

    const second = await open({ resume: id }, { state, session: ['--session', id] })
    expect(second.adapter.history(second.handle).map((item) => item.event)).toEqual([
      { type: 'user_message', text: 'remember me' },
      { type: 'assistant_text', delta: 'You said: remember me', final: true },
      { type: 'tool_call', id: 'tc_1', name: 'read', input: { path: 'README.md' } },
      { type: 'tool_result', id: 'tc_1', output: '# Stand-in', error: false },
      { type: 'assistant_text', delta: 'Done.', final: true }
    ])
    expect(types(state)).toEqual(['get_state', 'get_messages', 'get_commands'])
    expect(second.events.find((e) => e.type === 'session_meta')).toMatchObject({
      providerSessionId: id
    })
    // The past never reaches the live stream.
    expect(second.events.some((e) => e.type === 'user_message')).toBe(false)
  })

  it('a session Pi cannot open: the refusal, ended and exit 1', async () => {
    const s = await open({ resume: 'nope' }, { session: ['--session', 'nope'] })
    await expect.poll(() => s.exits).toEqual([1])
    expect(s.events).toEqual([
      { type: 'error', message: 'Pi could not start: Pi exited with code 1', fatal: false },
      { type: 'state_change', state: 'ended' }
    ])
  })

  it('no model: the notice at spawn, and a prompt that fails with a notice', async () => {
    const s = await open({}, { env: { PI_STAND_IN_NO_MODEL: '1' } })
    expect(s.events).toEqual([
      {
        type: 'error',
        message: 'Pi has no model configured; pick one in Pi (pi --list-models) or in the profile.',
        fatal: false
      },
      { type: 'session_meta', model: null, providerSessionId: expect.any(String) }
    ])
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'user_message', text: 'hi' })
    await expect.poll(() => done(s.events)).toBe(true)
    expect(s.events).toEqual([
      { type: 'user_message', text: 'hi' },
      { type: 'state_change', state: 'working' },
      { type: 'error', message: 'Pi: No model selected', fatal: false },
      { type: 'state_change', state: 'done' }
    ])
  })

  it('set_effort: a level Pi offers is set, another is a notice; levels asked once', async () => {
    const s = await open()
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'set_effort', effort: 'max' })
    await expect.poll(() => types(s.state).includes('set_thinking_level')).toBe(true)
    s.adapter.write(s.handle, { type: 'set_effort', effort: 'medium' })
    await expect
      .poll(() => notices(s.events))
      .toEqual(['Pi does not offer the thinking level medium (it offers low, high, max)'])
    expect(frames(s.state).filter((f) => f.type === 'set_thinking_level')).toEqual([
      { id: expect.any(String), type: 'set_thinking_level', level: 'max' }
    ])
    expect(types(s.state).filter((t) => t === 'get_available_thinking_levels')).toHaveLength(1)
    expect(s.events.filter((e) => e.type !== 'error')).toEqual([])
  })

  it('sends the launch prompt once, at ready', async () => {
    const s = await open({}, { initialPrompt: 'first words', ready: false })
    expect(types(s.state)).not.toContain('prompt')
    s.adapter.ready(s.handle)
    s.adapter.ready(s.handle)
    await expect.poll(() => done(s.events)).toBe(true)
    const prompts = frames(s.state).filter((f) => f.type === 'prompt')
    expect(prompts.map((f) => f.message)).toEqual(['first words'])
  })

  it('kill ends the child', async () => {
    const s = await open()
    expect(alive(s.pid)).toBe(true)
    await s.adapter.kill(s.handle)
    expect(alive(s.pid)).toBe(false)
    expect(() => s.adapter.history(s.handle)).toThrow('Unknown Pi session')
  })

  it('kill during a turn aborts it first', async () => {
    const s = await open()
    s.adapter.write(s.handle, { type: 'user_message', text: 'be slow' })
    await expect.poll(() => types(s.state).includes('prompt')).toBe(true)
    const started = Date.now()
    await s.adapter.kill(s.handle)
    expect(Date.now() - started).toBeLessThan(3000)
    expect(types(s.state)).toContain('abort')
    expect(alive(s.pid)).toBe(false)
  })

  it('the child dying mid-turn ends the chat with exit and ended', async () => {
    const s = await open()
    s.adapter.write(s.handle, { type: 'user_message', text: 'be slow' })
    await expect.poll(() => types(s.state).includes('prompt')).toBe(true)
    process.kill(s.pid, 'SIGKILL')
    await expect.poll(() => s.exits.length).toBe(1)
    expect(s.exits[0]).not.toBe(0)
    expect(s.events.slice(-2)).toEqual([
      { type: 'error', message: expect.stringContaining('stopped during the turn'), fatal: false },
      { type: 'state_change', state: 'ended' }
    ])
    expect(() => s.adapter.write(s.handle, { type: 'user_message', text: 'x' })).toThrow(
      'Pi session has ended'
    )
  })

  it('ignores raw bytes, and a permission response', async () => {
    const s = await open()
    const before = s.events.length
    s.adapter.write(s.handle, new TextEncoder().encode('hello\r'))
    s.adapter.write(s.handle, { type: 'permission_response', id: 'x', optionId: 'allow' })
    await new Promise((r) => setTimeout(r, 100))
    expect(s.events.length).toBe(before)
    expect(types(s.state)).toEqual(['get_state', 'get_commands'])
  })

  it('offers Pi’s commands under "/"', async () => {
    const s = await open()
    await expect(s.adapter.commands(s.handle)).resolves.toEqual([
      { name: 'init', description: expect.any(String), insert: '/init ' },
      { name: 'compact', description: expect.any(String), insert: '/compact ' }
    ])
  })
})
