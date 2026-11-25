import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AcpAdapter,
  acpModelOptions,
  retryNotice,
  type AcpAgentSpec,
  type AcpSpawnOptions
} from './acp-adapter'
import type { SessionAdapter, SessionHandle } from '../adapter'
import { SessionManager } from '../session-manager'
import type { SessionEvent } from '../../../shared/session-model'
import { styleAsFirstMessage } from '../../../shared/writing-styles'

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
    styleText,
    ready = true,
    agent = { id: 'opencode-chat', provider: 'opencode', label: 'OpenCode' }
  }: {
    state?: string
    env?: Record<string, string>
    initialPrompt?: string
    styleText?: string
    ready?: boolean
    agent?: AcpAgentSpec
  } = {}
): Promise<Session> {
  const adapter = new AcpAdapter(agent)
  const id = `acp-${++sequence}`
  adapter.configure(id, {
    command: [process.execPath, STAND_IN, 'acp'],
    env: { ...process.env, ACP_STAND_IN_STATE: state, ...env },
    ...(initialPrompt ? { initialPrompt } : {}),
    ...(styleText ? { styleText } : {})
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

describe('acpModelOptions (PRDCT-4427)', () => {
  it('reads the configOptions of a real opencode acp 2.3.0 session/new on a connection', () => {
    // As `opencode acp` 2.3.0 answered it, under `enabled_providers` naming
    // the connection's provider alone (a made-up key).
    const configOptions = [
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'kimi-code-plan-global/k3',
        options: [
          {
            value: 'kimi-code-plan-global/kimi-for-coding-highspeed',
            name: 'kimi-code-plan-global/Kimi For Coding HighSpeed'
          },
          { value: 'kimi-code-plan-global/k3', name: 'kimi-code-plan-global/Kimi K3' },
          { value: 'kimi-code-plan-global/k3-256k', name: 'kimi-code-plan-global/Kimi K3-256K' },
          { value: 'kimi-code-plan-global/k3.1-pro', name: 'kimi-code-plan-global/Kimi K3.1 Pro' },
          {
            value: 'kimi-code-plan-global/k3.1-pro-highspeed',
            name: 'kimi-code-plan-global/Kimi K3.1 Pro Highspeed'
          },
          {
            value: 'kimi-code-plan-global/kimi-for-coding',
            name: 'kimi-code-plan-global/kimi-for-coding'
          }
        ]
      },
      {
        id: 'effort',
        name: 'Effort',
        description: 'Available effort levels for this model',
        category: 'thought_level',
        type: 'select',
        currentValue: 'default',
        options: [
          { value: 'none', name: 'None' },
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
          { value: 'max', name: 'Max' },
          { value: 'default', name: 'Default' }
        ]
      },
      {
        id: 'mode',
        name: 'Session Mode',
        category: 'mode',
        type: 'select',
        currentValue: 'build',
        options: [
          { value: 'build', name: 'Build', description: 'The default agent.' },
          { value: 'plan', name: 'Plan', description: 'Read-only agent.' }
        ]
      }
    ]
    expect(acpModelOptions(configOptions)).toEqual([
      { id: 'kimi-code-plan-global/kimi-for-coding-highspeed', label: 'Kimi For Coding HighSpeed' },
      { id: 'kimi-code-plan-global/k3', label: 'Kimi K3' },
      { id: 'kimi-code-plan-global/k3-256k', label: 'Kimi K3-256K' },
      { id: 'kimi-code-plan-global/k3.1-pro', label: 'Kimi K3.1 Pro' },
      { id: 'kimi-code-plan-global/k3.1-pro-highspeed', label: 'Kimi K3.1 Pro Highspeed' },
      { id: 'kimi-code-plan-global/kimi-for-coding', label: 'kimi-for-coding' }
    ])
  })

  it('reads grouped options, keeps a gloss as the hint, and lists nothing without a model option', () => {
    expect(
      acpModelOptions([
        {
          id: 'model',
          category: 'model',
          currentValue: 'a/x',
          options: [
            { group: 'a', options: [{ value: 'a/x', name: 'X', description: 'Fast' }] },
            { value: 'b/y', name: 'b/Y' }
          ]
        }
      ])
    ).toEqual([
      { id: 'a/x', label: 'X', hint: 'Fast' },
      { id: 'b/y', label: 'Y' }
    ])
    expect(
      acpModelOptions([{ id: 'mode', category: 'mode', options: [{ value: 'build' }] }])
    ).toEqual([])
    expect(acpModelOptions(undefined)).toEqual([])
  })
})

describe('retryNotice (PRDCT-4427)', () => {
  // As `opencode acp` 2.3.0 sent it against a provider refusing with 429.
  const real = {
    attempt: 2,
    nextRetryAt: '2026-11-13T23:45:15.028Z',
    error: {
      type: 'provider.rate-limit',
      message: 'stand-in: rate limited',
      status: 429,
      response: { body: '{"error":{"message":"stand-in: rate limited"}}' },
      retryAfterMs: 3000
    }
  }
  it('says when, which attempt and the provider’s words', () => {
    expect(retryNotice('OpenCode', real)).toBe(
      'OpenCode retries in 3 s (attempt 2): stand-in: rate limited'
    )
  })
  it('reads the wait off nextRetryAt when no retryAfterMs is given', () => {
    const now = Date.parse('2026-11-13T23:45:10.028Z')
    expect(
      retryNotice('OpenCode', { ...real, error: { message: 'slow down' } }, undefined, now)
    ).toBe('OpenCode retries in 5 s (attempt 2): slow down')
  })
  it('says nothing for null, the end of a retry, or a value that is no retry', () => {
    expect(retryNotice('OpenCode', null)).toBeNull()
    expect(retryNotice('OpenCode', 'retry')).toBeNull()
    expect(retryNotice('OpenCode', [])).toBeNull()
  })
  it('never carries a credential value of the environment', () => {
    const value = 'e2e-made-up-key-0001'
    const said = retryNotice(
      'OpenCode',
      { attempt: 2, error: { message: `rate limited for ${value}` } },
      { DEEPSEEK_API_KEY: value }
    )
    expect(said).toBe('OpenCode retries (attempt 2): rate limited for ‹hidden›')
  })
})

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

  // Antigravity's ladder is its `mode` config option (`agy acp` 1.5): the
  // launch's rung is set on it once the session is open.
  describe("the rung a launch starts on, through the agent's mode option", () => {
    const modeSets = (state: string): unknown[] =>
      frames(state)
        .filter((f) => f.method === 'session/set_config_option' && f.params?.configId === 'mode')
        .map((f) => f.params?.value)

    it('sets the rung asked for, before the first message goes', async () => {
      const s = await open({ mode: 'plan' }, { env: { ACP_STAND_IN_MODES: '1' } })
      expect(modeSets(s.state)).toEqual(['plan'])
      s.adapter.write(s.handle, { type: 'user_message', text: 'hello' })
      await expect.poll(() => done(s.events)).toBe(true)
      const methods = frames(s.state).map((f) => f.method)
      expect(methods.indexOf('session/set_config_option')).toBeLessThan(
        methods.indexOf('session/prompt')
      )
      expect(s.events.some((e) => e.type === 'error')).toBe(false)
    })

    it('sets the rung again on a resumed session', async () => {
      const state = tmp()
      const first = await open({}, { state, env: { ACP_STAND_IN_MODES: '1' } })
      const sessionId = (
        first.events.find((e) => e.type === 'session_meta') as { providerSessionId: string }
      ).providerSessionId
      await first.adapter.kill(first.handle)
      await open(
        { resume: sessionId, mode: 'accept-edits' },
        { state, env: { ACP_STAND_IN_MODES: '1' } }
      )
      expect(modeSets(state)).toEqual(['accept-edits'])
    })

    it('sends nothing for the rung the session is already on, or for none', async () => {
      const on = await open({ mode: 'default' }, { env: { ACP_STAND_IN_MODES: '1' } })
      const none = await open({}, { env: { ACP_STAND_IN_MODES: '1' } })
      expect(modeSets(on.state)).toEqual([])
      expect(modeSets(none.state)).toEqual([])
    })

    it('says once that a rung is not offered, and the session opens on its own', async () => {
      const unknown = await open({ mode: 'yolo' }, { env: { ACP_STAND_IN_MODES: '1' } })
      const noLadder = await open({ mode: 'plan' })
      for (const s of [unknown, noLadder]) {
        expect(modeSets(s.state)).toEqual([])
        expect(s.events.filter((e) => e.type === 'error')).toHaveLength(1)
        expect(s.events.find((e) => e.type === 'session_meta')).toBeDefined()
      }
      expect(unknown.events.find((e) => e.type === 'error')).toMatchObject({
        message: 'OpenCode has no mode yolo; the session starts in its own',
        fatal: false
      })
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

  // PRDCT-4507: OpenCode 2.3.0's code mode, as the real `opencode acp` sent it
  // (the stand-in copies the frames): the `execute` call opens with
  // `rawInput: {}` and its script arrives with the `in_progress` update.
  it('shows an execute call again when its script arrives, once, live and replayed', async () => {
    const SCRIPT =
      'const found = await search({ query: "list tabs" }); const r = await tools.clave.clave_list({}); return r'
    const state = tmp()
    const s = await open({}, { state })
    const sessionId = (
      s.events.find((e) => e.type === 'session_meta') as { providerSessionId: string }
    ).providerSessionId
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'user_message', text: 'run code' })
    await expect.poll(() => done(s.events)).toBe(true)
    const calls = s.events.filter((e) => e.type === 'tool_call') as {
      id: string
      name: string
      input: unknown
    }[]
    expect(calls.map((c) => [c.name, c.input])).toEqual([
      ['execute', {}],
      // The two identical updates show it once.
      ['execute', { code: SCRIPT }]
    ])
    expect(new Set(calls.map((c) => c.id)).size).toBe(1)
    expect(s.events.find((e) => e.type === 'tool_result')).toMatchObject({
      id: calls[0].id,
      output: 'stand-in answer'
    })
    await s.adapter.kill(s.handle)
    const resumed = await open({ resume: sessionId }, { state })
    const replayed = resumed.adapter
      .history(resumed.handle)
      .map((item) => item.event)
      .filter((e) => e.type === 'tool_call')
    expect(replayed).toEqual([
      { type: 'tool_call', id: expect.any(String), name: 'execute', input: { code: SCRIPT } }
    ])
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

  it('models() lists what the model option offers, the provider prefix off each name (PRDCT-4427)', async () => {
    const s = await open()
    expect(await s.adapter.models(s.handle)).toEqual([
      { id: 'stand-in/one', label: 'One' },
      { id: 'stand-in/two', label: 'Two' },
      { id: 'stand-in/three', label: 'Three' }
    ])
    // A pick from that list switches, as the menu's pick does.
    s.adapter.write(s.handle, { type: 'set_model', model: 'stand-in/two' })
    await expect
      .poll(() => s.events.filter((e) => e.type === 'session_meta').map((e) => e.model))
      .toEqual(['stand-in/one', 'stand-in/two'])
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
    const said = {
      type: 'error',
      message: 'OpenCode does not have the model other/unknown: this chat runs on stand-in/one.',
      fatal: false
    }
    expect(s.events.filter((e) => e.type === 'error')).toEqual([said])
    expect(frames(s.state).some((f) => f.method === 'session/set_config_option')).toBe(false)
  })

  // PRDCT-4427: OpenCode 2.3.0 opens on a model of its own when its
  // configuration names one it does not have, and says nothing.
  it('a configured model the agent opened another in place of: said once, naming both, and live alone', async () => {
    const s = await open(
      { model: 'deepseek/no-such-model-zz' },
      {
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            enabled_providers: ['deepseek'],
            model: 'deepseek/no-such-model-zz'
          })
        }
      }
    )
    const said = {
      type: 'error',
      message:
        'OpenCode does not have the model deepseek/no-such-model-zz: this chat runs on deepseek/stand-in-default.',
      fatal: false
    }
    expect(s.events.filter((e) => e.type === 'error')).toEqual([said])
    // Said live alone: the session's timeline keeps it for a pane that binds
    // after it was said, and a copy in the past stood twice (PRDCT-4664).
    expect(s.adapter.history(s.handle)).toEqual([])
    expect(frames(s.state).some((f) => f.method === 'session/set_config_option')).toBe(false)
    // The model it was asked for, when it is the one it opened on: nothing said.
    const asked = await open(
      { model: 'deepseek/deepseek-chat' },
      {
        env: {
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            enabled_providers: ['deepseek'],
            model: 'deepseek/deepseek-chat'
          })
        }
      }
    )
    expect(asked.events.some((e) => e.type === 'error')).toBe(false)
  })

  it("says OpenCode's rate-limit retries as one notice, the latest in place of the one before", async () => {
    const s = await open()
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'user_message', text: 'rate limited please' })
    await expect.poll(() => done(s.events), { timeout: 10_000 }).toBe(true)
    const notices = s.events.filter((e) => e.type === 'error')
    expect(notices).toEqual([
      {
        type: 'error',
        message: 'OpenCode retries in 3 s (attempt 2): stand-in: rate limited',
        fatal: false,
        notice: 'retry'
      },
      {
        type: 'error',
        message: 'OpenCode retries in 3 s (attempt 3): stand-in: rate limited',
        fatal: false,
        notice: 'retry'
      }
    ])
    // The answer still comes, after the notices.
    expect(
      s.events.findIndex((e) => e.type === 'assistant_text' && e.delta === 'You said: ')
    ).toBeGreaterThan(s.events.indexOf(notices[1]))
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
    // Said live alone: the session's timeline keeps it for a pane that binds
    // after it was said, and a copy in the past stood twice (PRDCT-4664).
    expect(s.adapter.history(s.handle)).toEqual([])
  })

  // PRDCT-4664: the notice is said before any pane is bound (the separate
  // server makes a session ready at its start), and the pane that binds after
  // reads the session's timeline. While the adapter also kept the notice in
  // its past, the timeline froze that past as its prefix and then ordered the
  // live copy behind it: every such conversation showed the notice twice.
  it('a refusal stands once in the timeline a pane reads after it was said', async () => {
    const state = tmp()
    const adapter = new AcpAdapter({ id: 'opencode-chat', provider: 'opencode', label: 'OpenCode' })
    const id = `acp-${++sequence}`
    adapter.configure(id, {
      command: [process.execPath, STAND_IN, 'acp'],
      env: { ...process.env, ACP_STAND_IN_STATE: state, ACP_STAND_IN_REFUSE: 'auth' }
    })
    const manager = new SessionManager()
    manager.registerAdapter(adapter as unknown as SessionAdapter)
    await manager.create({
      id,
      provider: 'opencode',
      transport: 'events',
      cwd: state,
      windowKey: 'w',
      state: 'idle',
      createdAt: 0,
      adapterId: 'opencode-chat',
      title: 'OpenCode',
      options: {}
    })
    live.push({ adapter, handle: { id } })
    manager.ready(id)
    await expect.poll(() => manager.get(id)?.state).toBe('ended')
    const notices = manager.timeline(id).items.filter((item) => item.event.type === 'error')
    expect(notices.map((item) => item.event)).toEqual([
      {
        type: 'error',
        message: expect.stringMatching(/Not signed in/),
        fatal: false
      }
    ])
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
    expect(adapter.history(handle)).toEqual([])
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

describe('a message written while a turn runs waits for its own turn (PRDCT-4566)', () => {
  /** The conversation as it reads, in order: each message, then what answers it. */
  const transcript = (events: SessionEvent[]): string[] =>
    events.flatMap((e) =>
      e.type === 'user_message'
        ? [`> ${e.text}`]
        : e.type === 'assistant_text' && e.delta
          ? [e.delta]
          : []
    )
  type Waiting = Extract<SessionEvent, { type: 'waiting_messages' }>
  const lists = (events: SessionEvent[]): Waiting[] =>
    events.flatMap((e) => (e.type === 'waiting_messages' ? [e] : []))
  const texts = (list: Waiting | undefined): string[] => (list?.messages ?? []).map((m) => m.text)
  const prompted = (state: string): string[] =>
    frames(state)
      .filter((f) => f.method === 'session/prompt')
      .map((f) => (f.params?.prompt as { text: string }[])[0].text)
  const dones = (events: SessionEvent[]): number =>
    events.filter((e) => e.type === 'state_change' && e.state === 'done').length
  const file = {
    id: 'a1',
    path: '/tmp/notes.md',
    name: 'notes.md',
    mimeType: 'text/markdown',
    size: 3,
    delivery: 'reference' as const
  }

  it('three messages written during one turn: each enters the conversation as its turn starts, its answer under it', async () => {
    const s = await open({}, { env: { ACP_STAND_IN_DELAY_MS: '300' } })
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'user_message', text: 'one' })
    s.adapter.write(s.handle, { type: 'user_message', text: 'two' })
    s.adapter.write(s.handle, { type: 'user_message', text: 'three' })
    // At once: the first is the conversation's; the two others wait outside it.
    expect(transcript(s.events)).toEqual(['> one'])
    expect(texts(lists(s.events).at(-1))).toEqual(['two', 'three'])
    expect(lists(s.events).at(-1)?.takes).toBe('turn')
    await expect.poll(() => dones(s.events), { timeout: 10_000 }).toBe(3)
    expect(transcript(s.events)).toEqual([
      '> one',
      'You said: ',
      'on',
      'e',
      '> two',
      'You said: ',
      'tw',
      'o',
      '> three',
      'You said: ',
      'thr',
      'ee'
    ])
    // The list shrinks by one as each turn starts, the message drawn right after.
    expect(lists(s.events).map(texts)).toEqual([['two'], ['two', 'three'], ['three'], []])
    const takenTwo = s.events.findIndex((e) => e.type === 'waiting_messages' && !texts(e).length)
    expect(s.events[takenTwo + 1]).toEqual({ type: 'user_message', text: 'three' })
    expect(s.events[takenTwo + 2]).toEqual({ type: 'state_change', state: 'working' })
    expect(prompted(s.state)).toEqual(['one', 'two', 'three'])
  })

  it('a withdrawn message leaves the list for the composer and is never sent', async () => {
    const s = await open({}, { env: { ACP_STAND_IN_DELAY_MS: '300' } })
    s.adapter.write(s.handle, { type: 'user_message', text: 'one' })
    s.adapter.write(s.handle, { type: 'user_message', text: 'two', attachments: [file] })
    s.adapter.write(s.handle, { type: 'user_message', text: 'three' })
    const two = lists(s.events).at(-1)!.messages[0]
    expect(two).toEqual({ id: expect.any(String), text: 'two', attachments: [file] })
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'withdraw_message', id: two.id })
    expect(s.events).toEqual([
      {
        type: 'waiting_messages',
        messages: [{ id: expect.any(String), text: 'three' }],
        takes: 'turn',
        returned: { why: 'withdrawn', messages: [two] }
      }
    ])
    await expect.poll(() => dones(s.events), { timeout: 10_000 }).toBe(2)
    expect(prompted(s.state)).toEqual(['one', 'three'])
    expect(transcript(s.events)).not.toContain('> two')
    // Taken or gone: nothing more to take back.
    const before = s.events.length
    s.adapter.write(s.handle, { type: 'withdraw_message', id: two.id })
    expect(s.events.length).toBe(before)
  })

  it('an identified message that waits carries its client message id, in the list and when handed back, for the write ledger', async () => {
    const s = await open()
    s.adapter.write(s.handle, { type: 'user_message', text: 'be slow' })
    await expect.poll(() => prompted(s.state)).toEqual(['be slow'])
    s.adapter.write(s.handle, {
      type: 'user_message',
      text: 'from the phone',
      clientMessageId: 'phone-00000042'
    })
    expect(lists(s.events).at(-1)?.messages).toEqual([
      { id: expect.any(String), text: 'from the phone', clientMessageId: 'phone-00000042' }
    ])
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'interrupt' })
    await expect.poll(() => dones(s.events)).toBe(1)
    expect(s.events[0]).toMatchObject({
      type: 'waiting_messages',
      returned: {
        why: 'stopped',
        messages: [{ text: 'from the phone', clientMessageId: 'phone-00000042' }]
      }
    })
  })

  it('a stop with two messages waiting ends the turn and hands both back, none sent, nothing started', async () => {
    const s = await open()
    s.adapter.write(s.handle, { type: 'user_message', text: 'be slow' })
    await expect.poll(() => prompted(s.state)).toEqual(['be slow'])
    s.adapter.write(s.handle, { type: 'user_message', text: 'two' })
    s.adapter.write(s.handle, { type: 'user_message', text: 'three' })
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'interrupt' })
    await expect.poll(() => dones(s.events)).toBe(1)
    expect(s.events[0]).toEqual({
      type: 'waiting_messages',
      messages: [],
      takes: 'turn',
      returned: {
        why: 'stopped',
        messages: [
          { id: expect.any(String), text: 'two' },
          { id: expect.any(String), text: 'three' }
        ]
      }
    })
    expect(s.events.slice(-2)).toEqual([
      { type: 'turn_interrupted' },
      { type: 'state_change', state: 'done' }
    ])
    await new Promise((r) => setTimeout(r, 500))
    expect(prompted(s.state)).toEqual(['be slow'])
    expect(transcript(s.events)).toEqual([])
  })

  // Verifier 3, finding 3, as ruled: another tab's message never goes into
  // the person's composer; dropped, it leaves one line naming its tab.
  it('another tab’s message that leaves unsent is dropped with one line naming its tab, never handed back', async () => {
    const lane = (body: string): string =>
      `[Message from Clave tab "Lane B" — reply with clave_send_to_session sessionId="tab-b"]\n${body}`
    const s = await open()
    s.adapter.write(s.handle, { type: 'user_message', text: 'be slow' })
    await expect.poll(() => prompted(s.state)).toEqual(['be slow'])
    s.adapter.write(s.handle, { type: 'user_message', text: lane('first word') })
    s.adapter.write(s.handle, { type: 'user_message', text: 'mine' })
    s.adapter.write(s.handle, {
      type: 'user_message',
      text: '[Message from a Clave agent]\nunnamed word'
    })
    const first = lists(s.events).at(-1)!.messages[0]
    s.events.length = 0
    // Its ×: dropped, never sent, nothing for the composer.
    s.adapter.write(s.handle, { type: 'withdraw_message', id: first.id })
    expect(s.events).toEqual([
      {
        type: 'waiting_messages',
        messages: [
          { id: expect.any(String), text: 'mine' },
          { id: expect.any(String), text: '[Message from a Clave agent]\nunnamed word' }
        ],
        takes: 'turn'
      },
      // Nothing failed: the line is quiet (PRDCT-4566).
      { type: 'error', message: 'A message from Lane B was not sent.', fatal: false, quiet: true }
    ])
    // A stop: the person's own back, the other tab's dropped and said.
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'interrupt' })
    expect(s.events.slice(0, 2)).toEqual([
      {
        type: 'waiting_messages',
        messages: [],
        takes: 'turn',
        returned: { why: 'stopped', messages: [{ id: expect.any(String), text: 'mine' }] }
      },
      {
        type: 'error',
        message: 'A message from another agent was not sent.',
        fatal: false,
        quiet: true
      }
    ])
    await expect.poll(() => dones(s.events)).toBe(1)
    await new Promise((r) => setTimeout(r, 300))
    expect(prompted(s.state)).toEqual(['be slow'])
    // The end: the same.
    s.adapter.write(s.handle, { type: 'user_message', text: 'be slow again' })
    await expect.poll(() => prompted(s.state).length).toBe(2)
    s.adapter.write(s.handle, { type: 'user_message', text: lane('last word') })
    process.kill(s.pid, 'SIGKILL')
    await expect.poll(() => s.exits.length).toBe(1)
    expect(s.events.slice(-3)).toEqual([
      { type: 'waiting_messages', messages: [], takes: 'turn' },
      { type: 'error', message: 'A message from Lane B was not sent.', fatal: false, quiet: true },
      { type: 'state_change', state: 'ended' }
    ])
  })

  it('a session that ends with a message waiting hands it back before it ends', async () => {
    const s = await open()
    s.adapter.write(s.handle, { type: 'user_message', text: 'be slow' })
    await expect.poll(() => prompted(s.state)).toEqual(['be slow'])
    s.adapter.write(s.handle, { type: 'user_message', text: 'two' })
    process.kill(s.pid, 'SIGKILL')
    await expect.poll(() => s.exits.length).toBe(1)
    expect(s.events.slice(-3)).toEqual([
      { type: 'error', message: expect.stringContaining('stopped during the turn'), fatal: false },
      {
        type: 'waiting_messages',
        messages: [],
        takes: 'turn',
        returned: { why: 'ended', messages: [{ id: expect.any(String), text: 'two' }] }
      },
      { type: 'state_change', state: 'ended' }
    ])
  })
})

