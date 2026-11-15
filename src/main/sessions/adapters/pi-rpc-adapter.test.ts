import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PiRpcAdapter, piModelOptions, type PiRpcSpawnOptions } from './pi-rpc-adapter'
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
    session,
    connection
  }: {
    state?: string
    env?: Record<string, string>
    initialPrompt?: string
    ready?: boolean
    /** The command's session flag: a fresh id by default. */
    session?: string[]
    /** The stored connection the chat runs on (PRDCT-4496). */
    connection?: { provider: string; variables: string[] }
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
    ...(initialPrompt ? { initialPrompt } : {}),
    ...(connection ? { connection } : {})
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
/** The notices marked quiet: nothing failed (PRDCT-4566). */
const quietNotices = (events: SessionEvent[]): string[] =>
  events.flatMap((e) => (e.type === 'error' && e.quiet ? [e.message] : []))

describe('piModelOptions (PRDCT-4427)', () => {
  it('reads a real pi --mode rpc 1.5.2 get_available_models answer on a connection', () => {
    // As Pi 1.5.2 answered it under a connection's agent directory (a
    // made-up key); each Model object is cut to the fields Pi always sends.
    const model = (
      id: string,
      name: string,
      thinkingLevelMap: Record<string, string | null>
    ): Record<string, unknown> => ({
      id,
      name,
      api: 'openai-completions',
      provider: 'kimi-coding',
      baseUrl: 'https://api.kimi.com/coding/v1',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 32768,
      compat: { supportsReasoningEffort: true, maxTokensField: 'max_tokens' },
      thinkingLevelMap,
      inputLimits: { images: { resize: { maxWidth: 2000, maxHeight: 2000 } } },
      type: 'chat'
    })
    const levels = {
      off: null,
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max'
    }
    const data = {
      models: [
        model('k3', 'Kimi K3', levels),
        model('k3-256k', 'Kimi K3-256K', levels),
        model('k3.1-pro', 'Kimi K3.1 Pro', levels),
        model('k3.1-pro-highspeed', 'Kimi K3.1 Pro Highspeed', levels),
        model('kimi-for-coding', 'kimi-for-coding', levels),
        model('kimi-for-coding-highspeed', 'Kimi For Coding HighSpeed', { off: null })
      ]
    }
    expect(piModelOptions(data)).toEqual([
      { id: 'kimi-coding/k3', label: 'Kimi K3' },
      { id: 'kimi-coding/k3-256k', label: 'Kimi K3-256K' },
      { id: 'kimi-coding/k3.1-pro', label: 'Kimi K3.1 Pro' },
      { id: 'kimi-coding/k3.1-pro-highspeed', label: 'Kimi K3.1 Pro Highspeed' },
      { id: 'kimi-coding/kimi-for-coding', label: 'kimi-for-coding' },
      { id: 'kimi-coding/kimi-for-coding-highspeed', label: 'Kimi For Coding HighSpeed' }
    ])
  })

  it('skips a model with no id, a repeat, and an answer with no list', () => {
    expect(
      piModelOptions({
        models: [{ name: 'Nameless' }, { id: 'a', provider: 'p' }, { id: 'a', provider: 'p' }]
      })
    ).toEqual([{ id: 'p/a', label: 'a' }])
    expect(piModelOptions(undefined)).toEqual([])
  })
})

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

  // Verifier round 1, gap (mutation 27): Pi's run settled while the steer was
  // on its way; Pi answers it queued and starts nothing (PI_STAND_IN_IDLE_STEER).
  // Verifier 3, finding 13: Pi holds that steer for its next run, so the
  // prompt sent after it made Pi take the message twice (PRDCT-4566).
  it('a steer Pi answers queued while idle, with no run starting, goes once more as prompt once out of Pi’s queue: Pi takes it once', async () => {
    const s = await open({}, { env: { PI_STAND_IN_IDLE_STEER: 'queue' } })
    await expect.poll(() => types(s.state).includes('get_commands')).toBe(true)
    const internal = (
      s.adapter as unknown as {
        handles: Map<
          string,
          {
            runActive: boolean
            connection: { command: (type: string, ...rest: unknown[]) => Promise<unknown> }
          }
        >
      }
    ).handles.get(s.handle.id)!
    // The adapter still reads Pi's run as going: the message goes as a steer,
    // and Pi's agent_settled lands before the steer's answer.
    internal.runActive = true
    const command = internal.connection.command.bind(internal.connection)
    internal.connection.command = (type, ...rest) => {
      if (type === 'steer') internal.runActive = false
      return command(type, ...rest)
    }
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'user_message', text: 'hello' })
    await expect.poll(() => done(s.events), { timeout: 3000 }).toBe(true)
    // Pi took it once: one answer, under the one message drawn.
    const said = s.events
      .flatMap((e) => (e.type === 'assistant_text' && e.delta ? [e.delta] : []))
      .join('')
    expect(said).toBe('You said: helloDone.')
    expect(s.events.filter((e) => e.type === 'user_message')).toEqual([
      { type: 'user_message', text: 'hello' }
    ])
    const sent = frames(s.state).filter(
      (f) => f.type === 'prompt' || f.type === 'steer' || f.type === 'clear_queue'
    )
    expect(sent.map((f) => [f.type, f.message])).toEqual([
      ['steer', 'hello'],
      ['clear_queue', undefined],
      ['prompt', 'hello']
    ])
    expect(notices(s.events)).toEqual([])
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

  it('models() lists what Pi offers as provider/id, by name; a pick switches (PRDCT-4427)', async () => {
    const s = await open()
    expect(await s.adapter.models(s.handle)).toEqual([
      { id: 'stand-in/one', label: 'Stand-in one' },
      { id: 'stand-in/two', label: 'Stand-in two' },
      { id: 'stand-in/three', label: 'Stand-in three' }
    ])
    // Asked once for the session.
    await s.adapter.models(s.handle)
    expect(frames(s.state).filter((f) => f.type === 'get_available_models')).toHaveLength(1)
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'set_model', model: 'stand-in/three' })
    await expect
      .poll(() => s.events.find((e) => e.type === 'session_meta'))
      .toMatchObject({ model: 'stand-in/three' })
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

  // PRDCT-4427: Pi 1.5.2 keeps a name it does not have as a custom model id
  // and get_state names it as asked: only its list tells.
  it('a model name Pi keeps as a custom id: said once, kept in the past', async () => {
    const s = await open(
      { model: 'no-such-model-zz' },
      {
        env: { PI_STAND_IN_ANY_PROVIDER: '1' },
        session: [
          '--session-id',
          randomUUID(),
          '--provider',
          'kimi-coding',
          '--model',
          'no-such-model-zz'
        ]
      }
    )
    const said =
      'Pi does not know the model no-such-model-zz of kimi-coding: it sends that name to the provider as it is, and the provider may refuse it.'
    await expect.poll(() => notices(s.events)).toEqual([said])
    expect(s.adapter.history(s.handle).map((item) => item.event)).toEqual([
      { type: 'error', message: said, fatal: false }
    ])
    // A model Pi lists for that provider: nothing said.
    const known = await open(
      { model: 'k-first' },
      {
        env: { PI_STAND_IN_ANY_PROVIDER: '1' },
        session: ['--session-id', randomUUID(), '--provider', 'kimi-coding', '--model', 'k-first']
      }
    )
    await expect.poll(() => types(known.state)).toContain('get_available_models')
    expect(notices(known.events)).toEqual([])
  })

  // The verifier's F1 (PRDCT-4496): real Pi 1.5.2 lists every provider it
  // finds a credential for and switches to any of them. A chat on a stored
  // connection offers, accepts and runs on that connection's provider alone.
  // The stand-in lists Anthropic's model while ANTHROPIC_API_KEY (made up) is
  // in its environment, as Pi does; the connection's provider here is the
  // stand-in's own.
  describe('a chat on a stored connection stays on its provider (PRDCT-4496)', () => {
    const OTHER = { PI_STAND_IN_ENV_PROVIDERS: '1', ANTHROPIC_API_KEY: 'made-up-other-0001' }
    const ON_STAND_IN = { provider: 'stand-in', variables: [] }
    const metaModels = (events: SessionEvent[]): (string | null)[] =>
      events.flatMap((e) => (e.type === 'session_meta' ? [e.model] : []))

    it('models() lists the connection’s provider alone; on no connection, all Pi offers', async () => {
      const free = await open({}, { env: OTHER })
      expect((await free.adapter.models(free.handle)).map((m) => m.id)).toEqual([
        'stand-in/one',
        'stand-in/two',
        'stand-in/three',
        'anthropic/claude-stand-in'
      ])
      const s = await open({}, { env: OTHER, connection: ON_STAND_IN })
      expect((await s.adapter.models(s.handle)).map((m) => m.id)).toEqual([
        'stand-in/one',
        'stand-in/two',
        'stand-in/three'
      ])
    })

    it('a pick of another provider’s model is refused in one sentence, and Pi is never asked', async () => {
      const s = await open({}, { env: OTHER, connection: ON_STAND_IN })
      s.events.length = 0
      s.adapter.write(s.handle, { type: 'set_model', model: 'anthropic/claude-stand-in' })
      await expect
        .poll(() => notices(s.events))
        .toEqual([
          'Pi stays on stand-in/one: this chat runs on its connection, whose provider is stand-in, and anthropic/claude-stand-in is not one of its models.'
        ])
      await expect.poll(() => metaModels(s.events)).toEqual(['stand-in/one'])
      expect(frames(s.state).filter((f) => f.type === 'set_model')).toEqual([])
      // A model of the connection's provider still switches.
      s.adapter.write(s.handle, { type: 'set_model', model: 'two' })
      await expect.poll(() => metaModels(s.events)).toContain('stand-in/two')
    })

    it('Pi on another provider’s model at start (a resume) is put back on the connection’s, and said', async () => {
      const s = await open(
        {},
        {
          env: OTHER,
          connection: ON_STAND_IN,
          session: ['--session-id', randomUUID(), '--model', 'anthropic/claude-stand-in']
        }
      )
      const said =
        "Pi was on anthropic/claude-stand-in, which is not a model of its connection's provider stand-in: the chat put it back on stand-in/one."
      await expect.poll(() => notices(s.events)).toEqual([said])
      expect(metaModels(s.events)).toEqual(['stand-in/one', 'stand-in/one'])
      expect(frames(s.state).find((f) => f.type === 'set_model')).toMatchObject({
        provider: 'stand-in',
        modelId: 'one'
      })
    })

    it('a model moved off the connection during a run is put back before the next prompt goes', async () => {
      const s = await open({}, { env: OTHER, connection: ON_STAND_IN })
      s.adapter.write(s.handle, { type: 'set_model', model: 'stand-in/two' })
      await expect.poll(() => metaModels(s.events)).toContain('stand-in/two')
      s.adapter.write(s.handle, { type: 'user_message', text: 'use anthropic now' })
      await expect.poll(() => done(s.events)).toBe(true)
      const from = s.events.length
      s.adapter.write(s.handle, { type: 'user_message', text: 'and now?' })
      await expect.poll(() => done(s.events, from)).toBe(true)
      const sent = frames(s.state)
      const last = sent.map((f) => f.type).lastIndexOf('prompt')
      const asked = sent.map((f) => f.type).lastIndexOf('get_state')
      const back = sent.map((f) => f.type).lastIndexOf('set_model')
      // Pi's model read, then set_model back on the last connection model,
      // then the prompt.
      expect(sent[last]).toMatchObject({ type: 'prompt', message: 'and now?' })
      expect(sent[back]).toMatchObject({ provider: 'stand-in', modelId: 'two' })
      expect(asked).toBeLessThan(back)
      expect(back).toBeLessThan(last)
      expect(sent.slice(sent.map((f) => f.type).indexOf('prompt') + 1, asked)).not.toContainEqual(
        expect.objectContaining({ type: 'set_model' })
      )
      expect(notices(s.events)).toContain(
        "Pi was on anthropic/claude-stand-in, which is not a model of its connection's provider stand-in: the chat put it back on stand-in/two."
      )
      expect(metaModels(s.events)).not.toContain('anthropic/claude-stand-in')
    })

    it('Pi that cannot be put back: one sentence, and the turn ends with nothing sent', async () => {
      const s = await open(
        {},
        {
          env: OTHER,
          // A provider the stand-in has no model of.
          connection: { provider: 'kimi-coding', variables: [] },
          session: ['--session-id', randomUUID(), '--model', 'anthropic/claude-stand-in']
        }
      )
      const said =
        "Pi is on anthropic/claude-stand-in, which is not a model of its connection's provider kimi-coding, and could not be put back on one: nothing was sent."
      await expect.poll(() => notices(s.events)).toEqual([said])
      // The chat never names the other provider's model as the one it runs on.
      expect(metaModels(s.events)).toEqual([null])
      const from = s.events.length
      s.adapter.write(s.handle, { type: 'user_message', text: 'hello' })
      await expect.poll(() => done(s.events, from)).toBe(true)
      expect(notices(s.events.slice(from))).toEqual([said])
      expect(types(s.state)).not.toContain('prompt')
    })

    // Verifier round 2, R2-1 (PRDCT-4427): a steer and a re-sent prompt skipped
    // the check, so a message went on another provider's key. Real Pi 1.5.2
    // takes set_model during a run, so the put-back happens mid-run too.
    type Internal = {
      runActive: boolean
      connection: { command: (type: string, ...rest: unknown[]) => Promise<unknown> }
    }
    const internalOf = (s: Session): Internal =>
      (s.adapter as unknown as { handles: Map<string, Internal> }).handles.get(s.handle.id)!
    // The commands sent, but the models list (asked once, at the first look).
    const commandsOf = (sent: { type?: string }[]): (string | undefined)[] =>
      sent.map((f) => f.type).filter((type) => type !== 'get_available_models')
    const BACK =
      "Pi was on anthropic/claude-stand-in, which is not a model of its connection's provider stand-in: the chat put it back on stand-in/one."

    it('a model moved off the connection during a run is put back before a steer goes', async () => {
      const s = await open(
        {},
        { env: { ...OTHER, PI_STAND_IN_DELAY_MS: '40' }, connection: ON_STAND_IN }
      )
      s.adapter.write(s.handle, { type: 'user_message', text: 'use anthropic now' })
      await expect.poll(() => s.events.some((e) => e.type === 'assistant_text')).toBe(true)
      s.adapter.write(s.handle, { type: 'user_message', text: 'second' })
      await expect.poll(() => done(s.events), { timeout: 10_000 }).toBe(true)
      const sent = frames(s.state)
      const kinds = sent.map((f) => f.type)
      const steer = kinds.indexOf('steer')
      expect(sent[steer]).toMatchObject({ type: 'steer', message: 'second' })
      const between = sent.slice(kinds.indexOf('prompt') + 1, steer)
      // Pi's model read, then set back on the connection's, then the steer.
      expect(commandsOf(between)).toEqual(['get_state', 'set_model'])
      expect(between.find((f) => f.type === 'set_model')).toMatchObject({
        provider: 'stand-in',
        modelId: 'one'
      })
      expect(notices(s.events)).toEqual([BACK])
      expect(metaModels(s.events)).not.toContain('anthropic/claude-stand-in')
    })

    it('a model moved off the connection before a steer is re-sent as a prompt is put back first', async () => {
      const s = await open(
        {},
        { env: { ...OTHER, PI_STAND_IN_IDLE_STEER: 'queue' }, connection: ON_STAND_IN }
      )
      await expect.poll(() => types(s.state).includes('get_commands')).toBe(true)
      const internal = internalOf(s)
      // The adapter reads a run as going, so the message goes as a steer;
      // Pi's run settles and its model moves before the steer's answer.
      internal.runActive = true
      const command = internal.connection.command.bind(internal.connection)
      internal.connection.command = async (type, ...rest) => {
        if (type === 'steer') {
          internal.runActive = false
          await command('set_model', { provider: 'anthropic', modelId: 'claude-stand-in' })
        }
        return command(type, ...rest)
      }
      s.events.length = 0
      s.adapter.write(s.handle, { type: 'user_message', text: 'hello' })
      await expect.poll(() => done(s.events), { timeout: 3000 }).toBe(true)
      const sent = frames(s.state)
      const kinds = sent.map((f) => f.type)
      const prompt = kinds.lastIndexOf('prompt')
      expect(sent[prompt]).toMatchObject({ type: 'prompt', message: 'hello' })
      const between = sent.slice(kinds.indexOf('steer') + 1, prompt)
      // Out of Pi's queue first, so that Pi takes it once (PRDCT-4566).
      expect(commandsOf(between)).toEqual(['clear_queue', 'get_state', 'set_model'])
      expect(between.find((f) => f.type === 'set_model')).toMatchObject({
        provider: 'stand-in',
        modelId: 'one'
      })
      expect(notices(s.events)).toEqual([BACK])
    })

    it('a steer while Pi refuses to be put back mid-run: one sentence, nothing sent, the run ends its turn', async () => {
      const s = await open(
        {},
        { env: { ...OTHER, PI_STAND_IN_DELAY_MS: '40' }, connection: ON_STAND_IN }
      )
      s.adapter.write(s.handle, { type: 'user_message', text: 'use anthropic now' })
      await expect.poll(() => s.events.some((e) => e.type === 'assistant_text')).toBe(true)
      const internal = internalOf(s)
      const command = internal.connection.command.bind(internal.connection)
      internal.connection.command = (type, ...rest) =>
        type === 'set_model' && internal.runActive
          ? Promise.reject(new Error('Agent is streaming'))
          : command(type, ...rest)
      s.adapter.write(s.handle, { type: 'user_message', text: 'second' })
      await expect.poll(() => done(s.events), { timeout: 10_000 }).toBe(true)
      expect(types(s.state)).not.toContain('steer')
      expect(notices(s.events)).toEqual([
        "Pi is on anthropic/claude-stand-in, which is not a model of its connection's provider stand-in, and could not be put back on one: nothing was sent."
      ])
      // Nothing was sent: the message that waited goes back to the composer,
      // and is never drawn as taken (PRDCT-4566).
      expect(s.events).toContainEqual({
        type: 'waiting_messages',
        messages: [],
        takes: 'step',
        returned: { why: 'refused', messages: [{ id: expect.any(String), text: 'second' }] }
      })
      expect(s.events.some((e) => e.type === 'user_message' && e.text === 'second')).toBe(false)
      // The run goes on to its end, and its done is the turn's only one.
      await expect
        .poll(() => s.events.some((e) => e.type === 'assistant_text' && e.delta === 'Done.'), {
          timeout: 10_000
        })
        .toBe(true)
      await new Promise((r) => setTimeout(r, 300))
      expect(s.events.filter((e) => e.type === 'state_change' && e.state === 'done')).toHaveLength(
        1
      )
    })

    // Pi not on the launch's PATH is started through the login shell, whose
    // profile may export the connection's own variable: the stored value
    // crosses it under a private name and reaches Pi under its own.
    it.skipIf(!existsSync('/bin/zsh'))(
      'through the login shell, Pi gets the stored key over a profile’s, and no private name',
      async () => {
        const home = tmp()
        const bin = join(home, 'bin')
        mkdirSync(bin)
        const seen = join(home, 'seen.json')
        // The program only the profile's PATH finds: it writes what it was
        // handed (booleans, never a value), then runs the stand-in.
        writeFileSync(
          join(bin, 'pi-behind-profile'),
          `#!/bin/sh\n${JSON.stringify(process.execPath)} -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({ stored: process.env.KIMI_API_KEY === "made-up-stored-0001", privateLeft: Object.keys(process.env).some((n) => n.startsWith("CLAVE_TAB_CREDENTIAL_")) }))' ${JSON.stringify(seen)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(STAND_IN)} "$@"\n`,
          { mode: 0o755 }
        )
        writeFileSync(
          join(home, '.zshenv'),
          `export PATH=${JSON.stringify(`${bin}:/usr/bin:/bin`)}\nexport KIMI_API_KEY='made-up-profile-0002'\n`
        )
        const adapter = new PiRpcAdapter({ id: 'pi-chat', provider: 'pi', label: 'Pi' })
        const id = `pi-${++sequence}`
        adapter.configure(id, {
          command: ['pi-behind-profile', '--mode', 'rpc', '--session-dir', home],
          env: {
            PATH: '/usr/bin:/bin',
            HOME: home,
            ZDOTDIR: home,
            SHELL: '/bin/zsh',
            KIMI_API_KEY: 'made-up-stored-0001'
          },
          connection: { provider: 'stand-in', variables: ['KIMI_API_KEY'] }
        })
        const handle = await adapter.spawn({
          id,
          provider: 'pi',
          transport: 'events',
          cwd: home,
          windowKey: 'w',
          state: 'idle',
          createdAt: 0,
          adapterId: 'pi-chat',
          title: 'Pi',
          options: {}
        })
        live.push({ adapter, handle, pid: childPid(adapter, handle) })
        await expect.poll(() => existsSync(seen)).toBe(true)
        expect(JSON.parse(readFileSync(seen, 'utf8'))).toEqual({
          stored: true,
          privateLeft: false
        })
      }
    )

    it('on no connection, a model Pi moves to is left alone and nothing is read before a prompt', async () => {
      const s = await open({}, { env: OTHER })
      s.adapter.write(s.handle, { type: 'user_message', text: 'use anthropic now' })
      await expect.poll(() => done(s.events)).toBe(true)
      const before = frames(s.state).length
      const from = s.events.length
      s.adapter.write(s.handle, { type: 'user_message', text: 'again' })
      await expect.poll(() => done(s.events, from)).toBe(true)
      expect(frames(s.state).slice(before)[0]).toMatchObject({ type: 'prompt' })
      expect(notices(s.events)).toEqual([])
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

  it('a session Pi cannot open: the refusal in its own words, ended and exit 1', async () => {
    const s = await open({ resume: 'nope' }, { session: ['--session', 'nope'] })
    await expect.poll(() => s.exits).toEqual([1])
    const refusal = {
      type: 'error',
      message: 'Pi could not start: Session not found: nope (exit status 1)',
      fatal: false
    }
    expect(s.events).toEqual([refusal, { type: 'state_change', state: 'ended' }])
    // Kept in the past too, for a pane that subscribes after it was said.
    expect(s.adapter.history(s.handle).map((item) => item.event)).toEqual([refusal])
  })

  it('a Pi that prints a line and exits 1 before it speaks: that line and the status, never its environment', async () => {
    const secret = 'made-up-key-value-0001'
    const adapter = new PiRpcAdapter({ id: 'pi-chat', provider: 'pi', label: 'Pi' })
    const id = `pi-${++sequence}`
    // A stand-in for Pi 1.5.2's own refusal (`--provider` without `--model`),
    // which also prints the key it was handed to show it never reaches the
    // reader.
    adapter.configure(id, {
      command: [
        process.execPath,
        '-e',
        'process.stderr.write("\\u001b[31mError: --provider requires --model\\u001b[0m (key " + process.env.KIMI_API_KEY + ")\\n"); process.exit(1)'
      ],
      env: { ...process.env, KIMI_API_KEY: secret, PI_CODING_AGENT_DIR: '/made-up/dir' }
    })
    const handle = await adapter.spawn({
      id,
      provider: 'pi',
      transport: 'events',
      cwd: tmp(),
      windowKey: 'w',
      state: 'idle',
      createdAt: 0,
      adapterId: 'pi-chat',
      title: 'Pi',
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
    const message =
      'Pi could not start: Error: --provider requires --model (key ‹hidden›) (exit status 1)'
    expect(notices(events)).toEqual([message])
    expect(JSON.stringify(events)).not.toContain(secret)
    expect(adapter.history(handle).map((item) => item.event)).toEqual([
      { type: 'error', message, fatal: false }
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

describe('a message written while Pi works waits until Pi takes it (PRDCT-4566)', () => {
  /** The conversation as it reads: each message with all that was said after
   *  it until the next one. */
  const readings = (events: SessionEvent[]): { message: string; said: string }[] => {
    const out: { message: string; said: string }[] = []
    for (const e of events) {
      if (e.type === 'user_message') out.push({ message: e.text, said: '' })
      else if (e.type === 'assistant_text' && out.length) out[out.length - 1].said += e.delta
    }
    return out
  }
  type Waiting = Extract<SessionEvent, { type: 'waiting_messages' }>
  const lists = (events: SessionEvent[]): Waiting[] =>
    events.flatMap((e) => (e.type === 'waiting_messages' ? [e] : []))
  const texts = (list: Waiting | undefined): string[] => (list?.messages ?? []).map((m) => m.text)
  const sent = (state: string): string[][] =>
    frames(state)
      .filter((f) => f.type === 'prompt' || f.type === 'steer')
      .map((f) => [String(f.type), String(f.message)])
  const steered = (state: string): number => types(state).filter((t) => t === 'steer').length

  it('three messages written during one run: each enters the conversation as Pi takes it, its answer under it', async () => {
    const s = await open()
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'user_message', text: 'a long turn' })
    await expect.poll(() => s.events.some((e) => e.type === 'assistant_text')).toBe(true)
    s.adapter.write(s.handle, { type: 'user_message', text: 'second' })
    s.adapter.write(s.handle, { type: 'user_message', text: 'third' })
    // The run's text still streams: the two others wait outside the conversation.
    expect(readings(s.events).map((r) => r.message)).toEqual(['a long turn'])
    expect(texts(lists(s.events).at(-1))).toEqual(['second', 'third'])
    expect(lists(s.events).at(-1)?.takes).toBe('step')
    await expect.poll(() => done(s.events), { timeout: 10_000 }).toBe(true)
    expect(readings(s.events)).toEqual([
      { message: 'a long turn', said: 'You said: a long turn' },
      { message: 'second', said: 'You said: second' },
      { message: 'third', said: 'You said: thirdDone.' }
    ])
    expect(lists(s.events).map(texts)).toEqual([['second'], ['second', 'third'], ['third'], []])
    expect(sent(s.state)).toEqual([
      ['prompt', 'a long turn'],
      ['steer', 'second'],
      ['steer', 'third']
    ])
  })

  // Verifier 3, finding 1: Pi answers a prompt before its agent_start, in a
  // write of its own, so the second of two messages written together goes as
  // a prompt Pi refuses, then as a steer it takes at its next step. Drawn as
  // the prompt was chosen, it stood above the first answer.
  it('two messages written in the same tick: the second enters as Pi takes it, after the first answer', async () => {
    const s = await open()
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'user_message', text: 'first question' })
    s.adapter.write(s.handle, { type: 'user_message', text: 'second question' })
    expect(readings(s.events).map((r) => r.message)).toEqual(['first question'])
    expect(texts(lists(s.events).at(-1))).toEqual(['second question'])
    await expect.poll(() => done(s.events), { timeout: 10_000 }).toBe(true)
    expect(readings(s.events)).toEqual([
      { message: 'first question', said: 'You said: first question' },
      { message: 'second question', said: 'You said: second questionDone.' }
    ])
    // Whatever went first, Pi took the second as a steer, once.
    const second = sent(s.state).filter(([, message]) => message === 'second question')
    expect(second.at(-1)).toEqual(['steer', 'second question'])
    expect(s.events.filter((e) => e.type === 'user_message')).toHaveLength(2)
  })

  it('a withdrawn steer leaves Pi’s queue, the rest steered again in order, and Pi never takes it', async () => {
    const s = await open()
    s.adapter.write(s.handle, { type: 'user_message', text: 'a long turn' })
    await expect.poll(() => s.events.some((e) => e.type === 'assistant_text')).toBe(true)
    s.adapter.write(s.handle, { type: 'user_message', text: 'second' })
    s.adapter.write(s.handle, { type: 'user_message', text: 'third' })
    await expect.poll(() => steered(s.state)).toBe(2)
    const second = lists(s.events).at(-1)!.messages[0]
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'withdraw_message', id: second.id })
    // Handed back once Pi's clear_queue answer says Pi still held it.
    await expect
      .poll(() => lists(s.events).find((list) => list.returned))
      .toEqual({
        type: 'waiting_messages',
        messages: [{ id: expect.any(String), text: 'third' }],
        takes: 'step',
        returned: { why: 'withdrawn', messages: [second] }
      })
    await expect.poll(() => done(s.events), { timeout: 10_000 }).toBe(true)
    const after = types(s.state).slice(types(s.state).lastIndexOf('steer') - 2)
    expect(after.slice(0, 3)).toEqual(['steer', 'clear_queue', 'steer'])
    expect(sent(s.state).slice(-1)).toEqual([['steer', 'third']])
    expect(readings(s.events).map((r) => r.message)).toEqual(['third'])
    expect(readings(s.events)[0].said).toBe('You said: thirdDone.')
  })

  // Verifier 3, finding 6 (M12): the order of the steers sent again.
  it('a withdrawn middle steer: the two others are steered again in the order written, and Pi takes them so', async () => {
    const s = await open()
    s.adapter.write(s.handle, { type: 'user_message', text: 'a long turn' })
    await expect.poll(() => s.events.some((e) => e.type === 'assistant_text')).toBe(true)
    for (const text of ['second', 'third', 'fourth'])
      s.adapter.write(s.handle, { type: 'user_message', text })
    await expect.poll(() => steered(s.state)).toBe(3)
    const third = lists(s.events).at(-1)!.messages[1]
    expect(third.text).toBe('third')
    s.adapter.write(s.handle, { type: 'withdraw_message', id: third.id })
    await expect.poll(() => done(s.events), { timeout: 10_000 }).toBe(true)
    const all = frames(s.state)
    const clear = all.map((f) => f.type).lastIndexOf('clear_queue')
    expect(
      all
        .slice(clear + 1)
        .filter((f) => f.type === 'prompt' || f.type === 'steer')
        .map((f) => [f.type, f.message])
    ).toEqual([
      ['steer', 'second'],
      ['steer', 'fourth']
    ])
    expect(readings(s.events).map((r) => r.message)).toEqual(['a long turn', 'second', 'fourth'])
  })

  // Verifier 3, findings 2 and 7 (M14): Pi takes the steer at its step while
  // the withdraw's clear_queue is on its way, and answers without it.
  it('a withdrawn steer Pi takes before it answers the clear_queue is drawn as taken, never handed back', async () => {
    const s = await open({}, { env: { PI_STAND_IN_CLEAR_AFTER_STEP: '1' } })
    s.adapter.write(s.handle, { type: 'user_message', text: 'a long turn' })
    await expect.poll(() => s.events.some((e) => e.type === 'assistant_text')).toBe(true)
    s.adapter.write(s.handle, { type: 'user_message', text: 'second' })
    s.adapter.write(s.handle, { type: 'user_message', text: 'third' })
    await expect.poll(() => steered(s.state)).toBe(2)
    const second = lists(s.events).at(-1)!.messages[0]
    s.adapter.write(s.handle, { type: 'withdraw_message', id: second.id })
    await expect
      .poll(() => readings(s.events).map((r) => r.message), { timeout: 15_000 })
      .toEqual(['a long turn', 'second', 'third'])
    await expect
      .poll(() => s.events.filter((e) => e.type === 'state_change' && e.state === 'done').length, {
        timeout: 15_000
      })
      .toBeGreaterThan(0)
    // Nothing went back to the composer: Pi took it, and each answer is
    // drawn under its own message.
    expect(lists(s.events).filter((list) => list.returned)).toEqual([])
    for (const { message, said } of readings(s.events))
      expect(said.startsWith(`You said: ${message}`)).toBe(true)
    // The one Pi still held went again, once (a steer, or a prompt once the
    // run had ended).
    const all = frames(s.state)
    const clear = all.map((f) => f.type).lastIndexOf('clear_queue')
    expect(
      all
        .slice(clear + 1)
        .filter((f) => f.type === 'prompt' || f.type === 'steer')
        .map((f) => f.message)
    ).toEqual(['third'])
  })

  // The verifier's closing look, finding 3 (its M14a): Pi's own window. Pi's
  // loop takes a steer off its queue at the step's end, and the list its
  // clear_queue answer reads loses it only when its user message starts
  // (PI_STAND_IN_DRAIN_GAP_MS): a withdraw landing in between hands the
  // message back, and Pi starts it anyway. It is the conversation's then:
  // drawn when Pi starts it, its answer under it.
  it('a steer handed back that Pi starts anyway is drawn when Pi starts it, its answer under it', async () => {
    const s = await open(
      {},
      { env: { PI_STAND_IN_DRAIN_GAP_MS: '600', PI_STAND_IN_LONG_TURN_MS: '300' } }
    )
    s.adapter.write(s.handle, { type: 'user_message', text: 'a long turn' })
    await expect.poll(() => s.events.some((e) => e.type === 'assistant_text')).toBe(true)
    s.adapter.write(s.handle, { type: 'user_message', text: 'second' })
    await expect.poll(() => steered(s.state)).toBe(1)
    const second = lists(s.events).at(-1)!.messages[0]
    expect(second.text).toBe('second')
    // Withdrawn the moment the run's step ends (its tool's result), as Pi's
    // loop takes the steer off its queue.
    let withdrawn = false
    s.adapter.on(s.handle, 'stream', (stream) => {
      if (withdrawn || stream.kind !== 'event' || stream.event.type !== 'tool_result') return
      withdrawn = true
      s.adapter.write(s.handle, { type: 'withdraw_message', id: second.id })
    })
    await expect.poll(() => done(s.events), { timeout: 10_000 }).toBe(true)
    expect(withdrawn).toBe(true)
    // Handed back: Pi's clear_queue answer listed it ...
    const returned = s.events.findIndex((e) => e.type === 'waiting_messages' && !!e.returned)
    expect(s.events[returned]).toEqual({
      type: 'waiting_messages',
      messages: [],
      takes: 'step',
      returned: { why: 'withdrawn', messages: [second] }
    })
    // ... then drawn, once Pi started it, its answer under it.
    const drawn = s.events.findIndex((e) => e.type === 'user_message' && e.text === 'second')
    expect(drawn).toBeGreaterThan(returned)
    expect(readings(s.events)).toEqual([
      { message: 'a long turn', said: 'You said: a long turn' },
      { message: 'second', said: 'You said: secondDone.' }
    ])
    expect(sent(s.state)).toEqual([
      ['prompt', 'a long turn'],
      ['steer', 'second']
    ])
  })

  // The same race at a stop: the stop's clear_queue answers after Pi took
  // the first steer; that one is drawn as taken, the other goes back.
  it('a stop whose clear_queue Pi answers after taking a steer: that one drawn as taken, only the other handed back', async () => {
    const s = await open({}, { env: { PI_STAND_IN_CLEAR_AFTER_STEP: '1' } })
    s.adapter.write(s.handle, { type: 'user_message', text: 'a long turn' })
    await expect.poll(() => s.events.some((e) => e.type === 'assistant_text')).toBe(true)
    s.adapter.write(s.handle, { type: 'user_message', text: 'two' })
    s.adapter.write(s.handle, { type: 'user_message', text: 'three' })
    await expect.poll(() => steered(s.state)).toBe(2)
    s.adapter.write(s.handle, { type: 'interrupt' })
    await expect.poll(() => done(s.events), { timeout: 10_000 }).toBe(true)
    expect(lists(s.events).filter((list) => list.returned)).toEqual([
      {
        type: 'waiting_messages',
        messages: [],
        takes: 'step',
        returned: { why: 'stopped', messages: [{ id: expect.any(String), text: 'three' }] }
      }
    ])
    expect(readings(s.events).map((r) => r.message)).toEqual(['a long turn', 'two'])
    expect(sent(s.state).map(([, message]) => message)).toEqual(['a long turn', 'two', 'three'])
  })

  // Verifier 3, finding 10 (M35): the run's end lets go of a prompt Pi
  // answered and never started (the stop beat it), so a later message with
  // the same words is the one Pi's start draws.
  it(
    'a stop that beats Pi to a prompt’s start: the next message with the same words is the one drawn when Pi takes it',
    {
      timeout: 30_000
    },
    async () => {
      const s = await open({}, { env: { PI_STAND_IN_DELAY_MS: '60' } })
      s.adapter.write(s.handle, { type: 'user_message', text: 'first' })
      await expect.poll(() => types(s.state).includes('prompt'), { interval: 5 }).toBe(true)
      s.adapter.write(s.handle, { type: 'interrupt' })
      await expect.poll(() => done(s.events), { timeout: 5000 }).toBe(true)
      // The stand-in dropped the run before it said anything of it.
      expect(s.events.filter((e) => e.type === 'assistant_text' || e.type === 'error')).toEqual([])
      s.adapter.write(s.handle, { type: 'user_message', text: 'go on, a long turn' })
      await expect
        .poll(() => s.events.some((e) => e.type === 'assistant_text'), { timeout: 10_000 })
        .toBe(true)
      s.adapter.write(s.handle, { type: 'user_message', text: 'first' })
      await expect
        .poll(() => readings(s.events).map((r) => r.message), { timeout: 20_000 })
        .toEqual(['first', 'go on, a long turn', 'first'])
      await expect
        .poll(() => readings(s.events)[2]?.said ?? '', { timeout: 20_000 })
        .toMatch(/^You said: first/)
      expect(lists(s.events).at(-1)?.messages).toEqual([])
    }
  )

  it('a stop with two messages waiting hands both back, Pi’s queue cleared before the abort', async () => {
    const s = await open()
    s.adapter.write(s.handle, { type: 'user_message', text: 'be slow' })
    await expect.poll(() => types(s.state).includes('prompt')).toBe(true)
    await new Promise((r) => setTimeout(r, 100))
    s.adapter.write(s.handle, { type: 'user_message', text: 'two' })
    s.adapter.write(s.handle, { type: 'user_message', text: 'three' })
    await expect.poll(() => steered(s.state)).toBe(2)
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'interrupt' })
    // Together, in order, once Pi's clear_queue answer says Pi held both.
    await expect
      .poll(() => lists(s.events).find((list) => list.returned))
      .toEqual({
        type: 'waiting_messages',
        messages: [],
        takes: 'step',
        returned: {
          why: 'stopped',
          messages: [
            { id: expect.any(String), text: 'two' },
            { id: expect.any(String), text: 'three' }
          ]
        }
      })
    expect(lists(s.events).filter((list) => list.returned)).toHaveLength(1)
    await expect.poll(() => done(s.events)).toBe(true)
    const sentTypes = types(s.state)
    const last = sentTypes.lastIndexOf('steer')
    expect(sentTypes.slice(last + 1, last + 3)).toEqual(['clear_queue', 'abort'])
    expect(sent(s.state)).toEqual([
      ['prompt', 'be slow'],
      ['steer', 'two'],
      ['steer', 'three']
    ])
    const end = s.events.findIndex((e) => e.type === 'turn_interrupted')
    expect(s.events.slice(end, end + 2)).toEqual([
      { type: 'turn_interrupted' },
      { type: 'state_change', state: 'done' }
    ])
    await new Promise((r) => setTimeout(r, 300))
    expect(readings(s.events)).toEqual([])
  })

  // The verifier's closing look, finding 2: a message written in the same
  // instant as Escape is steered into the run that is stopping, after the
  // stop's clear. Pi does not go on after an abort and keeps its queue across
  // it (PI_STAND_IN_ABORT_KEEPS_QUEUE, as Pi 1.5.2): it held the message for a
  // next run that nothing starts, and the message waited in the stack for
  // good. Once the stopped run has settled, what Pi still holds goes as a
  // prompt, out of Pi's queue first, as an idle steer does.
  const escapeThenWrite = async (): Promise<Session> => {
    const s = await open(
      {},
      { env: { PI_STAND_IN_ABORT_KEEPS_QUEUE: '1', PI_STAND_IN_IDLE_STEER: 'queue' } }
    )
    s.adapter.write(s.handle, { type: 'user_message', text: 'be slow' })
    await expect.poll(() => types(s.state).includes('prompt')).toBe(true)
    await new Promise((r) => setTimeout(r, 100))
    s.events.length = 0
    return s
  }
  it(
    'a message written in the same instant as Escape goes as a prompt once the stopped run has settled',
    {
      timeout: 15_000
    },
    async () => {
      const s = await escapeThenWrite()
      s.adapter.write(s.handle, { type: 'interrupt' })
      s.adapter.write(s.handle, { type: 'user_message', text: 'after the stop' })
      await expect
        .poll(() => readings(s.events), { timeout: 10_000 })
        .toEqual([{ message: 'after the stop', said: 'You said: after the stopDone.' }])
      // The stopped run ended first, the message waiting meanwhile; nothing
      // went back to the composer, and nothing waits any more.
      const stopped = s.events.findIndex((e) => e.type === 'turn_interrupted')
      const drawn = s.events.findIndex((e) => e.type === 'user_message')
      expect(stopped).toBeGreaterThanOrEqual(0)
      expect(stopped).toBeLessThan(drawn)
      expect(texts(lists(s.events)[0])).toEqual(['after the stop'])
      expect(lists(s.events).filter((list) => list.returned)).toEqual([])
      expect(lists(s.events).at(-1)?.messages).toEqual([])
      // Steered into the stopping run, taken out of Pi's queue, sent once more
      // as a prompt: Pi took it once.
      const after = frames(s.state).filter(
        (f) => f.message === 'after the stop' || f.type === 'clear_queue' || f.type === 'abort'
      )
      expect(after.map((f) => [f.type, f.message])).toEqual([
        ['clear_queue', undefined],
        ['steer', 'after the stop'],
        ['abort', undefined],
        ['clear_queue', undefined],
        ['prompt', 'after the stop']
      ])
      expect(s.events.filter((e) => e.type === 'user_message')).toHaveLength(1)
    }
  )

  it('a message written in the same instant as Escape and withdrawn before it goes goes back to the composer, never sent', async () => {
    const s = await escapeThenWrite()
    // Withdrawn the moment the stopped run has settled, before Pi's queue is
    // taken back.
    let withdrawn = false
    s.adapter.on(s.handle, 'stream', (stream) => {
      if (withdrawn || stream.kind !== 'event' || stream.event.type !== 'turn_interrupted') return
      withdrawn = true
      const waiting = lists(s.events).at(-1)?.messages[0]
      if (waiting) s.adapter.write(s.handle, { type: 'withdraw_message', id: waiting.id })
    })
    s.adapter.write(s.handle, { type: 'interrupt' })
    s.adapter.write(s.handle, { type: 'user_message', text: 'after the stop' })
    await expect
      .poll(() => lists(s.events).find((list) => list.returned), { timeout: 5000 })
      .toEqual({
        type: 'waiting_messages',
        messages: [],
        takes: 'step',
        returned: {
          why: 'withdrawn',
          messages: [{ id: expect.any(String), text: 'after the stop' }]
        }
      })
    expect(withdrawn).toBe(true)
    await new Promise((r) => setTimeout(r, 500))
    expect(sent(s.state).filter(([, message]) => message === 'after the stop')).toEqual([
      ['steer', 'after the stop']
    ])
    expect(readings(s.events)).toEqual([])
  })

  // Verifier 3, finding 3, as ruled: another tab's message never goes into
  // the person's composer; dropped, it leaves one line naming its tab.
  it('another tab’s message that leaves unsent is dropped with one line naming its tab, never handed back', async () => {
    const lane = (body: string): string =>
      `[Message from Clave tab "Lane B" — reply with clave_send_to_session sessionId="tab-b"]\n${body}`
    const s = await open()
    s.adapter.write(s.handle, { type: 'user_message', text: 'be slow' })
    await expect.poll(() => types(s.state).includes('prompt')).toBe(true)
    await new Promise((r) => setTimeout(r, 100))
    s.adapter.write(s.handle, { type: 'user_message', text: lane('first word') })
    s.adapter.write(s.handle, { type: 'user_message', text: 'mine' })
    await expect.poll(() => steered(s.state)).toBe(2)
    const first = lists(s.events).at(-1)!.messages[0]
    s.events.length = 0
    // Its ×: out of Pi's queue, dropped, nothing for the composer.
    s.adapter.write(s.handle, { type: 'withdraw_message', id: first.id })
    await expect.poll(() => notices(s.events)).toEqual(['A message from Lane B was not sent.'])
    // Nothing failed: the line is quiet (PRDCT-4566).
    expect(quietNotices(s.events)).toEqual(['A message from Lane B was not sent.'])
    expect(lists(s.events).some((list) => list.returned)).toBe(false)
    expect(texts(lists(s.events).at(-1))).toEqual(['mine'])
    // A stop: the person's own back, the other tab's dropped and said.
    await expect.poll(() => steered(s.state)).toBe(3)
    s.adapter.write(s.handle, { type: 'user_message', text: lane('second word') })
    await expect.poll(() => steered(s.state)).toBe(4)
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'interrupt' })
    await expect.poll(() => done(s.events)).toBe(true)
    expect(lists(s.events).filter((list) => list.returned)).toEqual([
      {
        type: 'waiting_messages',
        messages: [],
        takes: 'step',
        returned: { why: 'stopped', messages: [{ id: expect.any(String), text: 'mine' }] }
      }
    ])
    expect(notices(s.events)).toEqual(['A message from Lane B was not sent.'])
    expect(quietNotices(s.events)).toEqual(['A message from Lane B was not sent.'])
    expect(readings(s.events)).toEqual([])
  })

  it('a session that ends with a message waiting hands it back before it ends', async () => {
    const s = await open()
    s.adapter.write(s.handle, { type: 'user_message', text: 'be slow' })
    await expect.poll(() => types(s.state).includes('prompt')).toBe(true)
    s.adapter.write(s.handle, { type: 'user_message', text: 'two' })
    process.kill(s.pid, 'SIGKILL')
    await expect.poll(() => s.exits.length).toBe(1)
    expect(s.events.slice(-3)).toEqual([
      { type: 'error', message: expect.stringContaining('stopped during the turn'), fatal: false },
      {
        type: 'waiting_messages',
        messages: [],
        takes: 'step',
        returned: { why: 'ended', messages: [{ id: expect.any(String), text: 'two' }] }
      },
      { type: 'state_change', state: 'ended' }
    ])
  })
})
