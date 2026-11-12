import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SessionEventSchema,
  type SessionControl,
  type SessionEvent
} from '../../../shared/session-model'
import { installTerminalPorts, resetTerminalPorts } from '../../ports/terminals'
const mock = vi.hoisted(() => ({
  spawn: vi.fn(),
  /** The MCP config port: no MCP server behind it unless a case says so. */
  mcpConfig: { write: vi.fn((): string | null => null), remove: vi.fn() },
  token: vi.fn(() => 'secret-account-token'),
  find: vi.fn((): string | null => null),
  profileArgs: ['--debug']
}))
vi.mock('node:child_process', () => ({ spawn: mock.spawn }))
// The binary is nowhere on the test PATH unless a case says so: the launch
// then takes the login-shell wrapper, which is what most cases exercise.
vi.mock('../../shell-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shell-launch')>()),
  findExecutable: mock.find
}))
vi.mock('../../launch-profile-manager', () => ({
  launchProfileManager: {
    resolve: () => ({
      id: 'custom',
      name: 'Custom',
      family: 'claude',
      command: ['claude'],
      additionalArgs: mock.profileArgs
    })
  }
}))
vi.mock('./pty-backend', () => ({
  accountTokenForSpawn: mock.token,
  buildSpawnEnv: (env, account) => ({
    ...env,
    CLAUDE_CONFIG_DIR: account.configDir,
    CLAUDE_CODE_OAUTH_TOKEN: account.oauthToken
  }),
  getLoginShellEnv: () => ({ PATH: '/test/bin' }),
  getUserShell: () => '/bin/zsh',
  buildClaudeHookSettingsArg: (id) => JSON.stringify({ hooks: id }),
  shellSingleQuote: (s) => `'${s.replace(/'/g, `'\\''`)}'`,
  isValidClaudeSessionId: (s) => /^[\w-]+$/.test(s)
}))
import {
  ClaudeAdapter,
  ClaudeStreamTranslator,
  HOST_COMMANDS,
  claudeModelOptions,
  resolvedDefaultModel
} from './claude-adapter'
import { formMessage } from '../../../shared/form-message'
import { foldModelOptions } from '../../../../plugins/chat-view/src/models'

/** What the adapter wrote to the CLI since the last read, without the
 *  get_settings reads it makes at ready and after every confirmed switch to
 *  learn the effort (their own tests read the raw stream); null when nothing
 *  else was written. */
function written(child: { stdin: PassThrough }): string | null {
  const raw = child.stdin.read() as Buffer | null
  if (!raw) return null
  const lines = raw
    .toString()
    .split('\n')
    .filter((line) => line && !line.includes('"subtype":"get_settings"'))
  return lines.length ? lines.map((line) => `${line}\n`).join('') : null
}
import { NdjsonLines } from './ndjson'
const spec = {
  id: 'test-session',
  provider: 'claude',
  transport: 'events' as const,
  cwd: '/tmp',
  windowKey: 'w',
  state: 'idle' as const,
  createdAt: 1,
  adapterId: 'claude-chat',
  title: 'test'
}
const events: SessionEvent[] = []
let translator: ClaudeStreamTranslator
beforeEach(() => {
  events.length = 0
  translator = new ClaudeStreamTranslator((e) => events.push(e))
  vi.clearAllMocks()
  // The adapter writes a session's --mcp-config through the terminal
  // layer's MCP config port (PRDCT-3293), never through the MCP runtime.
  installTerminalPorts({ mcpConfig: mock.mcpConfig })
})
afterEach(() => {
  vi.restoreAllMocks()
  resetTerminalPorts()
})
function feed(payload: unknown): void {
  translator.line(JSON.stringify(payload))
}
it('translates the real installed CLI transcript without duplicating text and preserves every line', () => {
  const lines = readFileSync(
    new URL('../fixtures/claude-stream/real-turn.ndjson', import.meta.url),
    'utf8'
  )
    .trim()
    .split('\n')
  for (const line of lines) {
    const before = events.length
    translator.line(line)
    expect(events.length).toBeGreaterThan(before)
  }
  expect(events[0]).toMatchObject({ type: 'session_meta', model: 'claude-opus-5[1m]' })
  expect(events.filter((e) => e.type === 'assistant_text')).toEqual([
    { type: 'assistant_text', delta: 'CLAVE_OK', final: false },
    { type: 'assistant_text', delta: '', final: true }
  ])
  expect(events.at(-1)).toEqual({ type: 'state_change', state: 'done' })
  expect(
    events.some(
      (e) => e.type === 'provider_event' && (e.payload as { type: string }).type === 'result'
    )
  ).toBe(true)
})
it('correlates tool results and offers only real permission updates', () => {
  feed({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 'tool1', name: 'Write', input: { file_path: '/tmp/x' } }]
    }
  })
  const request = {
    type: 'control_request',
    request_id: 'req1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Write',
      input: { file_path: '/tmp/x' },
      permission_suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Write' }],
          behavior: 'allow',
          destination: 'session'
        }
      ]
    }
  }
  feed(request)
  expect(events.find((e) => e.type === 'permission_request')).toMatchObject({
    id: 'req1',
    toolName: 'Write',
    options: [{ id: 'allow-once' }, { id: 'allow-always' }, { id: 'deny' }]
  })
  expect(() => translator.response('req1', 'invalid')).toThrow()
  expect(translator.response('req1', 'allow-always')).toMatchObject({
    type: 'control_response',
    response: {
      request_id: 'req1',
      response: {
        behavior: 'allow',
        updatedInput: request.request.input,
        updatedPermissions: request.request.permission_suggestions
      }
    }
  })
  expect(() => translator.response('req1', 'allow-once')).toThrow()
  feed({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tool1', content: 'written' }] }
  })
  expect(events.find((e) => e.type === 'tool_result')).toEqual({
    type: 'tool_result',
    id: 'tool1',
    output: 'written'
  })
  feed({
    ...request,
    request_id: 'req2',
    request: { ...request.request, permission_suggestions: [] }
  })
  expect(() => translator.response('req2', 'allow-always')).toThrow()
  expect(translator.response('req2', 'deny')).toMatchObject({
    response: { response: { behavior: 'deny' } }
  })
})
it('reports malformed lines, unknown events, cancellation, UTF-8 fragmentation and final unterminated lines', () => {
  const reader = new NdjsonLines((line) => translator.line(line))
  const bytes = Buffer.from('bad\n' + JSON.stringify({ type: 'future', text: 'été' }))
  for (const byte of bytes) reader.push(Buffer.from([byte]))
  reader.end()
  expect(events).toEqual([
    { type: 'error', message: expect.any(String), fatal: false },
    { type: 'provider_event', provider: 'claude', payload: { type: 'future', text: 'été' } }
  ])
  feed({
    type: 'control_request',
    request_id: 'cancel',
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} }
  })
  feed({ type: 'control_cancel_request', request_id: 'cancel' })
  expect(() => translator.response('cancel', 'deny')).toThrow()
  // The views settle the card on the adapter's own word, never on the raw frame.
  expect(events).toContainEqual({ type: 'permission_withdrawn', id: 'cancel' })
  expect(events.filter((e) => e.type === 'permission_withdrawn')).toHaveLength(1)
  // The word comes before the state word the cancel leaves on.
  expect(events.findIndex((e) => e.type === 'permission_withdrawn')).toBeLessThan(
    events.findLastIndex((e) => e.type === 'state_change' && e.state === 'working')
  )
  // A cancel naming no held request says nothing.
  feed({ type: 'control_cancel_request', request_id: 'never-asked' })
  expect(events.filter((e) => e.type === 'permission_withdrawn')).toHaveLength(1)
  // A request still open when the turn ends is withdrawn before the turn is done.
  feed({
    type: 'control_request',
    request_id: 'open',
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} }
  })
  feed({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's' })
  const withdrawn = events.findIndex((e) => e.type === 'permission_withdrawn' && e.id === 'open')
  const done = events.findIndex((e) => e.type === 'state_change' && e.state === 'done')
  expect(withdrawn).toBeGreaterThan(-1)
  expect(withdrawn).toBeLessThan(done)
  expect(() => translator.response('open', 'allow-once')).toThrow()
})
it('uses the shared shell/profile/account path, writes NDJSON and keeps secrets out of events', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  })
  mock.spawn.mockReturnValue(child)
  const adapter = new ClaudeAdapter()
  adapter.configure(spec.id, { configDir: '/account', claudeProfileId: 'account-id' })
  const handle = await adapter.spawn({
    ...spec,
    options: { resume: 'resume-id', model: 'opus[1m]', permissionMode: 'manual' }
  })
  expect(await adapter.attach(spec.id)).toBe(handle)
  adapter.on(handle, 'stream', (s) => {
    if (s.kind === 'event') events.push(s.event)
  })
  const exits: number[] = []
  adapter.on(handle, 'exit', (code) => exits.push(code))
  expect(mock.spawn).not.toHaveBeenCalled()
  expect(() => adapter.write(handle, new Uint8Array())).toThrow(/raw bytes/)
  adapter.write(handle, { type: 'user_message', text: 'Hello' })
  expect(mock.spawn.mock.calls[0][0]).toBe('/bin/zsh')
  const command = mock.spawn.mock.calls[0][1][2]
  expect(command).toContain("'--resume' 'resume-id'")
  expect(command).not.toContain('--session-id')
  expect(command).toContain("'--model' 'opus[1m]'")
  expect(command).toContain("'--permission-mode' 'manual'")
  expect(command).toContain("'--settings'")
  expect(command).toContain("'--debug'")
  expect(command).toContain("'--permission-prompts' 'host'")
  expect(mock.spawn.mock.calls[0][2].env).toMatchObject({
    CLAUDE_CONFIG_DIR: '/account',
    CLAUDE_CODE_OAUTH_TOKEN: 'secret-account-token',
    CLAVE_SESSION_ID: spec.id
  })
  expect(mock.token).toHaveBeenCalledWith('claude', 'account-id')
  child.stdout.write(
    JSON.stringify({
      type: 'control_request',
      request_id: 'p',
      request: { subtype: 'can_use_tool', tool_name: 'Write', input: { x: 1 } }
    }) + '\n'
  )
  adapter.write(handle, { type: 'user_message', text: 'queued while blocked' })
  expect(events.filter((event) => event.type === 'state_change').at(-1)).toEqual({
    type: 'state_change',
    state: 'blocked'
  })
  adapter.write(handle, { type: 'permission_response', id: 'p', optionId: 'allow-once' })
  // The person's typing into a form is the host's; the CLI never hears of it,
  // and above all it is not taken for an interrupt (PRDCT-4210).
  adapter.write(handle, { type: 'permission_draft', id: 'clave:f', answers: { name: 'x' } })
  adapter.write(handle, { type: 'interrupt' })
  const inputs = written(child)!
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(inputs[0]).toEqual({ type: 'user', message: { role: 'user', content: 'Hello' } })
  expect(inputs[2]).toMatchObject({
    response: { request_id: 'p', response: { behavior: 'allow', updatedInput: { x: 1 } } }
  })
  expect(inputs[3]).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } })
  expect(inputs).toHaveLength(4)
  child.emit('close', 7)
  expect(events.at(-1)).toEqual({ type: 'state_change', state: 'ended' })
  expect(exits).toEqual([7])
  expect(JSON.stringify(events)).not.toContain('secret-account-token')
  expect(() => adapter.write(handle, { type: 'user_message', text: 'late' })).toThrow(/ended/)
  await adapter.kill(handle)
  await expect(adapter.attach(spec.id)).rejects.toThrow()
})
it('reports spawn errors and emits ended before exit exactly once', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  })
  mock.spawn.mockReturnValue(child)
  const adapter = new ClaudeAdapter()
  const h = await adapter.spawn(spec)
  const order: unknown[] = []
  adapter.on(h, 'stream', (s) => order.push(s))
  adapter.on(h, 'exit', (n) => order.push(n))
  adapter.write(h, { type: 'user_message', text: 'hello' })
  child.emit('error', new Error('ENOENT'))
  child.emit('close', -2)
  expect(order.slice(-3)).toEqual([
    { kind: 'event', event: { type: 'error', message: 'ENOENT', fatal: true } },
    { kind: 'event', event: { type: 'state_change', state: 'ended' } },
    1
  ])
  await adapter.kill(h)
})

it('translates every recorded permission frame and supports the recorded denial response', () => {
  const lines = readFileSync(
    new URL('../fixtures/claude-stream/permission-turn.ndjson', import.meta.url),
    'utf8'
  )
    .trim()
    .split('\n')
  for (const line of lines) {
    const before = events.length
    translator.line(line)
    expect(events.length).toBeGreaterThan(before)
    const frame = JSON.parse(line)
    if (frame.type === 'control_request') {
      expect(translator.response(frame.request_id, 'deny')).toEqual({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: frame.request_id,
          response: { behavior: 'deny', message: 'Denied by user' }
        }
      })
    }
  }
  expect(events.filter((e) => e.type === 'error')).toEqual([])
  const call = events.find((e) => e.type === 'tool_call')
  expect(call).toBeDefined()
  expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ id: call!.id })
})

it('kills only the owned process group, escalates a stuck child, and cleans up the handle', async () => {
  vi.useFakeTimers()
  try {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: 987654
    })
    mock.spawn.mockReturnValue(child)
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGKILL') child.emit('exit', null)
      return true
    })
    const adapter = new ClaudeAdapter()
    const handle = await adapter.spawn(spec)
    adapter.on(handle, 'stream', (s) => {
      if (s.kind === 'event') events.push(s.event)
    })
    adapter.write(handle, { type: 'user_message', text: 'hello' })
    const closing = adapter.kill(handle)
    expect(kill).toHaveBeenCalledWith(-987654, 'SIGTERM')
    await vi.advanceTimersByTimeAsync(1000)
    await closing
    expect(kill).toHaveBeenCalledWith(-987654, 'SIGKILL')
    expect(events.at(-1)).toEqual({ type: 'state_change', state: 'ended' })
    await expect(adapter.attach(spec.id)).rejects.toThrow(/Unknown/)
  } finally {
    vi.useRealTimers()
  }
})

it('preserves plain-text user acknowledgements without duplicate rows or false errors', () => {
  const payload = { type: 'user', message: { role: 'user', content: 'already echoed' } }
  feed(payload)
  expect(events).toEqual([{ type: 'provider_event', provider: 'claude', payload }])
})

it('sends the configured initial prompt only on ready and refuses shell commands visibly', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  })
  mock.spawn.mockReturnValue(child)
  const adapter = new ClaudeAdapter()
  adapter.configure(spec.id, {
    initialPrompt: 'initial prompt',
    initialCommand: 'echo unsafe',
    autoExecute: true
  })
  const handle = await adapter.spawn(spec)
  adapter.on(handle, 'stream', (stream) => {
    if (stream.kind === 'event') events.push(stream.event)
  })
  expect(mock.spawn).not.toHaveBeenCalled()
  adapter.ready(handle)
  adapter.ready(handle)
  expect(events.filter((event) => event.type === 'user_message')).toEqual([
    { type: 'user_message', text: 'initial prompt' }
  ])
  expect(events.filter((event) => event.type === 'error')).toEqual([
    {
      type: 'error',
      message: expect.stringContaining('initialCommand and autoExecute'),
      fatal: false
    }
  ])
  // The default's resolution is asked first (PRDCT-4256), then the prompt.
  const [resolution, prompt, ...more] = written(child)!.trim().split('\n')
  expect(more).toEqual([])
  expect(JSON.parse(resolution)).toMatchObject({ request: { subtype: 'initialize' } })
  expect(prompt).toBe(
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'initial prompt' } })
  )
  // The prompt marks the session working at once, not at the init frame.
  expect(events.filter((event) => event.type === 'state_change')).toEqual([
    { type: 'state_change', state: 'working' }
  ])
  child.stdout.write(
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'provider-id', model: 'opus' }) +
      '\n'
  )
  expect(events.slice(-2)).toEqual([
    { type: 'session_meta', providerSessionId: 'provider-id', model: 'opus' },
    { type: 'state_change', state: 'working' }
  ])
  child.emit('close', 0)
  await adapter.kill(handle)
  await expect(adapter.spawn({ ...spec, options: { permissionMode: 'default' } })).rejects.toThrow()
})

it('names mode-changing permission suggestions and includes the tool in descriptions', () => {
  feed({
    type: 'control_request',
    request_id: 'mode',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Write',
      input: {},
      description: '/tmp/file',
      permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
    }
  })
  expect(events.find((event) => event.type === 'permission_request')).toMatchObject({
    description: 'Allow Write: /tmp/file',
    options: [
      { id: 'allow-once' },
      { id: 'allow-always', label: 'Switch session to acceptEdits' },
      { id: 'deny' }
    ]
  })
})

it('settles kill on process exit even when a setsid grandchild holds stdout open', async () => {
  const { spawn: realSpawn } =
    await vi.importActual<typeof import('node:child_process')>('node:child_process')
  let child: import('node:child_process').ChildProcessWithoutNullStreams | undefined
  let grandchildPid: number | undefined
  mock.spawn.mockImplementation(() => {
    child = realSpawn(
      process.execPath,
      [
        '-e',
        `
      const {spawn} = require('node:child_process');
      process.on('SIGTERM', () => {});
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true, stdio: ['ignore', process.stdout, process.stderr]
      });
      grandchild.unref();
      console.log(JSON.stringify({type: 'fixture', pid: grandchild.pid}));
      setInterval(() => {}, 1000);
    `
      ],
      { detached: true, stdio: 'pipe' }
    )
    return child
  })
  const adapter = new ClaudeAdapter()
  const handle = await adapter.spawn(spec)
  try {
    const descendant = new Promise<void>((resolve) => {
      adapter.on(handle, 'stream', (stream) => {
        if (stream.kind === 'event' && stream.event.type === 'provider_event') {
          const payload = stream.event.payload as { type: string; pid: number }
          if (payload.type === 'fixture') {
            grandchildPid = payload.pid
            resolve()
          }
        }
      })
    })
    adapter.write(handle, { type: 'user_message', text: 'start' })
    await descendant
    const started = Date.now()
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        adapter.kill(handle),
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('kill hung on inherited stdout')), 3000)
        })
      ])
    } finally {
      clearTimeout(deadline)
    }
    expect(Date.now() - started).toBeLessThan(3000)
    expect(child!.signalCode).toBe('SIGKILL')
    expect(process.kill(grandchildPid!, 0)).toBe(true)
    // Descendant still lives; shutdown has released its inherited pipe locally.
    expect(child!.stdout.destroyed).toBe(true)
    await expect(adapter.attach(spec.id)).rejects.toThrow(/Unknown/)
  } finally {
    if (grandchildPid) {
      try {
        process.kill(grandchildPid, 'SIGKILL')
      } catch {
        // Fixture descendant already exited.
      }
    }
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    child?.stdin.destroy()
    child?.stdout.destroy()
    child?.stderr.destroy()
    await adapter.kill(handle)
  }
})

it('retains the configured prompt when starting it throws and reports divergent provider identity', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  })
  mock.spawn
    .mockImplementationOnce(() => {
      throw new Error('temporary spawn error')
    })
    .mockReturnValue(child)
  const adapter = new ClaudeAdapter()
  adapter.configure(spec.id, { claudeSessionId: 'minted-id', initialPrompt: 'retry me' })
  const handle = await adapter.spawn(spec)
  adapter.on(handle, 'stream', (stream) => {
    if (stream.kind === 'event') events.push(stream.event)
  })
  expect(() => adapter.ready(handle)).toThrow('temporary spawn error')
  adapter.ready(handle)
  adapter.ready(handle)
  expect(written(child)).toContain('retry me')
  expect(events.filter((event) => event.type === 'user_message')).toHaveLength(1)
  child.stdout.write(
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'different-id', model: 'opus' }) +
      '\n'
  )
  expect(events).toContainEqual({
    type: 'session_meta',
    providerSessionId: 'different-id',
    model: 'opus'
  })
  expect(events).toContainEqual({
    type: 'error',
    message: expect.stringContaining('keeping the launch identity'),
    fatal: false
  })
  child.emit('close', 0)
  await adapter.kill(handle)
})

it('ends naturally with code 3 and flushes the last frame despite a setsid stdout holder', async () => {
  const { spawn: realSpawn } =
    await vi.importActual<typeof import('node:child_process')>('node:child_process')
  let child: import('node:child_process').ChildProcessWithoutNullStreams | undefined
  let grandchildPid: number | undefined
  mock.spawn.mockImplementation(() => {
    child = realSpawn(
      process.execPath,
      [
        '-e',
        `
      const {spawn} = require('node:child_process');
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true, stdio: ['ignore', process.stdout, process.stderr]
      });
      grandchild.unref();
      console.log(JSON.stringify({type: 'fixture', pid: grandchild.pid}));
      process.stdout.write(JSON.stringify({type: 'last-frame', text: 'unterminated'}), () => process.exit(3));
    `
      ],
      { detached: true, stdio: 'pipe' }
    )
    return child
  })
  const adapter = new ClaudeAdapter()
  const handle = await adapter.spawn(spec)
  const order: unknown[] = []
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    adapter.on(handle, 'stream', (stream) => {
      if (stream.kind !== 'event') return
      order.push(stream.event)
      if (stream.event.type === 'provider_event') {
        const payload = stream.event.payload as { type: string; pid: number }
        if (payload.type === 'fixture') grandchildPid = payload.pid
      }
    })
    const exited = new Promise<number>((resolve) =>
      adapter.on(handle, 'exit', (code) => {
        order.push(code)
        resolve(code)
      })
    )
    adapter.write(handle, { type: 'user_message', text: 'start' })
    expect(
      await Promise.race([
        exited,
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error('natural exit hung on inherited stdout')),
            3000
          )
        })
      ])
    ).toBe(3)
    expect(order.slice(-3)).toEqual([
      {
        type: 'provider_event',
        provider: 'claude',
        payload: { type: 'last-frame', text: 'unterminated' }
      },
      { type: 'state_change', state: 'ended' },
      3
    ])
    expect(child!.stdout.destroyed).toBe(true)
    expect(process.kill(grandchildPid!, 0)).toBe(true)
    expect(mock.mcpConfig.remove).toHaveBeenCalledExactlyOnceWith(spec.id)
    expect(() => adapter.write(handle, { type: 'user_message', text: 'late' })).toThrow(/ended/)
  } finally {
    clearTimeout(deadline)
    if (grandchildPid) {
      try {
        process.kill(grandchildPid, 'SIGKILL')
      } catch {
        /* already exited */
      }
    }
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    child?.stdin.destroy()
    child?.stdout.destroy()
    child?.stderr.destroy()
    await adapter.kill(handle)
  }
})
it('carries the CLI word that a tool failed, and says nothing when it did not', () => {
  feed({
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: 'ok', content: 'Error: in the file I read' },
        { type: 'tool_result', tool_use_id: 'bad', content: 'permission denied', is_error: true },
        { type: 'tool_result', tool_use_id: 'said-no', content: 'fine', is_error: false }
      ]
    }
  })
  const results = events.filter((e) => e.type === 'tool_result')
  // The failure is the CLI's flag, never the prose: the first result READS like
  // an error and is not one, which is exactly why this view may not guess.
  expect(results).toEqual([
    { type: 'tool_result', id: 'ok', output: 'Error: in the file I read', error: undefined },
    { type: 'tool_result', id: 'bad', output: 'permission denied', error: true },
    { type: 'tool_result', id: 'said-no', output: 'fine', error: false }
  ])
  // The flag must survive the contract, not merely fail to crash it: zod strips
  // an unknown key silently, so `not.toThrow()` would pass with no field at all.
  expect(results.map((e) => SessionEventSchema.parse(e))).toMatchObject([
    { error: undefined },
    { error: true },
    { error: false }
  ])
})
it('lists the models by version, asking the CLI itself, starting a session that has not spoken yet', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  })
  mock.spawn.mockReturnValue(child)
  const adapter = new ClaudeAdapter()
  const handle = await adapter.spawn(spec)
  expect(mock.spawn).not.toHaveBeenCalled()
  const listed = adapter.models(handle)
  expect(mock.spawn).toHaveBeenCalledTimes(1)
  const request = JSON.parse(written(child)!)
  expect(request).toMatchObject({ type: 'control_request', request: { subtype: 'initialize' } })
  child.stdout.write(
    JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: request.request_id,
        response: {
          models: [
            {
              value: 'default',
              resolvedModel: 'claude-opus-5-5',
              displayName: 'Default (recommended)',
              description: 'Opus 5.5 · Best for everyday, complex tasks'
            },
            { value: 'haiku', displayName: 'Haiku' },
            // Shipped after this build: kept, named from its own id.
            {
              value: 'claude-opus-6',
              resolvedModel: 'claude-opus-6',
              displayName: 'Opus 6',
              description: 'Opus 6 · Newer'
            }
          ]
        }
      }
    }) + '\n'
  )
  // No row for the CLI's `default` alias: the model it resolves to carries
  // the Default gloss on its own row, and picking it sends that model's id
  // (PRDCT-4256, PRDCT-4257).
  await expect(listed).resolves.toEqual([
    {
      id: 'claude-opus-5-5',
      label: 'Opus 5.5',
      hint: 'Default · Best for everyday, complex tasks',
      resolved: 'claude-opus-5-5'
    },
    { id: 'claude-fable-5-1[1m]', label: 'Fable 5.1', resolved: 'claude-fable-5-1' },
    {
      id: 'claude-fable-5[1m]',
      label: 'Fable 5',
      hint: 'Earlier version',
      resolved: 'claude-fable-5'
    },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', resolved: 'claude-sonnet-5-5' },
    {
      id: 'claude-haiku-4-5-20251001',
      label: 'Haiku 4.5',
      resolved: 'claude-haiku-4-5-20251001'
    },
    { id: 'claude-opus-6', label: 'Opus 6', hint: 'Opus 6 · Newer', resolved: 'claude-opus-6' }
  ])
  // A second ask reuses the running process and says why when the CLI refuses.
  const refused = adapter.models(handle)
  const again = JSON.parse(written(child)!)
  child.stdout.write(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'error', request_id: again.request_id, error: 'nope' }
    }) + '\n'
  )
  await expect(refused).rejects.toThrow('nope')
  expect(mock.spawn).toHaveBeenCalledTimes(1)
  // One still waiting when the process ends is told so, not left hanging.
  const orphan = adapter.models(handle)
  child.emit('close', 0)
  await expect(orphan).rejects.toThrow(/ended/)
  await expect(adapter.models(handle)).rejects.toThrow(/ended/)
  await adapter.kill(handle)
})
describe('control requests', () => {
  type FakeChild = EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough }
  const fakeChild = (): FakeChild =>
    Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough()
    })
  const answer = (child: FakeChild, requestId: string, response: Record<string, unknown>): void => {
    child.stdout.write(
      JSON.stringify({
        type: 'control_response',
        response: { request_id: requestId, ...response }
      }) + '\n'
    )
  }
  it.each<[SessionControl, Record<string, unknown>]>([
    [{ type: 'mcp_status' }, { subtype: 'mcp_status' }],
    [
      { type: 'mcp_toggle', server: 'github', enabled: false },
      { subtype: 'mcp_toggle', serverName: 'github', enabled: false }
    ],
    [
      { type: 'mcp_reconnect', server: 'github' },
      { subtype: 'mcp_reconnect', serverName: 'github' }
    ],
    [
      { type: 'mcp_authenticate', server: 'github' },
      { subtype: 'mcp_authenticate', serverName: 'github' }
    ],
    [
      { type: 'mcp_clear_auth', server: 'github' },
      { subtype: 'mcp_clear_auth', serverName: 'github' }
    ],
    [{ type: 'reload_plugins' }, { subtype: 'reload_plugins' }]
  ])(
    'sends %j as the exact control request and answers the CLI’s response',
    async (control, body) => {
      const child = fakeChild()
      mock.spawn.mockReturnValue(child)
      const adapter = new ClaudeAdapter()
      const handle = await adapter.spawn(spec)
      expect(mock.spawn).not.toHaveBeenCalled()
      const answered = adapter.control(handle, control)
      // A session that has not spoken yet is started to ask it.
      expect(mock.spawn).toHaveBeenCalledTimes(1)
      const request = JSON.parse(written(child)!)
      expect(request).toEqual({
        type: 'control_request',
        request_id: request.request_id,
        request: body
      })
      expect(request.request_id).toEqual(expect.any(String))
      const response = { mcpServers: [{ name: 'github', status: 'connected' }] }
      answer(child, request.request_id, { subtype: 'success', response })
      await expect(answered).resolves.toEqual(response)
      child.emit('close', 0)
      await adapter.kill(handle)
    }
  )
  it('rejects with the CLI’s own words when it refuses, and a fixed one when it gives none', async () => {
    const child = fakeChild()
    mock.spawn.mockReturnValue(child)
    const adapter = new ClaudeAdapter()
    const handle = await adapter.spawn(spec)
    const refused = adapter.control(handle, { type: 'mcp_reconnect', server: 'gone' })
    answer(child, JSON.parse(written(child)!).request_id, {
      subtype: 'error',
      error: 'Server not found: gone'
    })
    await expect(refused).rejects.toThrow('Server not found: gone')
    const silent = adapter.control(handle, { type: 'mcp_reconnect', server: 'gone' })
    answer(child, JSON.parse(written(child)!).request_id, { subtype: 'error' })
    await expect(silent).rejects.toThrow('Claude refused the request')
    child.emit('close', 0)
    await adapter.kill(handle)
  })
  it('keeps the initialize refusal it always gave when the CLI names no reason', async () => {
    const child = fakeChild()
    mock.spawn.mockReturnValue(child)
    const adapter = new ClaudeAdapter()
    const handle = await adapter.spawn(spec)
    const refused = adapter.models(handle)
    answer(child, JSON.parse(written(child)!).request_id, { subtype: 'error' })
    await expect(refused).rejects.toThrow('Claude did not answer initialize')
    child.emit('close', 0)
    await adapter.kill(handle)
  })
  it('refuses on a session that has ended', async () => {
    const child = fakeChild()
    mock.spawn.mockReturnValue(child)
    const adapter = new ClaudeAdapter()
    const handle = await adapter.spawn(spec)
    const pending = adapter.control(handle, { type: 'mcp_status' })
    child.emit('close', 0)
    await expect(pending).rejects.toThrow('Claude session has ended')
    await expect(adapter.control(handle, { type: 'reload_plugins' })).rejects.toThrow(
      'Claude session has ended'
    )
    await adapter.kill(handle)
  })
})
it.each(['sonnet', 'opus[1m]', 'claude-opus-5-5[1m]'])(
  'switches to %s before the first message using the real model validator',
  async (model) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough()
    })
    mock.spawn.mockReturnValue(child)
    const adapter = new ClaudeAdapter()
    const handle = await adapter.spawn(spec)
    adapter.on(handle, 'stream', (s) => {
      if (s.kind === 'event') events.push(s.event)
    })
    expect(() => adapter.write(handle, { type: 'interrupt' })).toThrow(/not started/)
    expect(() => adapter.write(handle, { type: 'set_model', model: 'opus[1m];echo bad' })).toThrow(
      'Invalid model name'
    )
    expect(mock.spawn).not.toHaveBeenCalled()
    adapter.write(handle, { type: 'set_model', model })
    expect(mock.spawn).toHaveBeenCalledTimes(1)
    const request = JSON.parse(written(child)!)
    expect(request).toMatchObject({
      type: 'control_request',
      request: { subtype: 'set_model', model }
    })
    child.stdout.write(
      JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: request.request_id }
      }) + '\n'
    )
    expect(events.at(-1)).toEqual({ type: 'session_meta', model, providerSessionId: null })
    // The first message then goes to the same process.
    adapter.write(handle, { type: 'user_message', text: 'Hello' })
    expect(mock.spawn).toHaveBeenCalledTimes(1)
    expect(JSON.parse(written(child)!)).toEqual({
      type: 'user',
      message: { role: 'user', content: 'Hello' }
    })
    child.emit('close', 0)
    await adapter.kill(handle)
  }
)
it('a refused set_model says why and names no model: the session keeps the one it ran (PRDCT-4302, integration round 1, G3)', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  })
  mock.spawn.mockReturnValue(child)
  const adapter = new ClaudeAdapter()
  const handle = await adapter.spawn(spec)
  adapter.on(handle, 'stream', (s) => {
    if (s.kind === 'event') events.push(s.event)
  })
  adapter.write(handle, { type: 'set_model', model: 'claude-opus-5-5' })
  const request = JSON.parse(written(child)!)
  const before = events.length
  child.stdout.write(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'error', request_id: request.request_id, error: 'no such model here' }
    }) + '\n'
  )
  const after = events.slice(before)
  expect(after).toEqual([{ type: 'error', message: 'no such model here', fatal: false }])
  expect(after.some((e) => e.type === 'session_meta')).toBe(false)
  child.emit('close', 0)
  await adapter.kill(handle)
})
it('switches the permission mode the way Shift+Tab does, and says why the CLI refused', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  })
  mock.spawn.mockReturnValue(child)
  const adapter = new ClaudeAdapter()
  const handle = await adapter.spawn({ ...spec, options: { permissionMode: 'manual' } })
  adapter.on(handle, 'stream', (s) => {
    if (s.kind === 'event') events.push(s.event)
  })
  adapter.ready(handle)
  // The default's resolution went out at ready (PRDCT-4256); the rest is the test's.
  expect(JSON.parse(written(child)!)).toMatchObject({ request: { subtype: 'initialize' } })
  // The launch's `manual` is the running `default`, and bypass is not offered
  // to a session that was not launched on it.
  const offered = events.find((e) => e.type === 'permission_mode')
  expect(offered).toEqual({
    type: 'permission_mode',
    mode: 'default',
    modes: [
      { id: 'default', label: 'Manual' },
      { id: 'acceptEdits', label: 'Accept edits' },
      { id: 'plan', label: 'Plan' },
      { id: 'auto', label: 'Auto' }
    ]
  })
  expect(() =>
    adapter.write(handle, { type: 'set_permission_mode', mode: 'bypassPermissions' })
  ).toThrow(/Unknown permission mode/)
  adapter.write(handle, { type: 'set_permission_mode', mode: 'plan' })
  const request = JSON.parse(written(child)!)
  expect(request).toMatchObject({
    type: 'control_request',
    request: { subtype: 'set_permission_mode', mode: 'plan' }
  })
  child.stdout.write(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: request.request_id, response: { mode: 'plan' } }
    }) + '\n'
  )
  expect(events.at(-1)).toMatchObject({ type: 'permission_mode', mode: 'plan' })
  // A refusal reaches the reader in the CLI's own words, and the mode stays.
  adapter.write(handle, { type: 'set_permission_mode', mode: 'auto' })
  const auto = JSON.parse(written(child)!)
  child.stdout.write(
    JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: auto.request_id,
        error: 'Cannot set permission mode to auto: auto mode unavailable for this model'
      }
    }) + '\n'
  )
  expect(events.at(-1)).toEqual({
    type: 'error',
    message: 'Cannot set permission mode to auto: auto mode unavailable for this model',
    fatal: false
  })
  // A change the CLI makes itself (a plan approved) arrives as a status frame.
  child.stdout.write(
    JSON.stringify({
      type: 'system',
      subtype: 'status',
      status: null,
      permissionMode: 'acceptEdits'
    }) + '\n'
  )
  expect(events.filter((e) => e.type === 'permission_mode').at(-1)).toMatchObject({
    mode: 'acceptEdits'
  })
  child.emit('close', 0)
  await adapter.kill(handle)
})
it('offers bypass, and the way back to it, only to a session launched on it', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  })
  mock.spawn.mockReturnValue(child)
  const adapter = new ClaudeAdapter()
  const handle = await adapter.spawn({ ...spec, options: { permissionMode: 'bypassPermissions' } })
  adapter.on(handle, 'stream', (s) => {
    if (s.kind === 'event') events.push(s.event)
  })
  adapter.ready(handle)
  expect(JSON.parse(written(child)!)).toMatchObject({ request: { subtype: 'initialize' } })
  const offered = events.find((e) => e.type === 'permission_mode')
  expect(offered).toMatchObject({ mode: 'bypassPermissions' })
  expect(offered?.type === 'permission_mode' && offered.modes.map((m) => m.id)).toEqual([
    'default',
    'acceptEdits',
    'plan',
    'auto',
    'bypassPermissions'
  ])
  adapter.write(handle, { type: 'set_permission_mode', mode: 'bypassPermissions' })
  expect(JSON.parse(written(child)!)).toMatchObject({
    request: { subtype: 'set_permission_mode', mode: 'bypassPermissions' }
  })
  child.emit('close', 0)
  await adapter.kill(handle)
})
it('starts the process at ready so its boot overlaps the typing, and once only', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  })
  mock.spawn.mockReturnValue(child)
  const adapter = new ClaudeAdapter()
  const handle = await adapter.spawn(spec)
  adapter.on(handle, 'stream', (s) => {
    if (s.kind === 'event') events.push(s.event)
  })
  expect(mock.spawn).not.toHaveBeenCalled()
  adapter.ready(handle)
  expect(mock.spawn).toHaveBeenCalledTimes(1)
  // Booting is silent: the model and mode announcements, and no turn, no state.
  expect(events.map((e) => e.type)).toEqual(['session_meta', 'permission_mode'])
  expect(events[0]).toEqual({ type: 'session_meta', model: null, providerSessionId: null })
  // The one thing written is the ask of which model the default is (PRDCT-4256).
  const [resolution, ...more] = written(child)!.trim().split('\n')
  expect(more).toEqual([])
  expect(JSON.parse(resolution)).toMatchObject({
    type: 'control_request',
    request: { subtype: 'initialize' }
  })
  adapter.ready(handle)
  adapter.write(handle, { type: 'user_message', text: 'Hello' })
  expect(mock.spawn).toHaveBeenCalledTimes(1)
  // The first message is working before the CLI has said a word.
  expect(events.slice(2)).toEqual([
    { type: 'user_message', text: 'Hello' },
    { type: 'state_change', state: 'working' }
  ])
  child.emit('close', 0)
  await adapter.kill(handle)
})
it('starts the binary directly when the login PATH places it, wrapper otherwise', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  })
  mock.spawn.mockReturnValue(child)
  mock.find.mockReturnValueOnce('/resolved/bin/claude')
  const adapter = new ClaudeAdapter()
  adapter.configure(spec.id, { claudeSessionId: 'minted-id' })
  const handle = await adapter.spawn({ ...spec, options: { model: 'sonnet' } })
  adapter.ready(handle)
  expect(mock.find).toHaveBeenCalledWith('claude', '/test/bin')
  const [file, args, options] = mock.spawn.mock.calls[0]
  expect(file).toBe('/resolved/bin/claude')
  // The argv the wrapper would have quoted, minus the command, unquoted.
  expect(args.slice(0, 5)).toEqual(['--debug', '--session-id', 'minted-id', '--model', 'sonnet'])
  expect(args).toContain('--permission-prompt-tool')
  expect(args).not.toContain('claude')
  expect(args.some((a: string) => a.includes("'"))).toBe(false)
  expect(options.env.PATH).toBe('/test/bin')
  expect(options.env.CLAVE_SESSION_ID).toBe(spec.id)
  child.emit('close', 0)
  await adapter.kill(handle)
})
it('asks AskUserQuestion as questions and answers with the reader choices', () => {
  const input = {
    questions: [
      {
        question: 'Which color do you prefer?',
        header: 'Color',
        options: [{ label: 'Red', description: 'The color red' }, { label: 'Blue' }],
        multiSelect: false
      }
    ]
  }
  feed({
    type: 'control_request',
    request_id: 'q1',
    request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input }
  })
  expect(events[0]).toMatchObject({
    type: 'permission_request',
    id: 'q1',
    description: 'Which color do you prefer?',
    questions: input.questions,
    options: [
      { id: 'answer', label: 'Submit' },
      { id: 'deny', label: 'Skip' }
    ]
  })
  expect(events[1]).toEqual({ type: 'state_change', state: 'blocked' })
  // An answer without a choice would hand the model nothing: refused.
  expect(() => translator.response('q1', 'answer', {})).toThrow(/at least one/)
  expect(() => translator.response('q1', 'allow-once')).toThrow(/Invalid/)
  // The shape the real CLI turns into "…"Which color do you prefer?"="Blue"".
  expect(translator.response('q1', 'answer', { 'Which color do you prefer?': 'Blue' })).toEqual({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'q1',
      response: {
        behavior: 'allow',
        updatedInput: { ...input, answers: { 'Which color do you prefer?': 'Blue' } }
      }
    }
  })
  // Skipping tells the model the reader chose not to answer.
  feed({
    type: 'control_request',
    request_id: 'q2',
    request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input }
  })
  expect(translator.response('q2', 'deny')).toMatchObject({
    response: { response: { behavior: 'deny', message: 'The user skipped the question' } }
  })
  // A tool permission is unchanged, and carries the CLI's reason as detail.
  feed({
    type: 'control_request',
    request_id: 'p1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'Write',
      input: { file_path: '/x' },
      description: 'Path is outside allowed working directories'
    }
  })
  expect(events.at(-2)).toMatchObject({
    id: 'p1',
    detail: 'Path is outside allowed working directories'
  })
  expect(events.at(-2)).not.toHaveProperty('questions')
  expect(() => translator.response('p1', 'answer', { a: 'b' })).toThrow(/Invalid/)
})

it('replays a resumed transcript as the events a live turn would have produced', () => {
  const lines = [
    { type: 'permission-mode', permissionMode: 'default' },
    { type: 'user', isMeta: true, message: { role: 'user', content: 'Caveat: local commands' } },
    {
      type: 'user',
      message: {
        role: 'user',
        content: '<command-name>/exos:lane</command-name><command-args>clave 2527</command-args>'
      }
    },
    {
      type: 'user',
      message: { role: 'user', content: '<local-command-stdout>ok</local-command-stdout>' }
    },
    { type: 'user', message: { role: 'user', content: 'Fix the capture scan' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Looking.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/x' } }
        ]
      }
    },
    {
      type: 'user',
      message: {
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a\nb', is_error: true }]
      }
    },
    {
      type: 'assistant',
      isSidechain: true,
      message: { content: [{ type: 'text', text: 'subagent' }] }
    },
    'not json',
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }
    },
    {
      type: 'user',
      message: { role: 'user', content: '[Request interrupted by user for tool use]' }
    }
  ].map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
  const replayed = translator.replay(lines).map((item) => item.event)
  // The past is returned for a view to page through, never streamed.
  expect(events).toEqual([])
  expect(replayed).toEqual([
    { type: 'user_message', text: '/exos:lane clave 2527' },
    { type: 'user_message', text: 'Fix the capture scan' },
    { type: 'assistant_text', delta: 'Looking.', final: true },
    { type: 'tool_call', id: 't1', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_call', id: 't2', name: 'Read', input: { file_path: '/x' } },
    { type: 'tool_result', id: 't1', output: 'a\nb', error: true },
    { type: 'assistant_text', delta: 'Done.', final: true },
    // The CLI's interrupt acknowledgements, in either shape: the turn they
    // closed reads interrupted, never as a message the reader typed.
    { type: 'turn_interrupted' },
    { type: 'turn_interrupted' },
    // Never answered in the transcript: closed rather than left running.
    { type: 'tool_result', id: 't2', output: undefined }
  ])
  for (const event of replayed) expect(SessionEventSchema.safeParse(event).success).toBe(true)
})
it("keeps every message of the person on replay, and drops the CLI's own rows by their exact tag (PRDCT-4301)", () => {
  const user = (content: unknown): string =>
    JSON.stringify({ type: 'user', message: { role: 'user', content } })
  const answer = (text: string): string =>
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
  const replayed = translator
    .replay([
      user('<div>pasted html the person typed</div> what does this do?'),
      answer('A block.'),
      user([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } }]),
      answer('A picture.'),
      user('Caveat: the person really started with Caveat:'),
      answer('Noted.'),
      user('<local-command-stdout>ok</local-command-stdout>'),
      user('<local-command-stderr>oops</local-command-stderr>'),
      user('<task-notification>a background task ended</task-notification>'),
      user('<system-reminder>injected without the meta mark</system-reminder>'),
      user('<3 you'),
      answer('Likewise.')
    ])
    .map((item) => item.event)
  // Each message of the person opens its own turn: the old rule dropped a
  // text by its first character, and the next answer merged into the turn
  // before (lane C's verifier, round 1, B1).
  expect(
    replayed.map((e) =>
      e.type === 'user_message' ? `U:${e.text}` : e.type === 'assistant_text' ? 'A' : e.type
    )
  ).toEqual([
    'U:<div>pasted html the person typed</div> what does this do?',
    'A',
    'U:[Image]',
    'A',
    'U:Caveat: the person really started with Caveat:',
    'A',
    'U:<3 you',
    'A'
  ])
})
it("learns the past's tool ids on replay, so a live frame naming one again emits no second call (PRDCT-4301, verifier round 1 F9)", () => {
  translator.replay([
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 't-past', name: 'Bash', input: { command: 'ls' } }]
      }
    })
  ])
  translator.line(
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 't-past', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_use', id: 't-new', name: 'Read', input: { file_path: '/x' } }
        ]
      }
    })
  )
  expect(events.filter((e) => e.type === 'tool_call').map((e) => (e as { id: string }).id)).toEqual(
    ['t-new']
  )
})
it('dates each replayed event by its transcript line, and closes a dead call at the next message', () => {
  const at = (iso: string): number => Date.parse(iso)
  const items = translator.replay(
    [
      {
        type: 'user',
        timestamp: '2026-09-01T10:00:00.000Z',
        message: { role: 'user', content: 'first' }
      },
      {
        type: 'assistant',
        timestamp: '2026-09-01T10:00:05.000Z',
        message: { content: [{ type: 'tool_use', id: 'lost', name: 'Bash', input: {} }] }
      },
      // No timestamp: the event goes undated rather than dated wrongly.
      { type: 'user', message: { role: 'user', content: 'second' } }
    ].map((line) => JSON.stringify(line))
  )
  expect(items).toEqual([
    { event: { type: 'user_message', text: 'first' }, at: at('2026-09-01T10:00:00.000Z') },
    {
      event: { type: 'tool_call', id: 'lost', name: 'Bash', input: {} },
      at: at('2026-09-01T10:00:05.000Z')
    },
    // Closed before the reader spoke again, not at the transcript's end, so the
    // call never ties every later turn to it and a page may begin at each.
    { event: { type: 'tool_result', id: 'lost', output: undefined } },
    { event: { type: 'user_message', text: 'second' } }
  ])
})
it("replays a form's outcome with its marker, in either shape the transcript keeps a user message (PRDCT-4157)", () => {
  const text = formMessage({
    id: 'r1',
    form: 'clave:35e6218e-85f6-4dc0-9b19-366bf927d351',
    description: 'Four things before this machine is set up.',
    questions: [{ id: 'login', question: 'Your GitHub login' }],
    answers: { login: 'luca-a' }
  })
  const items = translator.replay(
    [
      { type: 'user', message: { role: 'user', content: text } },
      { type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } },
      { type: 'user', message: { role: 'user', content: 'and a word of my own' } }
    ].map((line) => JSON.stringify(line))
  )
  expect(items.map((item) => item.event)).toEqual([
    { type: 'user_message', text, form: 'clave:35e6218e-85f6-4dc0-9b19-366bf927d351' },
    { type: 'user_message', text, form: 'clave:35e6218e-85f6-4dc0-9b19-366bf927d351' },
    { type: 'user_message', text: 'and a word of my own' }
  ])
})
it('keeps a resumed past in main for the view to page, and streams none of it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clave-history-'))
  vi.stubEnv('CLAVE_TRANSCRIPTS_ROOT', root)
  mkdirSync(join(root, '-tmp'))
  const turns = Array.from({ length: 3 }, (_, i) => [
    JSON.stringify({ type: 'user', message: { role: 'user', content: `question ${i}` } }),
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: `answer ${i}` }] }
    })
  ]).flat()
  writeFileSync(join(root, '-tmp', 'resume-id.jsonl'), turns.join('\n'))
  mock.spawn.mockReturnValue(
    Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn()
    })
  )
  try {
    const adapter = new ClaudeAdapter()
    const handle = await adapter.spawn({ ...spec, options: { resume: 'resume-id' } })
    adapter.on(handle, 'stream', (s) => {
      if (s.kind === 'event') events.push(s.event)
    })
    adapter.ready(handle)
    expect(events.map((e) => e.type)).toEqual(['session_meta', 'permission_mode'])
    const history = adapter.history(handle)
    expect(history.map((item) => item.event)).toEqual(
      [0, 1, 2].flatMap((i) => [
        { type: 'user_message', text: `question ${i}` },
        { type: 'assistant_text', delta: `answer ${i}`, final: true }
      ])
    )
    // Read once, at readiness: every later ask is served from main, even once
    // the file is gone.
    rmSync(join(root, '-tmp', 'resume-id.jsonl'))
    expect(adapter.history(handle)).toBe(history)
  } finally {
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  }
})
it('reports an interrupted turn as interrupted, not as a failed one', () => {
  // Recorded 2026-09-24 from Claude Code with `--model haiku`: an interrupt
  // control_request mid-answer. The CLI acknowledges the interrupt as a user
  // text block, then closes the turn with an is_error result carrying no text.
  const interruptedResult = {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    terminal_reason: 'aborted_streaming',
    errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
    duration_ms: 5235,
    num_turns: 2,
    session_id: 's'
  }
  feed({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '1\n2\n3' }] }
  })
  feed({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] }
  })
  feed(interruptedResult)
  expect(events.filter((e) => e.type === 'error')).toEqual([])
  expect(events.filter((e) => e.type === 'user_message')).toEqual([])
  expect(events.slice(-3)).toEqual([
    { type: 'turn_interrupted' },
    { type: 'provider_event', provider: 'claude', payload: interruptedResult },
    { type: 'state_change', state: 'done' }
  ])
  // The acknowledgement is consumed by that result: the next failure is a failure.
  events.length = 0
  feed({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's' })
  expect(events.filter((e) => e.type === 'error')).toEqual([
    { type: 'error', message: 'Claude turn failed', fatal: false }
  ])
  expect(events.some((e) => e.type === 'turn_interrupted')).toBe(false)
})
it("takes the adapter's own interrupt as the word too, until the next message", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  })
  mock.spawn.mockReturnValue(child)
  const adapter = new ClaudeAdapter()
  const handle = await adapter.spawn(spec)
  const streamed: SessionEvent[] = []
  adapter.on(handle, 'stream', (s) => {
    if (s.kind === 'event') streamed.push(s.event)
  })
  adapter.write(handle, { type: 'user_message', text: 'count' })
  adapter.write(handle, { type: 'interrupt' })
  // A CLI that never writes the acknowledgement still closes the turn as an error.
  child.stdout.write(
    `${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true })}\n`
  )
  await new Promise((resolve) => setImmediate(resolve))
  expect(streamed.some((e) => e.type === 'turn_interrupted')).toBe(true)
  expect(streamed.some((e) => e.type === 'error')).toBe(false)
  // A new message withdraws the word: its own failure reads as one.
  adapter.write(handle, { type: 'user_message', text: 'again' })
  child.stdout.write(
    `${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true })}\n`
  )
  await new Promise((resolve) => setImmediate(resolve))
  expect(streamed.filter((e) => e.type === 'turn_interrupted')).toHaveLength(1)
  expect(streamed.filter((e) => e.type === 'error')).toEqual([
    { type: 'error', message: 'Claude turn failed', fatal: false }
  ])
})
it('offers the host /resume before the commands the CLI lists at initialize', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  })
  mock.spawn.mockReturnValue(child)
  const adapter = new ClaudeAdapter()
  const handle = await adapter.spawn(spec)
  const listed = adapter.commands(handle)
  expect(mock.spawn).toHaveBeenCalledTimes(1)
  const request = JSON.parse(written(child)!)
  child.stdout.write(
    JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: request.request_id,
        response: {
          commands: [
            { name: 'review', description: 'Review a PR', argumentHint: '' },
            { name: 'resume', description: 'the CLI one' },
            {
              name: 'mcp',
              description: 'Manage MCP servers',
              argumentHint: '[reconnect|enable|disable]'
            }
          ]
        }
      }
    }) + '\n'
  )
  // The host's panels come first and the CLI's own /mcp, which headless
  // Claude answers with a line of text, is not offered beside it.
  expect(await listed).toEqual([
    ...HOST_COMMANDS,
    { name: 'review', description: 'Review a PR', insert: '/review ' }
  ])
  expect(HOST_COMMANDS.map((c) => c.name)).toEqual(['resume', 'mcp', 'plugin'])
  child.emit('close', 0)
  await adapter.kill(handle)
})

it('sends attached images as content blocks and streams the message without them', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  })
  mock.spawn.mockReturnValue(child)
  const adapter = new ClaudeAdapter()
  expect(adapter.images).toBe(true)
  const handle = await adapter.spawn(spec)
  const streamed: SessionEvent[] = []
  adapter.on(handle, 'stream', (s) => {
    if (s.kind === 'event') streamed.push(s.event)
  })
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
    text: 'What is this?',
    attachments: [shot],
    prepared: {
      text: 'What is this?',
      images: [{ name: 'shot.png', mimeType: 'image/png', data: 'AQID' }]
    }
  })
  const input = JSON.parse(written(child)!.trim())
  expect(input).toEqual({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } }
      ]
    }
  })
  expect(streamed.find((e) => e.type === 'user_message')).toEqual({
    type: 'user_message',
    text: 'What is this?',
    attachments: [shot]
  })
  expect(JSON.stringify(streamed)).not.toContain('AQID')
  // References travel inside the prepared text, as a plain string prompt.
  adapter.write(handle, {
    type: 'user_message',
    text: 'read it',
    attachments: [{ ...shot, delivery: 'reference' }],
    prepared: {
      text: 'read it\n\nAttached local files:\n{"path":"/pictures/shot.png"}',
      images: []
    }
  })
  expect(JSON.parse(written(child)!.trim()).message.content).toBe(
    'read it\n\nAttached local files:\n{"path":"/pictures/shot.png"}'
  )
  child.emit('close', 0)
  await adapter.kill(handle)
})

// Frame shapes as the installed CLI wrote them for `Bash` with
// `run_in_background: true` (captured 2026-09-24): the list, the task's start,
// the call's result naming the output file, then completion after the turn.
const bgResult = (id: string): unknown => ({
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: id,
        content: `Command running in background with ID: b1. Output is being written to: /tmp/tasks/b1.output. You will be notified when it completes`
      }
    ]
  }
})
const lastBackground = ():
  | Extract<SessionEvent, { type: 'background_tasks' }>['tasks']
  | undefined =>
  (
    events.filter((e) => e.type === 'background_tasks').at(-1) as
      | Extract<SessionEvent, { type: 'background_tasks' }>
      | undefined
  )?.tasks
it('names a background shell by the title its Bash call gave, keeping the command beside it', () => {
  const command = 'cd /repo/clave-app && exec npm run dev > dev.log 2>&1'
  feed({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'toolu_t',
          name: 'Bash',
          input: { command, description: 'Start the dev app', run_in_background: true }
        }
      ]
    }
  })
  // The CLI lists it by the command, before naming its call.
  feed({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'bt', task_type: 'local_bash', description: command }]
  })
  feed({
    type: 'system',
    subtype: 'task_started',
    task_id: 'bt',
    tool_use_id: 'toolu_t',
    description: command,
    is_backgrounded: true,
    task_type: 'local_bash'
  })
  expect(lastBackground()).toEqual([
    expect.objectContaining({ id: 'bt', description: 'Start the dev app', command })
  ])
})
it('names a background shell with no titled call by its command, shortened', async () => {
  const command = 'cd /repo/clave-app && exec npm run dev > dev.log 2>&1'
  feed({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'bu', task_type: 'local_bash', description: command }]
  })
  // Unlinked to a call, the list waits for the end of the read.
  await Promise.resolve()
  expect(lastBackground()).toEqual([
    expect.objectContaining({ id: 'bu', description: 'npm run dev in clave-app', command })
  ])
})
it('publishes a background shell, with its call and output file, until the CLI retires it', () => {
  feed({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'Watch the build' }]
  })
  feed({
    type: 'system',
    subtype: 'task_started',
    task_id: 'b1',
    tool_use_id: 'toolu_1',
    description: 'Watch the build',
    is_backgrounded: true,
    task_type: 'local_bash'
  })
  feed(bgResult('toolu_1'))
  expect(lastBackground()).toEqual([
    expect.objectContaining({
      id: 'b1',
      kind: 'shell',
      description: 'Watch the build',
      toolUseId: 'toolu_1',
      outputFile: '/tmp/tasks/b1.output'
    })
  ])
  // The turn ending says nothing about the background.
  feed({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })
  expect(lastBackground()).toHaveLength(1)
  feed({ type: 'system', subtype: 'task_updated', task_id: 'b1', patch: { status: 'completed' } })
  expect(lastBackground()).toEqual([])
  // Every frame stays on the stream for a view that reads it raw.
  expect(
    events.filter(
      (e) =>
        e.type === 'provider_event' &&
        (e.payload as { subtype?: string }).subtype === 'task_updated'
    )
  ).toHaveLength(1)
})
it('drops a task the authoritative list no longer names, so nothing stays running forever', () => {
  feed({
    type: 'system',
    subtype: 'task_started',
    task_id: 'a1',
    description: 'Review the diff',
    is_backgrounded: true,
    task_type: 'local_agent'
  })
  expect(lastBackground()).toEqual([expect.objectContaining({ id: 'a1', kind: 'agent' })])
  feed({ type: 'system', subtype: 'background_tasks_changed', tasks: [] })
  expect(lastBackground()).toEqual([])
})
it('ignores a foreground task and retires one on its notification', () => {
  feed({ type: 'system', subtype: 'task_started', task_id: 'f1', is_backgrounded: false })
  expect(lastBackground()).toBeUndefined()
  feed({ type: 'system', subtype: 'task_started', task_id: 'b2', is_backgrounded: true })
  feed({ type: 'system', subtype: 'task_notification', task_id: 'b2', status: 'completed' })
  expect(lastBackground()).toEqual([])
})
it('empties the list when the CLI exits', () => {
  feed({ type: 'system', subtype: 'task_started', task_id: 'b3', is_backgrounded: true })
  translator.clearBackground()
  expect(lastBackground()).toEqual([])
})
it('reports the context from the main thread and names the parent of a subagent call', () => {
  const usage = { input_tokens: 2, cache_read_input_tokens: 10_000, output_tokens: 8 }
  const main = (content: unknown[]): unknown => ({
    type: 'assistant',
    parent_tool_use_id: null,
    message: { content, usage }
  })
  feed(main([{ type: 'text', text: 'Looking.' }]))
  // Every block of one message repeats its usage: one announcement, not two.
  feed(main([{ type: 'tool_use', id: 'agent-1', name: 'Agent', input: { description: 'x' } }]))
  feed({
    type: 'assistant',
    parent_tool_use_id: 'agent-1',
    message: {
      content: [{ type: 'tool_use', id: 'sub-1', name: 'Grep', input: { pattern: 'y' } }],
      usage: { input_tokens: 90_000 }
    }
  })
  feed({
    type: 'result',
    subtype: 'success',
    is_error: false,
    modelUsage: {
      'claude-opus-5[1m]': { contextWindow: 1_000_000 },
      'claude-haiku-4-5': { contextWindow: 200_000 }
    }
  })
  expect(events.filter((e) => e.type === 'context_usage')).toEqual([
    { type: 'context_usage', used: 10_010, window: null },
    // The subagent's own context, never the conversation's.
    { type: 'context_usage', used: 90_000, window: null, parent: 'agent-1' },
    { type: 'context_usage', used: 10_010, window: 1_000_000 }
  ])
  const calls = events.filter((e) => e.type === 'tool_call')
  expect(calls.map((e) => (e.type === 'tool_call' ? [e.id, e.parent] : null))).toEqual([
    ['agent-1', undefined],
    ['sub-1', 'agent-1']
  ])
})
it("carries a subagent's brief, words and results under its call, whole and never streamed", () => {
  // The frames as the installed CLI sends them for one subagent
  // (`claude -p --include-partial-messages`, 2026-11-06): the parent's
  // Agent call, then the subagent's user text (its brief), its tool_use,
  // its tool_result and its text, each with parent_tool_use_id; nothing of
  // the subagent comes as a stream_event.
  feed({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      content: [
        { type: 'tool_use', id: 'agent-1', name: 'Agent', input: { prompt: 'List the probe' } }
      ]
    }
  })
  feed({
    type: 'user',
    parent_tool_use_id: 'agent-1',
    message: { role: 'user', content: [{ type: 'text', text: 'List the probe' }] }
  })
  feed({
    type: 'assistant',
    parent_tool_use_id: 'agent-1',
    message: {
      content: [{ type: 'tool_use', id: 'sub-1', name: 'Bash', input: { command: 'ls' } }]
    }
  })
  feed({
    type: 'user',
    parent_tool_use_id: 'agent-1',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'sub-1', content: 'err.txt', is_error: false }]
    }
  })
  feed({
    type: 'assistant',
    parent_tool_use_id: 'agent-1',
    message: { content: [{ type: 'text', text: 'DONE' }] }
  })
  // The conversation's own text, streamed, goes on untouched by the above.
  feed({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'FIN' } }
  })
  const own = events.filter(
    (e) =>
      !('parent' in e && e.parent) && e.type !== 'provider_event' && e.type !== 'background_tasks'
  )
  expect(own).toEqual([
    { type: 'tool_call', id: 'agent-1', name: 'Agent', input: { prompt: 'List the probe' } },
    { type: 'assistant_text', delta: 'FIN', final: false }
  ])
  const theirs = events.filter((e) => 'parent' in e && e.parent)
  expect(theirs).toEqual([
    { type: 'user_message', text: 'List the probe', parent: 'agent-1' },
    { type: 'tool_call', id: 'sub-1', name: 'Bash', input: { command: 'ls' }, parent: 'agent-1' },
    { type: 'tool_result', id: 'sub-1', output: 'err.txt', error: false, parent: 'agent-1' },
    { type: 'assistant_text', delta: 'DONE', final: true, parent: 'agent-1' }
  ])
})
it('replays the context a resumed conversation stood at', () => {
  const line = (usage: object): string =>
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'ok' }], usage }
    })
  const items = translator.replay([
    line({ input_tokens: 5, cache_read_input_tokens: 1_000 }),
    line({ input_tokens: 5, cache_read_input_tokens: 1_000 }),
    line({ input_tokens: 5, cache_read_input_tokens: 4_000 })
  ])
  expect(items.map((i) => i.event).filter((e) => e.type === 'context_usage')).toEqual([
    { type: 'context_usage', used: 1_005, window: null },
    { type: 'context_usage', used: 4_005, window: null }
  ])
})

describe('a Claude chat on a profile that sets its own permissions', () => {
  const launch = async (profileArgs: string[]): Promise<SessionEvent[]> => {
    mock.profileArgs = profileArgs
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough()
    })
    mock.spawn.mockReturnValue(child)
    const adapter = new ClaudeAdapter()
    const handle = await adapter.spawn(spec)
    const seen: SessionEvent[] = []
    adapter.on(handle, 'stream', (s) => {
      if (s.kind === 'event') seen.push(s.event)
    })
    adapter.ready(handle)
    child.emit('close', 0)
    await adapter.kill(handle)
    mock.profileArgs = ['--debug']
    return seen
  }
  const offered = (events: SessionEvent[]): Extract<SessionEvent, { type: 'permission_mode' }> => {
    const event = events.find((e) => e.type === 'permission_mode')
    if (event?.type !== 'permission_mode') throw new Error('no permission_mode offered')
    return event
  }
  it("shows the profile's mode from the start and offers bypass when it launches on it", async () => {
    const event = offered(await launch(['--permission-mode', 'bypassPermissions']))
    expect(event.mode).toBe('bypassPermissions')
    expect(event.modes.map((m) => m.id)).toContain('bypassPermissions')
  })
  it('offers bypass to a profile that allows it without starting on it', async () => {
    const event = offered(await launch(['--allow-dangerously-skip-permissions']))
    expect(event.mode).toBe('default')
    expect(event.modes.map((m) => m.id)).toContain('bypassPermissions')
  })
  it('reads the manual spelling as the running default', async () => {
    expect(offered(await launch(['--permission-mode=manual'])).mode).toBe('default')
    expect(offered(await launch(['--permission-mode=plan'])).mode).toBe('plan')
  })
})

it('names the window from the answering model until a result does, and a subagent its model once', () => {
  feed({
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text: 'Looking.' }],
      usage: { input_tokens: 12_000 }
    }
  })
  const sub = (id: string): unknown => ({
    type: 'assistant',
    parent_tool_use_id: 'agent-1',
    message: {
      model: 'claude-sonnet-5-5',
      content: [{ type: 'tool_use', id, name: 'Grep', input: { pattern: 'y' } }],
      usage: { input_tokens: 1_000 }
    }
  })
  feed(sub('sub-1'))
  feed(sub('sub-2'))
  expect(events.filter((e) => e.type === 'context_usage')[0]).toEqual({
    type: 'context_usage',
    used: 12_000,
    window: 200_000
  })
  // Every frame of the agent names its model: announced once.
  expect(events.filter((e) => e.type === 'subagent_model')).toEqual([
    { type: 'subagent_model', parent: 'agent-1', model: 'claude-sonnet-5-5' }
  ])
})
it('replays a resumed conversation with the window its model names', () => {
  const items = translator.replay([
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 5, cache_read_input_tokens: 40_000 }
      }
    })
  ])
  expect(items.map((i) => i.event).filter((e) => e.type === 'context_usage')).toEqual([
    { type: 'context_usage', used: 40_005, window: 1_000_000 }
  ])
})
it('stops one background task by its id, and says why when the CLI refuses', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough()
  })
  mock.spawn.mockReturnValue(child)
  const adapter = new ClaudeAdapter()
  const handle = await adapter.spawn(spec)
  adapter.on(handle, 'stream', (s) => {
    if (s.kind === 'event') events.push(s.event)
  })
  adapter.ready(handle)
  expect(JSON.parse(written(child)!)).toMatchObject({ request: { subtype: 'initialize' } })
  adapter.write(handle, { type: 'stop_task', taskId: 'task-7' })
  const request = JSON.parse(written(child)!)
  expect(request).toMatchObject({
    type: 'control_request',
    request: { subtype: 'stop_task', task_id: 'task-7' }
  })
  // Never taken for an interrupt, which would stop the whole turn.
  expect(request.request.subtype).not.toBe('interrupt')
  child.stdout.write(
    JSON.stringify({
      type: 'control_response',
      response: { subtype: 'error', request_id: request.request_id, error: 'no such task' }
    }) + '\n'
  )
  expect(events.at(-1)).toEqual({ type: 'error', message: 'no such task', fatal: false })
})

describe('the default resolved at ready (PRDCT-4256)', () => {
  type Child = EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough }
  const fakeChild = (): Child =>
    Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough()
    })
  /** Every control request the adapter wrote since the last read, get_settings aside. */
  const requests = (child: Child): { request_id: string; request: Record<string, unknown> }[] =>
    (written(child) ?? '')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((frame) => frame.type === 'control_request')
  const answer = (child: Child, requestId: string, models: unknown[]): void => {
    child.stdout.write(
      JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response: { models } }
      }) + '\n'
    )
  }
  const metas = (): (string | null)[] =>
    events.flatMap((e) => (e.type === 'session_meta' ? [e.model] : []))
  const DEFAULT_LIST = [
    {
      value: 'default',
      displayName: 'Default (recommended)',
      description: 'Opus 5.5 · Best for everyday, complex tasks',
      resolvedModel: 'claude-opus-5-5'
    },
    { value: 'fable', displayName: 'Fable', resolvedModel: 'claude-fable-5-1' }
  ]
  async function readied(
    options?: Record<string, unknown>
  ): Promise<{ adapter: ClaudeAdapter; handle: { id: string }; child: Child }> {
    const child = fakeChild()
    mock.spawn.mockReturnValue(child)
    const adapter = new ClaudeAdapter()
    const handle = await adapter.spawn({ ...spec, ...(options ? { options } : {}) })
    adapter.on(handle, 'stream', (s) => {
      if (s.kind === 'event') events.push(s.event)
    })
    adapter.ready(handle)
    return { adapter, handle, child }
  }

  it('names the model the default resolves to before any message, off the CLI’s own list', async () => {
    const { adapter, handle, child } = await readied()
    const [ask, ...rest] = requests(child)
    expect(rest).toEqual([])
    expect(ask.request).toEqual({ subtype: 'initialize' })
    expect(metas()).toEqual([null])
    answer(child, ask.request_id, DEFAULT_LIST)
    await new Promise((resolve) => setImmediate(resolve))
    expect(metas()).toEqual([null, 'claude-opus-5-5'])
    expect(events.at(-1)).toEqual({
      type: 'session_meta',
      model: 'claude-opus-5-5',
      providerSessionId: null
    })
    // No turn was sent, no state moved: the ask is free.
    expect(events.some((e) => e.type === 'state_change')).toBe(false)
    child.emit('close', 0)
    await adapter.kill(handle)
  })

  it('a chat launched on the `default` alias announces no model until the CLI says which, and never the word', async () => {
    const { adapter, handle, child } = await readied({ model: 'default' })
    expect(metas()).toEqual([null])
    const [ask] = requests(child)
    answer(child, ask.request_id, DEFAULT_LIST)
    await new Promise((resolve) => setImmediate(resolve))
    expect(metas()).toEqual([null, 'claude-opus-5-5'])
    child.emit('close', 0)
    await adapter.kill(handle)
  })

  it('asks nothing for a chat launched on a named model', async () => {
    const { adapter, handle, child } = await readied({ model: 'claude-sonnet-5-5' })
    expect(metas()).toEqual(['claude-sonnet-5-5'])
    expect(requests(child)).toEqual([])
    child.emit('close', 0)
    await adapter.kill(handle)
  })

  it('the CLI’s own word first wins: an init frame or a switch taken before the answer silences it', async () => {
    const initFirst = await readied()
    const [ask] = requests(initFirst.child)
    initFirst.child.stdout.write(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: spec.id,
        model: 'claude-fable-5-1[1m]'
      }) + '\n'
    )
    answer(initFirst.child, ask.request_id, DEFAULT_LIST)
    await new Promise((resolve) => setImmediate(resolve))
    expect(metas()).toEqual([null, 'claude-fable-5-1[1m]'])
    initFirst.child.emit('close', 0)
    await initFirst.adapter.kill(initFirst.handle)
    events.length = 0
    vi.clearAllMocks()

    const switched = await readied()
    const [resolution] = requests(switched.child)
    switched.adapter.write(switched.handle, {
      type: 'set_model',
      model: 'claude-haiku-4-5-20251001'
    })
    const [set] = requests(switched.child)
    switched.child.stdout.write(
      JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: set.request_id }
      }) + '\n'
    )
    expect(metas()).toEqual([null, 'claude-haiku-4-5-20251001'])
    answer(switched.child, resolution.request_id, DEFAULT_LIST)
    await new Promise((resolve) => setImmediate(resolve))
    expect(metas()).toEqual([null, 'claude-haiku-4-5-20251001'])
    switched.child.emit('close', 0)
    await switched.adapter.kill(switched.handle)
  })

  it('a list without a default takes the first model’s resolution, and one that resolves nothing says nothing', async () => {
    const first = await readied()
    answer(first.child, requests(first.child)[0].request_id, [
      { value: 'fable', displayName: 'Fable', resolvedModel: 'claude-fable-5-1[1m]' },
      { value: 'haiku', displayName: 'Haiku' }
    ])
    await new Promise((resolve) => setImmediate(resolve))
    expect(metas()).toEqual([null, 'claude-fable-5-1[1m]'])
    first.child.emit('close', 0)
    await first.adapter.kill(first.handle)
    events.length = 0
    vi.clearAllMocks()

    const none = await readied()
    answer(none.child, requests(none.child)[0].request_id, [
      { value: 'default', displayName: 'Default' },
      { value: 'haiku', displayName: 'Haiku' }
    ])
    await new Promise((resolve) => setImmediate(resolve))
    expect(metas()).toEqual([null])
    none.child.emit('close', 0)
    await none.adapter.kill(none.handle)
    events.length = 0
    vi.clearAllMocks()

    // A refusal is nothing to show: the init frame will say.
    const refused = await readied()
    const [ask] = requests(refused.child)
    refused.child.stdout.write(
      JSON.stringify({
        type: 'control_response',
        response: { subtype: 'error', request_id: ask.request_id, error: 'no' }
      }) + '\n'
    )
    await new Promise((resolve) => setImmediate(resolve))
    expect(metas()).toEqual([null])
    expect(events.some((e) => e.type === 'error')).toBe(false)
    refused.child.emit('close', 0)
    await refused.adapter.kill(refused.handle)
  })

  it('refuses to put the `default` alias on the wire as a switch', async () => {
    const { adapter, handle, child } = await readied()
    requests(child)
    expect(() => adapter.write(handle, { type: 'set_model', model: 'default' })).toThrow(
      /default alias/
    )
    expect(() => adapter.write(handle, { type: 'set_model', model: 'default[1m]' })).toThrow(
      /default alias/
    )
    expect(requests(child)).toEqual([])
    child.emit('close', 0)
    await adapter.kill(handle)
  })

  it('the settings answer at ready names the model the session runs on, and the account default then says nothing (round 1, Major 1)', async () => {
    // A user whose settings say `sonnet`: the CLI's `default` row still
    // resolves to Opus 5.5 (the account's default), while get_settings
    // applies the setting. The settings answer is the CLI's own word.
    const { adapter, handle, child } = await readied()
    const raw = (child.stdin.read() as Buffer)
      .toString()
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    const settings = raw.find((f) => f.request?.subtype === 'get_settings')
    const resolution = raw.find((f) => f.request?.subtype === 'initialize')
    expect(settings).toBeTruthy()
    expect(resolution).toBeTruthy()
    child.stdout.write(
      JSON.stringify({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: settings.request_id,
          response: { applied: { model: 'claude-sonnet-5-5', effort: 'medium' } }
        }
      }) + '\n'
    )
    expect(metas()).toEqual([null, 'claude-sonnet-5-5'])
    expect(events.at(-1)).toEqual({ type: 'effort', effort: 'medium' })
    answer(child, resolution.request_id, DEFAULT_LIST)
    await new Promise((resolve) => setImmediate(resolve))
    expect(metas()).toEqual([null, 'claude-sonnet-5-5'])
    child.emit('close', 0)
    await adapter.kill(handle)
  })

  it('a settings answer naming no model, the alias, or a name no launch takes announces nothing', async () => {
    for (const applied of [{ effort: 'high' }, { model: 'default' }, { model: 'x; rm -rf' }, {}]) {
      events.length = 0
      vi.clearAllMocks()
      const { adapter, handle, child } = await readied()
      const raw = (child.stdin.read() as Buffer)
        .toString()
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
      const settings = raw.find((f) => f.request?.subtype === 'get_settings')
      child.stdout.write(
        JSON.stringify({
          type: 'control_response',
          response: { subtype: 'success', request_id: settings.request_id, response: { applied } }
        }) + '\n'
      )
      expect(metas()).toEqual([null])
      child.emit('close', 0)
      await adapter.kill(handle)
    }
  })

  it('the real CLI list (2.1.319) makes a menu of the newest of each family, the elders folded, the default glossed on its row (round 1, Major 2)', () => {
    const real = JSON.parse(
      readFileSync(
        new URL('../fixtures/claude-stream/initialize-models-2.1.319.json', import.meta.url),
        'utf8'
      )
    )
    const options = claudeModelOptions(real)
    expect(options.find((o) => o.id === 'default')).toBeUndefined()
    const { current, earlier } = foldModelOptions(options)
    expect(current.map((o) => o.label)).toEqual([
      'Opus 5.5',
      'Fable 5.1',
      'Sonnet 5.5',
      'Haiku 5.5'
    ])
    expect(earlier.map((o) => o.label)).toEqual([
      'Fable 5',
      'Haiku 4.5',
      'Sonnet 5',
      'Opus 5',
      'Opus 4.8',
      'Opus 4.7',
      'Opus 4.6',
      'Sonnet 4.6'
    ])
    expect(current.map((o) => o.hint)).toEqual([
      'Default · Best for everyday, complex tasks',
      'For your toughest challenges',
      'Most efficient for simpler tasks',
      'Fastest for quick answers'
    ])
    for (const option of earlier) expect(option.hint).toBe('Earlier version')
    // Haiku 4.5 is listed with no levels and takes none (the CLI applies no
    // effort to it): the effort chip must not offer its family's five (round 2).
    expect(earlier.find((o) => o.label === 'Haiku 4.5')).not.toHaveProperty('efforts')
    expect(current.find((o) => o.label === 'Haiku 5.5')?.efforts?.map((e) => e.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
    // Every listed id is still a row somewhere, so a .clave or a routine
    // naming claude-opus-4-6 launches it and finds it selected.
    expect(options.map((o) => o.id)).toContain('claude-opus-4-6')
    expect(options.map((o) => o.id)).toContain('claude-fable-5[1m]')
  })

  it('glosses the default on a row the table does not know, and reads the default entry wherever the CLI lists it (round 1 gaps)', () => {
    // The CLI's default moved to a model shipped after the table was edited.
    const moved = claudeModelOptions([
      { value: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-5-5' },
      {
        value: 'default',
        displayName: 'Default',
        description: 'Opus 6 · Newest',
        resolvedModel: 'claude-opus-6',
        supportedEffortLevels: ['low', 'high']
      },
      { value: 'claude-opus-6', displayName: 'Opus 6', resolvedModel: 'claude-opus-6' }
    ])
    const opus6 = moved.find((o) => o.id === 'claude-opus-6')
    expect(opus6?.hint).toBe('Default · Newest')
    expect(moved.find((o) => o.id === 'claude-opus-5-5')?.hint).toBe('Earlier version')
    // The default's row takes the default entry's levels when the CLI lists
    // the model under no version and no alias of its own.
    const levels = claudeModelOptions([
      {
        value: 'default',
        displayName: 'Default',
        resolvedModel: 'claude-opus-5-5',
        supportedEffortLevels: ['low', 'high']
      },
      { value: 'fable', displayName: 'Fable', resolvedModel: 'claude-fable-5-1' }
    ])
    expect(levels.find((o) => o.id === 'claude-opus-5-5')?.efforts?.map((e) => e.id)).toEqual([
      'low',
      'high'
    ])
    // A listed version is the word on itself, levels or none: an alias row
    // never speaks for a version the CLI lists apart (round 2, Haiku 4.5).
    const listed = claudeModelOptions([
      {
        value: 'default',
        displayName: 'Default',
        resolvedModel: 'claude-opus-5-5',
        supportedEffortLevels: ['low', 'high']
      },
      { value: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-5-5' }
    ])
    expect(listed.find((o) => o.id === 'claude-opus-5-5')).not.toHaveProperty('efforts')
    // The default entry is read wherever it sits, never the first row by position.
    expect(
      resolvedDefaultModel([
        { value: 'fable', displayName: 'Fable', resolvedModel: 'claude-fable-5-1' },
        { value: 'default', displayName: 'Default', resolvedModel: 'claude-opus-5-5' }
      ])
    ).toBe('claude-opus-5-5')
  })

  it('writes a switch before the message that follows it, in stdin order (PRDCT-4273)', async () => {
    // Probed on the real CLI 2.1.319 on 9 November 2026: a `set_model`
    // control request written right before a `user` message is answered
    // first, and the message's init frame and answer carry the new model
    // (launched on sonnet, switched to haiku: init `claude-haiku-5-5`,
    // assistant `claude-haiku-5-5`). The adapter's part of that is the
    // order of its writes, pinned here: nothing of the composer needs
    // disabling while a switch is in flight.
    const { adapter, handle, child } = await readied()
    requests(child)
    adapter.write(handle, { type: 'set_model', model: 'claude-haiku-5-5' })
    adapter.write(handle, { type: 'user_message', text: 'Reply with OK.' })
    const frames = (written(child) ?? '')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(frames.map((f) => f.type)).toEqual(['control_request', 'user'])
    expect(frames[0].request).toEqual({ subtype: 'set_model', model: 'claude-haiku-5-5' })
    expect(frames[1].message.content).toBe('Reply with OK.')
    // The chip's word comes with the CLI's answer, after the message went out.
    expect(metas()).toEqual([null])
    child.stdout.write(
      JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: frames[0].request_id }
      }) + '\n'
    )
    expect(metas()).toEqual([null, 'claude-haiku-5-5'])
    child.emit('close', 0)
    await adapter.kill(handle)
  })

  it('reads which model a list makes the default', () => {
    expect(resolvedDefaultModel(DEFAULT_LIST)).toBe('claude-opus-5-5')
    expect(resolvedDefaultModel([{ value: 'default', displayName: 'Default' }])).toBeNull()
    expect(resolvedDefaultModel([])).toBeNull()
    // A default that resolves to itself, or to a name no launch would take, is no answer.
    expect(
      resolvedDefaultModel([{ value: 'default', displayName: 'D', resolvedModel: 'default' }])
    ).toBeNull()
    expect(
      resolvedDefaultModel([{ value: 'default', displayName: 'D', resolvedModel: 'x; rm -rf' }])
    ).toBeNull()
  })
})

describe('the reasoning effort of a Claude chat', () => {
  const FIVE = ['low', 'medium', 'high', 'xhigh', 'max']
  const fakeChild = (): EventEmitter & {
    stdin: PassThrough
    stdout: PassThrough
    stderr: PassThrough
  } =>
    Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough()
    })
  /** Every line written to the CLI since the last read, get_settings included. */
  const sent = (child: {
    stdin: PassThrough
  }): { type: string; request_id: string; request: Record<string, unknown> }[] => {
    const raw = child.stdin.read() as Buffer | null
    return raw
      ? raw
          .toString()
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : []
  }
  const answer = (child: { stdout: PassThrough }, response: Record<string, unknown>): void => {
    child.stdout.write(JSON.stringify({ type: 'control_response', response }) + '\n')
  }
  async function started(
    id: string,
    options?: Record<string, unknown>
  ): Promise<{
    adapter: ClaudeAdapter
    handle: Awaited<ReturnType<ClaudeAdapter['spawn']>>
    child: ReturnType<typeof fakeChild>
  }> {
    const child = fakeChild()
    mock.spawn.mockReturnValue(child)
    const adapter = new ClaudeAdapter()
    const handle = await adapter.spawn({ ...spec, id, ...(options ? { options } : {}) })
    adapter.on(handle, 'stream', (s) => {
      if (s.kind === 'event') events.push(s.event)
    })
    return { adapter, handle, child }
  }
  const effortOf = (option: { efforts?: { id: string }[] } | undefined): string[] | undefined =>
    option?.efforts?.map((e) => e.id)

  it("lists a version's own levels when the CLI lists it, else its family's, and none for a model without", () => {
    const options = claudeModelOptions([
      {
        value: 'default',
        resolvedModel: 'claude-opus-5-5',
        displayName: 'Default',
        supportsEffort: true,
        supportedEffortLevels: FIVE
      },
      {
        value: 'opus',
        resolvedModel: 'claude-opus-5-5',
        displayName: 'Opus',
        supportedEffortLevels: FIVE
      },
      // The family alias names the newest Fable, with five levels…
      {
        value: 'fable',
        resolvedModel: 'claude-fable-5-1',
        displayName: 'Fable',
        supportedEffortLevels: FIVE
      },
      // …and the earlier version has a row of its own, with four.
      {
        value: 'claude-fable-5[1m]',
        resolvedModel: 'claude-fable-5',
        displayName: 'Fable 5',
        supportedEffortLevels: ['low', 'medium', 'high', 'max']
      },
      {
        value: 'sonnet',
        resolvedModel: 'claude-sonnet-5-5',
        displayName: 'Sonnet',
        supportsEffort: false,
        supportedEffortLevels: FIVE
      },
      { value: 'haiku', displayName: 'Haiku' },
      {
        value: 'claude-opus-6',
        resolvedModel: 'claude-opus-6',
        displayName: 'Opus 6',
        supportedEffortLevels: ['low', 'high;rm', '--x', 'high']
      }
    ])
    const byId = (id: string): (typeof options)[number] | undefined =>
      options.find((option) => option.id === id)
    // The CLI's default has no row of its own: its gloss and its levels sit on
    // the row of the model it resolves to (PRDCT-4257).
    expect(byId('default')).toBeUndefined()
    expect(byId('claude-opus-5-5')?.hint).toBe('Default')
    expect(byId('claude-opus-5-5')?.efforts).toEqual([
      { id: 'low', label: 'Low' },
      { id: 'medium', label: 'Medium' },
      { id: 'high', label: 'High' },
      { id: 'xhigh', label: 'Extra high' },
      { id: 'max', label: 'Max' }
    ])
    expect(effortOf(byId('claude-fable-5-1[1m]'))).toEqual(FIVE)
    expect(effortOf(byId('claude-fable-5[1m]'))).toEqual(['low', 'medium', 'high', 'max'])
    // supportsEffort false wins over any list; a model without levels has no key.
    expect(byId('claude-sonnet-5-5')).not.toHaveProperty('efforts')
    expect(byId('claude-haiku-4-5-20251001')).not.toHaveProperty('efforts')
    // A level that could not reach a command line is never offered.
    expect(effortOf(byId('claude-opus-6'))).toEqual(['low', 'high'])
    // Without a row of its own, an earlier version takes its family's levels.
    const family = claudeModelOptions([
      {
        value: 'fable',
        resolvedModel: 'claude-fable-5-1',
        displayName: 'Fable',
        supportedEffortLevels: FIVE
      }
    ])
    expect(effortOf(family.find((option) => option.id === 'claude-fable-5[1m]'))).toEqual(FIVE)
    expect(family.find((option) => option.id === 'claude-opus-5-5')).not.toHaveProperty('efforts')
  })

  it('switches the effort before any message, then reads back what the CLI applied', async () => {
    const { adapter, handle, child } = await started('effort-switch')
    expect(mock.spawn).not.toHaveBeenCalled()
    adapter.write(handle, { type: 'set_effort', effort: 'high' })
    expect(mock.spawn).toHaveBeenCalledTimes(1)
    const [apply, ...rest] = sent(child)
    expect(rest).toEqual([])
    expect(apply).toMatchObject({
      type: 'control_request',
      request: { subtype: 'apply_flag_settings', settings: { effortLevel: 'high' } }
    })
    expect(events.some((e) => e.type === 'effort')).toBe(false)
    // The acknowledgement says nothing of the level: the settings are asked for.
    answer(child, { subtype: 'success', request_id: apply.request_id })
    const [settings, ...more] = sent(child)
    expect(more).toEqual([])
    expect(settings).toMatchObject({
      type: 'control_request',
      request: { subtype: 'get_settings' }
    })
    expect(settings.request_id).not.toBe(apply.request_id)
    expect(events.some((e) => e.type === 'effort')).toBe(false)
    answer(child, {
      subtype: 'success',
      request_id: settings.request_id,
      response: { applied: { effort: 'high' } }
    })
    expect(events.at(-1)).toEqual({ type: 'effort', effort: 'high' })
    // A refusal is the CLI's own words, never fatal, and reads nothing back.
    adapter.write(handle, { type: 'set_effort', effort: 'max' })
    const [refused] = sent(child)
    answer(child, { subtype: 'error', request_id: refused.request_id, error: 'max needs Opus' })
    expect(events.at(-1)).toEqual({ type: 'error', message: 'max needs Opus', fatal: false })
    expect(sent(child)).toEqual([])
    adapter.write(handle, { type: 'set_effort', effort: 'xhigh' })
    const [silent] = sent(child)
    answer(child, { subtype: 'error', request_id: silent.request_id })
    expect(events.at(-1)).toEqual({
      type: 'error',
      message: 'Claude refused the Extra high effort',
      fatal: false
    })
    child.emit('close', 0)
    await adapter.kill(handle)
  })

  it.each(['high;rm', '--x', 'High', ''])(
    'refuses the level %j before anything starts',
    async (effort) => {
      const { adapter, handle } = await started(`effort-invalid-${effort}`)
      expect(() => adapter.write(handle, { type: 'set_effort', effort })).toThrow()
      expect(mock.spawn).not.toHaveBeenCalled()
      await adapter.kill(handle)
    }
  )

  it('asks for the settings at ready, and after a model switch only once the CLI took it', async () => {
    const { adapter, handle, child } = await started('effort-ready')
    adapter.ready(handle)
    const [first, resolution, ...rest] = sent(child)
    expect(rest).toEqual([])
    expect(first).toMatchObject({ type: 'control_request', request: { subtype: 'get_settings' } })
    expect(resolution).toMatchObject({ request: { subtype: 'initialize' } })
    // A CLI too old to say what it applied: nothing is shown, and nothing leaks.
    const before = events.length
    answer(child, { subtype: 'success', request_id: first.request_id, response: {} })
    expect(events.length).toBe(before)
    adapter.write(handle, { type: 'set_model', model: 'claude-haiku-4-5-20251001' })
    const switched = sent(child)
    expect(switched).toHaveLength(1)
    expect(switched[0]).toMatchObject({ request: { subtype: 'set_model' } })
    answer(child, { subtype: 'success', request_id: switched[0].request_id })
    const [after, ...none] = sent(child)
    expect(none).toEqual([])
    expect(after).toMatchObject({ request: { subtype: 'get_settings' } })
    // A model that takes no effort runs at none, and says so as null.
    answer(child, {
      subtype: 'success',
      request_id: after.request_id,
      response: { applied: { effort: null } }
    })
    expect(events.at(-1)).toEqual({ type: 'effort', effort: null })
    // A refused switch reads nothing back.
    adapter.write(handle, { type: 'set_model', model: 'opus' })
    const [refused] = sent(child)
    answer(child, { subtype: 'error', request_id: refused.request_id, error: 'no' })
    expect(sent(child)).toEqual([])
    child.emit('close', 0)
    await adapter.kill(handle)
  })

  it.each([['High;rm'], [3], [{ level: 'high' }]])(
    'shows nothing for an applied effort %j that is not a level, and lets the request go',
    async (effort) => {
      const { adapter, handle, child } = await started(`effort-odd-${String(effort)}`)
      adapter.ready(handle)
      const [read] = sent(child)
      const before = events.length
      answer(child, {
        subtype: 'success',
        request_id: read.request_id,
        response: { applied: { effort } }
      })
      expect(events.slice(before).filter((e) => e.type === 'effort')).toEqual([])
      // Answered, so the id is released: the same answer again is not ours.
      answer(child, {
        subtype: 'success',
        request_id: read.request_id,
        response: { applied: { effort: 'low' } }
      })
      expect(events.slice(before).filter((e) => e.type === 'effort')).toEqual([])
      child.emit('close', 0)
      await adapter.kill(handle)
    }
  )

  it('points the CLI at the MCP config the port writes, and omits the flag when it writes none', async () => {
    mock.mcpConfig.write.mockReturnValue('/data/mcp/with-port.json')
    const withPort = await started('mcp-argv')
    withPort.adapter.write(withPort.handle, { type: 'user_message', text: 'Hello' })
    expect(mock.mcpConfig.write).toHaveBeenCalledExactlyOnceWith('mcp-argv')
    expect(mock.spawn.mock.calls[0][1][2]).toContain("'--mcp-config' '/data/mcp/with-port.json'")
    withPort.child.emit('close', 0)
    await withPort.adapter.kill(withPort.handle)
    expect(mock.mcpConfig.remove).toHaveBeenCalledWith('mcp-argv')
    mock.spawn.mockClear()
    mock.mcpConfig.write.mockReturnValue(null)
    const without = await started('mcp-argv-none')
    without.adapter.write(without.handle, { type: 'user_message', text: 'Hello' })
    expect(mock.spawn.mock.calls[0][1][2]).not.toContain('--mcp-config')
    without.child.emit('close', 0)
    await without.adapter.kill(without.handle)
  })

  it('launches on the effort last picked, and on none when there is none', async () => {
    const picked = await started('effort-argv', { effort: 'high' })
    picked.adapter.write(picked.handle, { type: 'user_message', text: 'Hello' })
    expect(mock.spawn.mock.calls[0][1][2]).toContain("'--effort' 'high'")
    picked.child.emit('close', 0)
    await picked.adapter.kill(picked.handle)
    mock.spawn.mockClear()
    const plain = await started('effort-argv-none')
    plain.adapter.write(plain.handle, { type: 'user_message', text: 'Hello' })
    expect(mock.spawn.mock.calls[0][1][2]).not.toContain('--effort')
    plain.child.emit('close', 0)
    await plain.adapter.kill(plain.handle)
    // One that could reach a command line is refused at spawn.
    const adapter = new ClaudeAdapter()
    await expect(
      adapter.spawn({ ...spec, id: 'effort-argv-bad', options: { effort: '--x' } })
    ).rejects.toThrow()
    await expect(
      adapter.spawn({ ...spec, id: 'effort-argv-bad-2', options: { effort: 'high;rm' } })
    ).rejects.toThrow()
  })
})
describe('a background list that names a task before its call', () => {
  const list = (...ids: string[]): unknown => ({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: ids.map((id) => ({ task_id: id, task_type: 'local_bash', description: 'sleep 10' }))
  })
  const started = (id: string, call: string): unknown => ({
    type: 'system',
    subtype: 'task_started',
    task_id: id,
    tool_use_id: call,
    description: 'sleep 10',
    is_backgrounded: true,
    task_type: 'local_bash'
  })
  const snapshots = (): { id: string; toolUseId?: string }[][] =>
    events.flatMap((e) => (e.type === 'background_tasks' ? [e.tasks] : []))

  it('publishes the task linked to its call when task_started follows in the same read, as the CLI sends it', () => {
    feed(list('t1'))
    feed(started('t1', 'toolu_1'))
    expect(snapshots()).toEqual([[expect.objectContaining({ id: 't1', toolUseId: 'toolu_1' })]])
  })

  it('keeps two same-named tasks apart by their own call ids', () => {
    feed(list('t1', 't2'))
    feed(started('t1', 'toolu_1'))
    feed(started('t2', 'toolu_2'))
    expect(snapshots().every((tasks) => tasks.every((t) => t.toolUseId))).toBe(true)
    expect(
      snapshots()
        .at(-1)
        ?.map((t) => `${t.id}:${t.toolUseId}`)
    ).toEqual(['t1:toolu_1', 't2:toolu_2'])
  })

  it('still publishes a task the CLI never links, at the end of the read', async () => {
    feed(list('t1'))
    expect(snapshots()).toEqual([])
    await Promise.resolve()
    expect(snapshots()).toEqual([[expect.objectContaining({ id: 't1' })]])
  })

  it('publishes the held list before any later event the view reads, so nothing changes order', () => {
    feed(list('t1'))
    feed({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })
    const order = events.filter((e) => e.type !== 'provider_event').map((e) => e.type)
    expect(order.indexOf('background_tasks')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('background_tasks')).toBeLessThan(order.indexOf('state_change'))
  })

  it('publishes an emptied list at once', () => {
    feed(started('t1', 'toolu_1'))
    feed(list())
    expect(snapshots().at(-1)).toEqual([])
  })
})
describe('a waited-on Bash task the CLI lists later', () => {
  const startedFg = (id: string, call: string): unknown => ({
    type: 'system',
    subtype: 'task_started',
    task_id: id,
    tool_use_id: call,
    description: 'Long sleep',
    is_backgrounded: false,
    task_type: 'local_bash'
  })
  const list = (...ids: string[]): unknown => ({
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: ids.map((id) => ({ task_id: id, task_type: 'local_bash', description: 'Long sleep' }))
  })
  const snapshots = (): { id: string; toolUseId?: string }[][] =>
    events.flatMap((e) => (e.type === 'background_tasks' ? [e.tasks] : []))

  it('lists it under the call its foreground start named, without listing that start', async () => {
    feed(startedFg('bfg1', 'toolu_fg'))
    expect(snapshots()).toEqual([])
    feed(list('bfg1'))
    await Promise.resolve()
    expect(snapshots()).toEqual([[expect.objectContaining({ id: 'bfg1', toolUseId: 'toolu_fg' })]])
    feed({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'bfg1',
      patch: { status: 'completed' }
    })
    expect(snapshots().at(-1)).toEqual([])
  })

  it('keeps two same-named waited-on tasks apart by their own calls', async () => {
    feed(startedFg('bfg1', 'toolu_a'))
    feed(startedFg('bfg2', 'toolu_b'))
    feed(list('bfg1', 'bfg2'))
    await Promise.resolve()
    expect(
      snapshots()
        .at(-1)
        ?.map((t) => `${t.id}:${t.toolUseId}`)
    ).toEqual(['bfg1:toolu_a', 'bfg2:toolu_b'])
  })

  it('forgets the link at the task end and at the turn end, so no later list reuses it', async () => {
    feed(startedFg('bfg1', 'toolu_a'))
    feed({ type: 'system', subtype: 'task_notification', task_id: 'bfg1', status: 'completed' })
    feed(startedFg('bfg2', 'toolu_b'))
    feed({ type: 'result', subtype: 'success', is_error: false, result: 'ok' })
    feed(list('bfg1', 'bfg2'))
    await Promise.resolve()
    expect(
      snapshots()
        .at(-1)
        ?.map((t) => t.toolUseId ?? '-')
    ).toEqual(['-', '-'])
  })
})

it('keeps bypass reachable to a chat resumed in another mode when its launch had it (PRDCT-4191, round 3 C5)', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  })
  mock.spawn.mockReturnValue(child)
  const adapter = new ClaudeAdapter()
  const events: SessionEvent[] = []
  const handle = await adapter.spawn({
    ...spec,
    options: { resume: 'resume-id', permissionMode: 'plan', allowDangerous: true }
  })
  adapter.on(handle, 'stream', (s) => {
    if (s.kind === 'event') events.push(s.event)
  })
  adapter.ready(handle)
  const command = mock.spawn.mock.calls[0][1][2]
  expect(command).toContain("'--permission-mode' 'plan'")
  expect(command).toContain("'--allow-dangerously-skip-permissions'")
  expect(command).not.toContain('--dangerously-skip-permissions ')
  const offered = events.find((e) => e.type === 'permission_mode')
  expect(offered?.type).toBe('permission_mode')
  if (offered?.type === 'permission_mode') {
    expect(offered.mode).toBe('plan')
    expect(offered.modes.map((m) => m.id)).toContain('bypassPermissions')
  }
  // Without the allowance, the flag is not passed and bypass is not offered.
  mock.spawn.mockClear()
  const plain = new ClaudeAdapter()
  const plainEvents: SessionEvent[] = []
  const plainHandle = await plain.spawn({
    ...spec,
    id: `${spec.id}-plain`,
    options: { permissionMode: 'plan' }
  })
  plain.on(plainHandle, 'stream', (s) => {
    if (s.kind === 'event') plainEvents.push(s.event)
  })
  plain.ready(plainHandle)
  expect(mock.spawn.mock.calls[0][1][2]).not.toContain('--allow-dangerously-skip-permissions')
  const plainOffer = plainEvents.find((e) => e.type === 'permission_mode')
  if (plainOffer?.type === 'permission_mode')
    expect(plainOffer.modes.map((m) => m.id)).not.toContain('bypassPermissions')
})
it('an identified Claude message is evidence only after stdin acknowledges it', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  })
  let acknowledge!: (error?: Error | null) => void
  vi.spyOn(child.stdin, 'write').mockImplementation(((_chunk: unknown, callback?: unknown) => {
    if (typeof callback === 'function') acknowledge = callback as typeof acknowledge
    return true
  }) as typeof child.stdin.write)
  mock.spawn.mockReturnValue(child)
  const adapter = new ClaudeAdapter()
  const handle = await adapter.spawn(spec)
  adapter.on(handle, 'stream', (stream) => {
    if (stream.kind === 'event') events.push(stream.event)
  })
  const accepted = adapter.write(handle, {
    type: 'user_message',
    text: 'hello',
    clientMessageId: 'phone-00000001'
  })
  expect(events.filter((e) => e.type === 'user_message')).toEqual([])
  expect(accepted).toBeInstanceOf(Promise)
  acknowledge()
  await accepted
  expect(events.filter((e) => e.type === 'user_message')).toEqual([
    { type: 'user_message', text: 'hello', clientMessageId: 'phone-00000001' }
  ])
  child.emit('exit', 0)
})
it('Claude negative stdin callback emits no evidence', async () => {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn()
  })
  let acknowledge!: (error?: Error | null) => void
  vi.spyOn(child.stdin, 'write').mockImplementation(((_chunk: unknown, callback?: unknown) => {
    if (typeof callback === 'function') acknowledge = callback as typeof acknowledge
    return true
  }) as typeof child.stdin.write)
  mock.spawn.mockReturnValue(child)
  const adapter = new ClaudeAdapter()
  const handle = await adapter.spawn(spec)
  adapter.on(handle, 'stream', (s) => {
    if (s.kind === 'event') events.push(s.event)
  })
  const result = adapter.write(handle, {
    type: 'user_message',
    text: 'hello',
    clientMessageId: 'phone-00000012'
  })
  const assertion = expect(result).rejects.toMatchObject({ _tag: 'UnconfirmedSessionWrite' })
  acknowledge(new Error('EPIPE'))
  await assertion
  expect(events.filter((e) => e.type === 'user_message')).toHaveLength(0)
  child.emit('exit', 0)
})