describe("Antigravity's session options: its ladder, its models and their levels", () => {
  const agent: AcpAgentSpec = {
    id: 'antigravity-chat',
    provider: 'antigravity',
    label: 'Antigravity',
    sessionOptions: true
  }
  const agy = (
    options: AcpSpawnOptions = {},
    extra: { state?: string; env?: Record<string, string>; ready?: boolean } = {}
  ): Promise<Session> =>
    open(options, { ...extra, agent, env: { ACP_STAND_IN_AGY: '1', ...extra.env } })
  const modes = (events: SessionEvent[]): string[] =>
    events.flatMap((e) => (e.type === 'permission_mode' ? [e.mode] : []))
  const efforts = (events: SessionEvent[]): (string | null)[] =>
    events.flatMap((e) => (e.type === 'effort' ? [e.effort] : []))
  const errors = (events: SessionEvent[]): string[] =>
    events.flatMap((e) => (e.type === 'error' ? [e.message] : []))
  const sets = (state: string): string[] =>
    frames(state)
      .filter((f) => f.method === 'session/set_config_option')
      .map((f) => `${f.params?.configId}=${f.params?.value}`)

  it('starts on the default mode before the first prompt and says the ladder once', async () => {
    const s = await agy({ defaultMode: 'auto' })
    expect(sets(s.state)).toEqual(['mode=auto'])
    // Said once, settled: a first word of "default" would read as a switch.
    expect(modes(s.events)).toEqual(['auto'])
    expect(s.events.find((e) => e.type === 'permission_mode')).toEqual({
      type: 'permission_mode',
      mode: 'auto',
      modes: ['default', 'accept-edits', 'auto', 'plan'].map((id) => ({ id, label: id }))
    })
    s.adapter.write(s.handle, { type: 'user_message', text: 'hello' })
    await expect.poll(() => done(s.events)).toBe(true)
    const methods = frames(s.state).map((f) => f.method)
    expect(methods.indexOf('session/set_config_option')).toBeLessThan(
      methods.indexOf('session/prompt')
    )
    expect(errors(s.events)).toEqual([])
  })

  it('keeps the mode asked for over the default', async () => {
    for (const mode of ['default', 'plan', 'accept-edits']) {
      const s = await agy({ mode, defaultMode: 'auto' })
      expect(modes(s.events)).toEqual([mode])
    }
  })

  it('stays on asking, saying nothing, where the account has no auto', async () => {
    const s = await agy({ defaultMode: 'auto' }, { env: { ACP_STAND_IN_NO_AUTO: '1' } })
    expect(sets(s.state)).toEqual([])
    expect(modes(s.events)).toEqual(['default'])
    expect(errors(s.events)).toEqual([])
  })

  it('puts a resumed conversation back in its mode, which agy resets on load', async () => {
    const state = tmp()
    const first = await agy({ mode: 'accept-edits' }, { state })
    const { providerSessionId } = first.events.find((e) => e.type === 'session_meta') as {
      providerSessionId: string
    }
    await first.adapter.kill(first.handle)
    const again = await agy({ resume: providerSessionId, mode: 'accept-edits' }, { state })
    expect(modes(again.events)).toEqual(['accept-edits'])
    expect(sets(state)).toEqual(['mode=accept-edits', 'mode=accept-edits'])
  })

  it('switches the mode from the chip, each change said once', async () => {
    const s = await agy({ defaultMode: 'auto' })
    for (const mode of ['plan', 'default', 'accept-edits', 'auto']) {
      s.adapter.write(s.handle, { type: 'set_permission_mode', mode })
      await expect.poll(() => modes(s.events).at(-1)).toBe(mode)
    }
    expect(modes(s.events)).toEqual(['auto', 'plan', 'default', 'accept-edits', 'auto'])
  })

  it('switches the mode while a turn runs', async () => {
    const s = await agy({ mode: 'default' })
    s.adapter.write(s.handle, { type: 'user_message', text: 'slow' })
    s.adapter.write(s.handle, { type: 'set_permission_mode', mode: 'auto' })
    await expect.poll(() => modes(s.events).at(-1)).toBe('auto')
  })

  it('refuses a mode it does not offer and says the one it is still on', async () => {
    const s = await agy({ mode: 'plan' })
    s.adapter.write(s.handle, { type: 'set_permission_mode', mode: 'bypassPermissions' })
    await expect.poll(() => modes(s.events)).toEqual(['plan', 'plan'])
    expect(errors(s.events)).toEqual([
      'Antigravity has no mode bypassPermissions; the session stays on plan'
    ])
    expect(sets(s.state)).toEqual(['mode=plan'])
  })

  it("follows a mode change of the agent's own", async () => {
    const s = await agy({ defaultMode: 'auto' })
    s.adapter.write(s.handle, { type: 'user_message', text: 'go to plan mode' })
    await expect.poll(() => modes(s.events)).toEqual(['auto', 'plan'])
  })

  it("lists the current model's levels and follows a level or model change", async () => {
    const s = await agy()
    expect(efforts(s.events)).toEqual(['high'])
    const levels = async (): Promise<(string[] | undefined)[]> =>
      (await s.adapter.models(s.handle)).map((m) => m.efforts?.map((e) => e.id))
    expect(await levels()).toEqual([['high', 'low', 'medium'], undefined, undefined])
    s.adapter.write(s.handle, { type: 'set_effort', effort: 'low' })
    await expect.poll(() => efforts(s.events)).toEqual(['high', 'low'])
    s.adapter.write(s.handle, { type: 'set_model', model: 'stand-in/two' })
    await expect.poll(() => efforts(s.events)).toEqual(['high', 'low', 'medium'])
    expect(await levels()).toEqual([undefined, ['medium', 'low', 'high', 'xhigh'], undefined])
    s.adapter.write(s.handle, { type: 'set_model', model: 'stand-in/three' })
    await expect.poll(() => efforts(s.events)).toEqual(['high', 'low', 'medium', null])
    expect(await levels()).toEqual([undefined, undefined, undefined])
  })

  it('starts on the model, then its level, then the mode', async () => {
    const s = await agy({ model: 'stand-in/two', effort: 'xhigh', mode: 'auto' })
    expect(sets(s.state)).toEqual(['model=stand-in/two', 'thought_level=xhigh', 'mode=auto'])
    expect(efforts(s.events)).toEqual(['xhigh'])
  })

  it('reads a model id that names its level, as `agy models` prints them', async () => {
    const s = await agy({ model: 'stand-in/two-low', effort: 'high' })
    expect(sets(s.state)).toEqual(['model=stand-in/two', 'thought_level=low'])
    expect(errors(s.events)).toEqual([])
  })

  it('drops a remembered level the model does not take, saying nothing', async () => {
    const s = await agy({ effort: 'xhigh' })
    expect(sets(s.state)).toEqual([])
    expect(errors(s.events)).toEqual([])
  })

  it('holds a switch written during the handshake until the session is open', async () => {
    const adapter = new AcpAdapter(agent)
    const state = tmp()
    adapter.configure('early', {
      command: [process.execPath, STAND_IN, 'acp'],
      env: { ...process.env, ACP_STAND_IN_STATE: state, ACP_STAND_IN_AGY: '1' }
    })
    const spawning = adapter.spawn({
      id: 'early',
      provider: 'antigravity',
      transport: 'events',
      cwd: state,
      windowKey: 'w',
      state: 'idle',
      createdAt: 0,
      adapterId: 'antigravity-chat',
      title: 'Antigravity',
      options: { defaultMode: 'auto' }
    })
    adapter.write({ id: 'early' }, { type: 'set_permission_mode', mode: 'plan' })
    const handle = await spawning
    live.push({ adapter, handle })
    await expect.poll(() => sets(state)).toEqual(['mode=auto', 'mode=plan'])
  })

  it("leaves OpenCode's chat as it was: no ladder, no levels", async () => {
    const s = await open({}, { env: { ACP_STAND_IN_AGY: '1' } })
    s.adapter.write(s.handle, { type: 'set_permission_mode', mode: 'plan' })
    s.adapter.write(s.handle, { type: 'user_message', text: 'hello' })
    await expect.poll(() => done(s.events)).toBe(true)
    expect(modes(s.events)).toEqual([])
    expect(efforts(s.events)).toEqual([])
    expect(sets(s.state)).toEqual([])
  })
})

