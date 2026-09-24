import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SessionEventSchema, type SessionEvent } from '../../../shared/session-model'
const mock = vi.hoisted(() => ({
  spawn: vi.fn(),
  token: vi.fn(() => 'secret-account-token'),
  find: vi.fn((): string | null => null)
}))
vi.mock('node:child_process', () => ({ spawn: mock.spawn }))
// The binary is nowhere on the test PATH unless a case says so: the launch
// then takes the login-shell wrapper, which is what most cases exercise.
vi.mock('../../shell-launch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shell-launch')>()),
  findExecutable: mock.find
}))
vi.mock('../../mcp/mcp-runtime', () => ({
  getMcpRuntime: () => null,
  deleteSessionMcpConfig: vi.fn()
}))
vi.mock('../../launch-profile-manager', () => ({
  launchProfileManager: {
    resolve: () => ({
      id: 'custom',
      name: 'Custom',
      family: 'claude',
      command: ['claude'],
      additionalArgs: ['--debug']
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
import { ClaudeAdapter, ClaudeStreamTranslator, HOST_COMMANDS } from './claude-adapter'
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
})
afterEach(() => vi.restoreAllMocks())
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
  adapter.write(handle, { type: 'interrupt' })
  const inputs = child.stdin.read().toString().trim().split('\n').map(JSON.parse)
  expect(inputs[0]).toEqual({ type: 'user', message: { role: 'user', content: 'Hello' } })
  expect(inputs[2]).toMatchObject({
    response: { request_id: 'p', response: { behavior: 'allow', updatedInput: { x: 1 } } }
  })
  expect(inputs[3]).toMatchObject({ type: 'control_request', request: { subtype: 'interrupt' } })
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
  expect(child.stdin.read().toString()).toBe(
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'initial prompt' } }) + '\n'
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
  expect(child.stdin.read().toString()).toContain('retry me')
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
    const { deleteSessionMcpConfig } = await import('../../mcp/mcp-runtime')
    expect(deleteSessionMcpConfig).toHaveBeenCalledExactlyOnceWith(spec.id)
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
it('lists the models the CLI itself offers, starting a session that has not spoken yet', async () => {
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
  const request = JSON.parse(child.stdin.read().toString())
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
              resolvedModel: 'claude-opus-5-5[1m]',
              displayName: 'Default (recommended)',
              description: 'Opus 5.5 with 1M context'
            },
            { value: 'haiku', displayName: 'Haiku' }
          ]
        }
      }
    }) + '\n'
  )
  await expect(listed).resolves.toEqual([
    {
      id: 'default',
      label: 'Default (recommended)',
      hint: 'Opus 5.5 with 1M context',
      resolved: 'claude-opus-5-5[1m]'
    },
    { id: 'haiku', label: 'Haiku' }
  ])
  // A second ask reuses the running process and says why when the CLI refuses.
  const refused = adapter.models(handle)
  const again = JSON.parse(child.stdin.read().toString())
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
    const request = JSON.parse(child.stdin.read().toString())
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
    expect(JSON.parse(child.stdin.read().toString())).toEqual({
      type: 'user',
      message: { role: 'user', content: 'Hello' }
    })
    child.emit('close', 0)
    await adapter.kill(handle)
  }
)
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
  // Booting is silent: the model announcement, and no turn, no state.
  expect(events).toEqual([{ type: 'session_meta', model: null, providerSessionId: null }])
  expect(child.stdin.read()).toBeNull()
  adapter.ready(handle)
  adapter.write(handle, { type: 'user_message', text: 'Hello' })
  expect(mock.spawn).toHaveBeenCalledTimes(1)
  // The first message is working before the CLI has said a word.
  expect(events.slice(1)).toEqual([
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
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.' }] } }
  ].map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
  translator.replay(lines)
  expect(events).toEqual([
    { type: 'user_message', text: '/exos:lane clave 2527' },
    { type: 'user_message', text: 'Fix the capture scan' },
    { type: 'assistant_text', delta: 'Looking.', final: true },
    { type: 'tool_call', id: 't1', name: 'Bash', input: { command: 'ls' } },
    { type: 'tool_call', id: 't2', name: 'Read', input: { file_path: '/x' } },
    { type: 'tool_result', id: 't1', output: 'a\nb', error: true },
    { type: 'assistant_text', delta: 'Done.', final: true },
    // Never answered in the transcript: closed rather than left running.
    { type: 'tool_result', id: 't2', output: undefined }
  ])
  for (const event of events) expect(SessionEventSchema.safeParse(event).success).toBe(true)
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
  const request = JSON.parse(child.stdin.read().toString())
  child.stdout.write(
    JSON.stringify({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: request.request_id,
        response: {
          commands: [
            { name: 'review', description: 'Review a PR', argumentHint: '' },
            { name: 'resume', description: 'the CLI one' }
          ]
        }
      }
    }) + '\n'
  )
  expect(await listed).toEqual([
    ...HOST_COMMANDS,
    { name: 'review', description: 'Review a PR', insert: '/review ' }
  ])
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
  const input = JSON.parse(child.stdin.read().toString().trim())
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
  expect(JSON.parse(child.stdin.read().toString().trim()).message.content).toBe(
    'read it\n\nAttached local files:\n{"path":"/pictures/shot.png"}'
  )
  child.emit('close', 0)
  await adapter.kill(handle)
})
