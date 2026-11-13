import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
  type SpawnSyncReturns
} from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PiRpcConnection, PiRpcError, type PiRpcEvent } from './pi-rpc-client'

/** The stand-in Pi's own contract (tests/e2e/fixtures/pi-rpc-agent.mjs). */
const PI_STAND_IN = resolve(__dirname, '../../../../tests/e2e/fixtures/pi-rpc-agent.mjs')

const children: ChildProcessWithoutNullStreams[] = []
const dirs: string[] = []
afterEach(() => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null && child.pid) {
      try {
        process.kill(child.pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pi-stand-in-'))
  dirs.push(dir)
  return dir
}

interface StandIn {
  child: ChildProcessWithoutNullStreams
  connection: PiRpcConnection
  events: PiRpcEvent[]
  exits: number[]
  stderr(): string
}

function standIn(
  state: string,
  args: string[] = ['--session-id', 'ses-one'],
  env: Record<string, string> = {}
): StandIn {
  const child = spawn(
    process.execPath,
    [PI_STAND_IN, '--mode', 'rpc', '--session-dir', state, ...args],
    { cwd: state, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  children.push(child)
  const events: PiRpcEvent[] = []
  const exits: number[] = []
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
  const connection = new PiRpcConnection(child, {
    event: (frame) => events.push(frame),
    error: () => {},
    exit: (code) => exits.push(code)
  })
  return { child, connection, events, exits, stderr: () => stderr }
}

const settled = (pi: StandIn, from = 0): boolean =>
  pi.events.slice(from).some((e) => e.type === 'agent_settled')
const frames = (state: string): Record<string, unknown>[] =>
  existsSync(join(state, 'frames.jsonl'))
    ? readFileSync(join(state, 'frames.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line).frame)
    : []
/** An event as a short word: its type, and a message_update's inner type. */
const shape = (e: PiRpcEvent): string => {
  if (e.type === 'message_update')
    return `update:${String((e.assistantMessageEvent as { type: string }).type)}`
  if (e.type === 'message_start' || e.type === 'message_end')
    return `${e.type}:${String((e.message as { role: string }).role)}`
  return e.type
}
const run = (args: string[], env: Record<string, string> = {}): SpawnSyncReturns<string> =>
  spawnSync(process.execPath, [PI_STAND_IN, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8'
  })

describe('the stand-in Pi', () => {
  it('argv: --version, --mode rpc required, a state dir required', () => {
    expect(run(['--version'])).toMatchObject({ status: 0, stdout: '1.5.2-stand-in\n' })
    const noMode = run([])
    expect(noMode.status).toBe(2)
    expect(noMode.stderr).toContain('usage')
    const env = { ...process.env }
    delete env.PI_STAND_IN_STATE
    const noState = spawnSync(process.execPath, [PI_STAND_IN, '--mode', 'rpc'], {
      env,
      encoding: 'utf8'
    })
    expect(noState.status).toBe(2)
  })

  it('get_state names the session, its file and the model', async () => {
    const state = stateDir()
    const pi = standIn(state, ['--session-id', 'ses-one', '--thinking', 'low'])
    const data = (await pi.connection.command('get_state')) as Record<string, unknown>
    expect(data).toMatchObject({
      model: { id: 'one', provider: 'stand-in', contextWindow: 200000 },
      thinkingLevel: 'low',
      isStreaming: false,
      sessionId: 'ses-one',
      sessionFile: expect.stringMatching(/_ses-one\.jsonl$/),
      messageCount: 0
    })
    const header = JSON.parse(readFileSync(data.sessionFile as string, 'utf8').split('\n')[0])
    expect(header).toMatchObject({ type: 'session', version: 3, id: 'ses-one' })
    await expect(pi.connection.command('get_commands')).resolves.toMatchObject({
      commands: [
        { name: 'init', source: 'prompt' },
        { name: 'compact', source: 'prompt' }
      ]
    })
    await expect(pi.connection.command('get_available_thinking_levels')).resolves.toEqual({
      levels: ['low', 'high', 'max']
    })
    await expect(pi.connection.command('frobnicate')).rejects.toThrow('Unknown command: frobnicate')
  })

  it('a prompt runs the exact event sequence, and writes the session file', async () => {
    const state = stateDir()
    const pi = standIn(state)
    await expect(pi.connection.command('prompt', { message: 'hello' })).resolves.toEqual({
      disposition: 'started'
    })
    await expect.poll(() => settled(pi)).toBe(true)
    expect(pi.events.map(shape)).toEqual([
      'agent_start',
      'turn_start',
      'message_start:user',
      'message_end:user',
      'message_start:assistant',
      'update:text_start',
      'update:text_delta',
      'update:text_delta',
      'update:text_end',
      'update:toolcall_start',
      'update:toolcall_delta',
      'update:toolcall_end',
      'message_end:assistant',
      'tool_execution_start',
      'tool_execution_end',
      'turn_end',
      'turn_start',
      'message_start:assistant',
      'update:text_start',
      'update:text_delta',
      'update:text_end',
      'message_end:assistant',
      'turn_end',
      'agent_end',
      'agent_settled'
    ])
    const deltas = pi.events
      .filter((e) => e.type === 'message_update')
      .map((e) => e.assistantMessageEvent as Record<string, unknown>)
      .filter((u) => u.type === 'text_delta')
      .map((u) => u.delta)
    expect(deltas).toEqual(['You said: ', 'hello', 'Done.'])
    expect(pi.events.find((e) => e.type === 'tool_execution_end')).toMatchObject({
      toolCallId: 'tc_1',
      result: { content: [{ type: 'text', text: '# Stand-in' }] },
      isError: false
    })
    expect(pi.events.at(-1)).toEqual({ type: 'agent_settled', aborted: false })
    const { messages } = (await pi.connection.command('get_messages')) as {
      messages: { role: string }[]
    }
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant'])
    await expect(pi.connection.command('get_session_stats')).resolves.toMatchObject({
      totalMessages: 4,
      contextUsage: { tokens: 48, contextWindow: 200000 }
    })
  })

  it('slow + abort: the run stops aborted, settled before the abort answers', async () => {
    const pi = standIn(stateDir())
    await pi.connection.command('prompt', { message: 'be slow' })
    await expect.poll(() => pi.events.some((e) => e.type === 'message_start')).toBe(true)
    const started = Date.now()
    await pi.connection.command('abort', undefined, { timeout: 5000 })
    expect(Date.now() - started).toBeLessThan(3000)
    // The abort's answer came after agent_settled: the events are already in.
    expect(pi.events.slice(-3).map(shape)).toEqual([
      'message_end:assistant',
      'agent_end',
      'agent_settled'
    ])
    expect(pi.events.at(-1)).toEqual({ type: 'agent_settled', aborted: true })
    expect((pi.events.at(-3)!.message as { stopReason: string }).stopReason).toBe('aborted')
    // Idle again: the next prompt starts.
    await expect(pi.connection.command('prompt', { message: 'again' })).resolves.toEqual({
      disposition: 'started'
    })
  })

  it('ask extension: a confirm dialog, then the echo of the answer', async () => {
    const pi = standIn(stateDir())
    await pi.connection.command('prompt', { message: 'ask extension' })
    await expect
      .poll(() => pi.events.find((e) => e.type === 'extension_ui_request'))
      .toMatchObject({ method: 'confirm', title: 'Proceed?', message: 'The stand-in asks.' })
    const request = pi.events.find((e) => e.type === 'extension_ui_request')!
    expect(settled(pi)).toBe(false)
    pi.connection.send({ type: 'extension_ui_response', id: request.id, confirmed: true })
    await expect.poll(() => settled(pi)).toBe(true)
    const first = pi.events.find(
      (e) =>
        e.type === 'message_update' &&
        (e.assistantMessageEvent as { type: string }).type === 'text_delta'
    )
    expect((first!.assistantMessageEvent as { delta: string }).delta).toBe('confirm: confirmed. ')

    const cancelled = standIn(stateDir())
    await cancelled.connection.command('prompt', { message: 'ask extension' })
    await expect
      .poll(() => cancelled.events.find((e) => e.type === 'extension_ui_request'))
      .toBeDefined()
    const ask = cancelled.events.find((e) => e.type === 'extension_ui_request')!
    cancelled.connection.send({ type: 'extension_ui_response', id: ask.id, cancelled: true })
    await expect.poll(() => settled(cancelled)).toBe(true)
    expect(
      cancelled.events.some(
        (e) =>
          e.type === 'message_update' &&
          (e.assistantMessageEvent as { delta?: string }).delta === 'confirm: cancelled. '
      )
    ).toBe(true)
  })

  it('notify extension sends a notify that waits for nothing', async () => {
    const pi = standIn(stateDir())
    await pi.connection.command('prompt', { message: 'notify extension' })
    await expect.poll(() => settled(pi)).toBe(true)
    expect(pi.events.find((e) => e.type === 'extension_ui_request')).toMatchObject({
      method: 'notify',
      message: 'Stand-in notice',
      notifyType: 'info'
    })
  })

  it('fail provider: the assistant message ends in error, then the run settles', async () => {
    const pi = standIn(stateDir())
    await expect(pi.connection.command('prompt', { message: 'fail provider' })).resolves.toEqual({
      disposition: 'started'
    })
    await expect.poll(() => settled(pi)).toBe(true)
    const end = pi.events.find(
      (e) => e.type === 'message_end' && (e.message as { role: string }).role === 'assistant'
    )
    expect(end?.message).toMatchObject({
      stopReason: 'error',
      errorMessage: 'Provider refused: stand-in'
    })
    expect(pi.events.slice(-2).map(shape)).toEqual(['agent_end', 'agent_settled'])
  })

  it('retry: an auto-retry before the normal run', async () => {
    const pi = standIn(stateDir())
    await pi.connection.command('prompt', { message: 'retry please' })
    await expect.poll(() => settled(pi)).toBe(true)
    expect(pi.events.slice(0, 3)).toEqual([
      { type: 'agent_start' },
      {
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1000,
        errorMessage: 'rate limited'
      },
      { type: 'auto_retry_end', success: true, attempt: 1 }
    ])
  })

  it('while streaming: a bare prompt is refused, a steer is queued and echoed after the turn', async () => {
    const pi = standIn(stateDir(), ['--session-id', 'ses-one'], { PI_STAND_IN_DELAY_MS: '40' })
    await pi.connection.command('prompt', { message: 'first' })
    await expect.poll(() => pi.events.some((e) => e.type === 'agent_start')).toBe(true)
    await expect(pi.connection.command('prompt', { message: 'nope' })).rejects.toThrow(
      'Agent is streaming'
    )
    await expect(pi.connection.command('steer', { message: 'steered' })).resolves.toEqual({
      disposition: 'queued'
    })
    await expect.poll(() => settled(pi), { timeout: 10_000 }).toBe(true)
    const deltas = pi.events
      .filter((e) => e.type === 'message_update')
      .map((e) => e.assistantMessageEvent as { type: string; delta?: string })
      .filter((u) => u.type === 'text_delta')
      .map((u) => u.delta)
    expect(deltas).toEqual(['You said: ', 'first', 'You said: ', 'steered', 'Done.'])
    const users = pi.events
      .filter((e) => e.type === 'message_end' && (e.message as { role: string }).role === 'user')
      .map((e) => (e.message as { content: string }).content)
    expect(users).toEqual(['first', 'steered'])
  })

  it('set_model switches to a listed model and refuses another; thinking levels likewise', async () => {
    const state = stateDir()
    const pi = standIn(state)
    await expect(
      pi.connection.command('set_model', { provider: 'stand-in', modelId: 'two' })
    ).resolves.toMatchObject({ id: 'two', provider: 'stand-in' })
    await expect(pi.connection.command('get_state')).resolves.toMatchObject({
      model: { id: 'two' }
    })
    const refused = await pi.connection
      .command('set_model', { provider: 'other', modelId: 'x' })
      .catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(PiRpcError)
    expect((refused as Error).message).toBe('Model not found: other/x')
    await expect(pi.connection.command('set_thinking_level', { level: 'max' })).resolves.toBe(
      undefined
    )
    await expect(pi.connection.command('set_thinking_level', { level: 'medium' })).rejects.toThrow(
      'Invalid thinking level'
    )
  })

  it('PI_STAND_IN_NO_MODEL: no model in the state, a prompt refused', async () => {
    const pi = standIn(stateDir(), ['--session-id', 'ses-one'], { PI_STAND_IN_NO_MODEL: '1' })
    const data = (await pi.connection.command('get_state')) as Record<string, unknown>
    expect('model' in data).toBe(false)
    await expect(pi.connection.command('prompt', { message: 'hi' })).rejects.toThrow(
      'No model selected'
    )
  })

  it('--session <id> resumes the file, --session unknown exits 1', async () => {
    const state = stateDir()
    const first = standIn(state)
    await first.connection.command('prompt', { message: 'remember me' })
    await expect.poll(() => settled(first)).toBe(true)
    await first.connection.close()

    const second = standIn(state, ['--session', 'ses-one'])
    const { messages } = (await second.connection.command('get_messages')) as {
      messages: { role: string; content: unknown }[]
    }
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'toolResult', 'assistant'])
    expect(messages[0].content).toBe('remember me')
    expect(readdirSync(state).filter((name) => name.endsWith('_ses-one.jsonl'))).toHaveLength(1)

    const unknown = run(['--mode', 'rpc', '--session-dir', state, '--session', 'nope'])
    expect(unknown.status).toBe(1)
    expect(unknown.stderr).toContain('Session not found')
  })

  it('records every frame it receives, answers non-JSON with a parse response, exits 0 on EOF', async () => {
    const state = stateDir()
    const pi = standIn(state)
    await pi.connection.command('get_state')
    pi.child.stdin.write('not json\n')
    await expect
      .poll(() => pi.events.find((e) => e.type === 'response'))
      .toMatchObject({ command: 'parse', success: false })
    expect(frames(state)).toEqual([{ id: 'c1', type: 'get_state' }])
    pi.child.stdin.end()
    await expect.poll(() => pi.exits).toEqual([0])
  })
})