describe("Antigravity's mode, fail closed", () => {
  const agent: AcpAgentSpec = {
    id: 'antigravity-chat',
    provider: 'antigravity',
    label: 'Antigravity',
    sessionOptions: true
  }
  const agy = (options: AcpSpawnOptions, env: Record<string, string> = {}): Promise<Session> =>
    open(options, { agent, env: { ACP_STAND_IN_AGY: '1', ...env } })
  const modes = (events: SessionEvent[]): string[] =>
    events.flatMap((e) => (e.type === 'permission_mode' ? [e.mode] : []))

  it('picks nothing by starting on the default', async () => {
    const s = await agy({ defaultMode: 'auto' })
    expect(s.adapter.chosenMode(s.handle.id)).toBeUndefined()
  })
  it('keeps what the launch picked, then what the chip picks', async () => {
    const s = await agy({ mode: 'plan', pickedMode: 'plan' })
    expect(s.adapter.chosenMode(s.handle.id)).toBe('plan')
    s.adapter.write(s.handle, { type: 'set_permission_mode', mode: 'auto' })
    await expect.poll(() => s.adapter.chosenMode(s.handle.id)).toBe('auto')
  })
  it("keeps the agent's own move to a stricter mode", async () => {
    const s = await agy({ defaultMode: 'auto' })
    s.adapter.write(s.handle, { type: 'user_message', text: 'go to plan mode' })
    await expect.poll(() => s.adapter.chosenMode(s.handle.id)).toBe('plan')
  })
  it('keeps a response from overwriting the mode change that followed it', async () => {
    const s = await agy({ mode: 'default' }, { ACP_STAND_IN_MODE_RACE: 'auto' })
    s.adapter.write(s.handle, { type: 'set_permission_mode', mode: 'auto' })
    await expect.poll(() => modes(s.events).at(-1)).toBe('plan')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(modes(s.events).at(-1)).toBe('plan')
    expect(s.adapter.chosenMode(s.handle.id)).toBe('plan')
  })
  it('opens on no looser mode when the stricter one asked cannot be set', async () => {
    const refusals: Record<string, string>[] = [
      { ACP_STAND_IN_REFUSE_MODE: 'plan' },
      { ACP_STAND_IN_NO_PLAN: '1' }
    ]
    for (const env of refusals) {
      const s = await open(
        { mode: 'plan', pickedMode: 'plan' },
        { agent, env: { ACP_STAND_IN_AGY: '1', ...env }, initialPrompt: 'do it' }
      )
      await expect.poll(() => s.exits).toEqual([1])
      expect(frames(s.state).some((f) => f.method === 'session/prompt')).toBe(false)
      expect(
        s.events.some((e) => e.type === 'error' && /could not start in plan/i.test(e.message))
      ).toBe(true)
    }
  })
})

