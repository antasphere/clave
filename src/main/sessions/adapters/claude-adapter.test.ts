import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionEvent } from '../../../shared/session-model'
const mock = vi.hoisted(() => ({ spawn: vi.fn(), token: vi.fn(() => 'secret-account-token') }))
vi.mock('node:child_process', () => ({ spawn: mock.spawn }))
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
  isValidClaudeSessionId: (s) => /^[\w-]+$/.test(s),
  isValidModelName: (s) => !s.startsWith('-')
}))
import { ClaudeAdapter, ClaudeStreamTranslator } from './claude-adapter'
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
    options: { resume: 'resume-id', model: 'opus', permissionMode: 'manual' }
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
  expect(events.some((event) => event.type === 'state_change')).toBe(false)
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
