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
  it('a steer Pi answers queued while idle, with no run starting, goes once more as prompt, and the echo arrives', async () => {
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
    const sent = frames(s.state).filter((f) => f.type === 'prompt' || f.type === 'steer')
    expect(sent.map((f) => [f.type, f.message])).toEqual([
      ['steer', 'hello'],
      ['prompt', 'hello']
    ])
    expect(notices(s.events)).toEqual([])
    expect(s.events).toContainEqual({ type: 'assistant_text', delta: 'hello', final: false })
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
      expect(commandsOf(between)).toEqual(['get_state', 'set_model'])
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