describe("Antigravity's switches, one after another", () => {
  const agent: AcpAgentSpec = {
    id: 'antigravity-chat',
    provider: 'antigravity',
    label: 'Antigravity',
    sessionOptions: true
  }
  const agy = (options: AcpSpawnOptions, env: Record<string, string> = {}): Promise<Session> =>
    open(options, { agent, env: { ACP_STAND_IN_AGY: '1', ...env } })
  const last = (s: Session): string | undefined =>
    s.events.flatMap((e) => (e.type === 'permission_mode' ? [e.mode] : [])).at(-1)
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 700))
  const pick = (s: Session, ...modes: string[]): void => {
    for (const mode of modes) s.adapter.write(s.handle, { type: 'set_permission_mode', mode })
  }

  it.each([
    ['plan', ['auto', 'plan']],
    ['default', ['auto', 'default']],
    ['auto', ['plan', 'auto']],
    ['auto', ['plan', 'auto', 'plan']],
    ['plan', ['auto', 'plan', 'default', 'auto', 'accept-edits', 'auto', 'plan', 'auto', 'default']]
  ])('from %s, the last of %j wins, shown and recorded', async (mode, picks) => {
    const s = await agy(
      { mode, pickedMode: mode },
      { ACP_STAND_IN_SET_DELAY: '{"auto":60,"accept-edits":30}' }
    )
    pick(s, ...picks)
    await settle()
    expect(last(s)).toBe(picks.at(-1))
    expect(s.adapter.chosenMode(s.handle.id)).toBe(picks.at(-1))
  })
  it('keeps the pick that landed when the next one is refused', async () => {
    const s = await agy({ defaultMode: 'accept-edits' }, { ACP_STAND_IN_REFUSE_MODE: 'auto' })
    pick(s, 'plan', 'auto')
    await settle()
    expect(last(s)).toBe('plan')
    expect(s.adapter.chosenMode(s.handle.id)).toBe('plan')
  })
  it('sends no message before the switch written ahead of it has landed', async () => {
    const s = await agy({ mode: 'auto' }, { ACP_STAND_IN_SET_DELAY: '{"plan":300}' })
    pick(s, 'plan')
    s.adapter.write(s.handle, { type: 'user_message', text: 'hello' })
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(frames(s.state).some((f) => f.method === 'session/prompt')).toBe(false)
    await expect.poll(() => done(s.events), { timeout: 4000 }).toBe(true)
    expect(last(s)).toBe('plan')
  })
  it('sends nothing that followed a stricter switch the agent refused', async () => {
    const s = await agy({ mode: 'auto' }, { ACP_STAND_IN_REFUSE_MODE: 'plan' })
    pick(s, 'plan')
    s.adapter.write(s.handle, { type: 'user_message', text: 'hello' })
    await expect.poll(() => done(s.events), { timeout: 4000 }).toBe(true)
    expect(frames(s.state).some((f) => f.method === 'session/prompt')).toBe(false)
    s.events.length = 0
    s.adapter.write(s.handle, { type: 'user_message', text: 'again' })
    await expect.poll(() => done(s.events), { timeout: 4000 }).toBe(true)
    expect(frames(s.state).some((f) => f.method === 'session/prompt')).toBe(true)
  })
  it("lets go of the agent's own step when it leaves it", async () => {
    const s = await agy({ defaultMode: 'auto' })
    s.adapter.write(s.handle, { type: 'user_message', text: 'plan then auto' })
    await expect.poll(() => done(s.events)).toBe(true)
    expect(last(s)).toBe('auto')
    expect(s.adapter.chosenMode(s.handle.id)).toBeUndefined()
  })
  it('says nothing of a mode an agy without the option could only honour anyway', async () => {
    const s = await open({ mode: 'default' }, { agent })
    expect(s.events.filter((e) => e.type === 'error')).toEqual([])
  })
})

describe('what the write-back records, at the moment it writes', () => {
  const agent: AcpAgentSpec = {
    id: 'antigravity-chat',
    provider: 'antigravity',
    label: 'Antigravity',
    sessionOptions: true
  }
  /** pty-manager reads `chosenMode` as each `permission_mode` reaches it. */
  async function recording(
    options: AcpSpawnOptions,
    env: Record<string, string>
  ): Promise<{ s: Session; record: () => string | undefined }> {
    const s = await open(options, { agent, env: { ACP_STAND_IN_AGY: '1', ...env } })
    let written = options.pickedMode
    s.adapter.on(s.handle, 'stream', (stream) => {
      if (stream.kind === 'event' && stream.event.type === 'permission_mode')
        written = s.adapter.chosenMode(s.handle.id)
    })
    return { s, record: () => written }
  }

  it.each([
    ['plan', ['auto', 'plan']],
    ['default', ['auto', 'default']],
    ['auto', ['plan']],
    ['auto', ['default']]
  ])('from %s, %j is recorded when the update crosses the answer', async (mode, picks) => {
    const { s, record } = await recording(
      { mode, pickedMode: mode },
      { ACP_STAND_IN_OPTIONS_FIRST: '1' }
    )
    for (const pick of picks) s.adapter.write(s.handle, { type: 'set_permission_mode', mode: pick })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(record()).toBe(picks.at(-1))
  })
  it('sends nothing a Stop took back while a switch was on its way', async () => {
    const { s } = await recording({ mode: 'plan' }, { ACP_STAND_IN_SET_DELAY: '{"auto":250}' })
    s.adapter.write(s.handle, { type: 'set_permission_mode', mode: 'auto' })
    s.adapter.write(s.handle, { type: 'user_message', text: 'hello' })
    s.adapter.write(s.handle, { type: 'interrupt' })
    await expect.poll(() => done(s.events), { timeout: 3000 }).toBe(true)
    expect(frames(s.state).some((f) => f.method === 'session/prompt')).toBe(false)
  })
})

describe('a writing style on the first message (PRDCT-5166)', () => {
  const STYLE = 'Answer first.\nSay "done" when `npm test` passes.'
  const agent: AcpAgentSpec = {
    id: 'antigravity-chat',
    provider: 'antigravity',
    label: 'Antigravity',
    sessionOptions: true
  }
  const agy = (options: AcpSpawnOptions, extra: { state?: string } = {}): Promise<Session> =>
    open(options, { ...extra, agent, styleText: STYLE, env: { ACP_STAND_IN_AGY: '1' } })
  /** The text of each `session/prompt` the agent received. */
  const sent = (state: string): string[] =>
    frames(state)
      .filter((f) => f.method === 'session/prompt')
      .map((f) => {
        const blocks = f.params?.prompt as { type: string; text?: string }[]
        return blocks.find((block) => block.type === 'text')?.text ?? ''
      })
  const shown = (events: SessionEvent[]): string[] =>
    events.flatMap((e) => (e.type === 'user_message' ? [e.text] : []))
  const turn = async (s: Session, text: string): Promise<void> => {
    const from = s.events.length
    s.adapter.write(s.handle, { type: 'user_message', text })
    await expect.poll(() => done(s.events, from)).toBe(true)
  }

  it("goes with an Antigravity chat's first prompt, once, and the views see the message as written", async () => {
    const s = await agy({})
    await turn(s, 'hello')
    await turn(s, 'again')
    expect(sent(s.state)).toEqual([styleAsFirstMessage(STYLE, 'hello'), 'again'])
    expect(shown(s.events)).toEqual(['hello', 'again'])
  })

  it('never goes to a conversation loaded back', async () => {
    const state = tmp()
    const first = await agy({}, { state })
    const { providerSessionId } = first.events.find((e) => e.type === 'session_meta') as {
      providerSessionId: string
    }
    await first.adapter.kill(first.handle)
    const again = await agy({ resume: providerSessionId }, { state })
    await turn(again, 'back')
    expect(sent(state)).toEqual(['back'])
  })

  it('never goes to an OpenCode chat, which reads its style from a file', async () => {
    const s = await open({}, { styleText: STYLE })
    await turn(s, 'hello')
    expect(sent(s.state)).toEqual(['hello'])
  })
})
