import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpConnection, type RpcNotification, type RpcRequest } from './acp-client'

/** The stand-in agent's own contract (tests/e2e/fixtures/acp-agent.mjs). */
const ACP_STAND_IN = resolve(__dirname, '../../../../tests/e2e/fixtures/acp-agent.mjs')

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
  const dir = mkdtempSync(join(tmpdir(), 'acp-stand-in-'))
  dirs.push(dir)
  return dir
}

interface StandIn {
  child: ChildProcessWithoutNullStreams
  connection: AcpConnection
  notifications: RpcNotification[]
  requests: RpcRequest[]
  answer(handler: (frame: RpcRequest) => void): void
  updates(): Record<string, unknown>[]
}

function standIn(state: string, env: Record<string, string> = {}, args = ['acp']): StandIn {
  const child = spawn(process.execPath, [ACP_STAND_IN, ...args], {
    env: { ...process.env, ACP_STAND_IN_STATE: state, ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  children.push(child)
  const notifications: RpcNotification[] = []
  const requests: RpcRequest[] = []
  let onRequest: (frame: RpcRequest) => void = () => {}
  const connection = new AcpConnection(child, {
    notification: (frame) => notifications.push(frame),
    request: (frame) => {
      requests.push(frame)
      onRequest(frame)
    },
    error: () => {},
    exit: () => {}
  })
  return {
    child,
    connection,
    notifications,
    requests,
    answer(handler: (frame: RpcRequest) => void) {
      onRequest = handler
    },
    updates: () =>
      notifications.map((n) => (n.params as { update: Record<string, unknown> }).update)
  }
}

const init = { protocolVersion: 1, clientCapabilities: { fs: {}, terminal: false } }
type Opened = { sessionId: string; configOptions: { currentValue: string }[] }

/** A session opened, its `available_commands_update` arrived: the stand-in
 *  sends it right after the answer, so it may land in a later chunk than the
 *  answer, and a test that clears the notifications then would see it among
 *  its prompt's (verifier round 1, Minor 5). */
async function open(agent: StandIn, cwd = '/tmp/project'): Promise<Opened> {
  await agent.connection.request('initialize', init)
  const opened = (await agent.connection.request('session/new', { cwd, mcpServers: [] })) as Opened
  await expect
    .poll(() => agent.updates().some((u) => u.sessionUpdate === 'available_commands_update'))
    .toBe(true)
  return opened
}
const say = (agent: StandIn, sessionId: string, text: string): Promise<unknown> =>
  agent.connection.request(
    'session/prompt',
    { sessionId, prompt: [{ type: 'text', text }] },
    { timeout: null }
  )

describe('the ACP stand-in agent', () => {
  it('prints its version and refuses an unknown argument', async () => {
    const run = (args: string[]): Promise<{ code: number | null; out: string; err: string }> =>
      new Promise<{ code: number | null; out: string; err: string }>((done) => {
        const child = spawn(process.execPath, [ACP_STAND_IN, ...args], {
          env: { ...process.env, ACP_STAND_IN_STATE: stateDir() }
        })
        children.push(child as ChildProcessWithoutNullStreams)
        let out = ''
        let err = ''
        child.stdout.on('data', (c: Buffer) => (out += c))
        child.stderr.on('data', (c: Buffer) => (err += c))
        child.on('close', (code) => done({ code, out, err }))
      })
    expect(await run(['--version'])).toMatchObject({ code: 0, out: 'stand-in 0.0.0\n' })
    const wrong = await run(['serve'])
    expect(wrong.code).toBe(2)
    expect(wrong.err).toContain('usage')
  })

  it('answers initialize and session/new with its capabilities, config and commands', async () => {
    const agent = standIn(stateDir())
    const init = (await agent.connection.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {}
    })) as Record<string, unknown>
    expect(init).toMatchObject({
      protocolVersion: 1,
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} } },
      authMethods: [{ id: 'stand-in-login', description: 'Run `stand-in login` in the terminal' }],
      agentInfo: { name: 'Stand-in', version: '0.0.0' }
    })
    const opened = (await agent.connection.request('session/new', {
      cwd: '/tmp/x',
      mcpServers: []
    })) as Opened & { configOptions: unknown[] }
    expect(opened.sessionId).toMatch(/^ses_[0-9a-f]{16}$/)
    expect(opened.configOptions).toEqual([
      {
        id: 'model',
        name: 'Model',
        category: 'model',
        type: 'select',
        currentValue: 'stand-in/one',
        options: [
          { value: 'stand-in/one', name: 'One' },
          { value: 'stand-in/two', name: 'Two' },
          { value: 'stand-in/three', name: 'Three' }
        ]
      }
    ])
    await expect
      .poll(() => agent.updates())
      .toEqual([
        {
          sessionUpdate: 'available_commands_update',
          availableCommands: [
            { name: 'init', description: expect.any(String) },
            { name: 'compact', description: expect.any(String) }
          ]
        }
      ])
  })

  it('answers a prompt with the exact update sequence, then end_turn', async () => {
    const agent = standIn(stateDir())
    const { sessionId } = await open(agent)
    agent.notifications.length = 0
    await expect(say(agent, sessionId, 'hello')).resolves.toEqual({ stopReason: 'end_turn' })
    const updates = agent.updates()
    const call = updates[3].toolCallId
    expect(updates).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'You said: ' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hel' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } },
      {
        sessionUpdate: 'tool_call',
        toolCallId: call,
        title: 'Read README.md',
        kind: 'read',
        status: 'in_progress',
        rawInput: { path: 'README.md' }
      },
      {
        sessionUpdate: 'tool_call_update',
        toolCallId: call,
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: '# Stand-in' } }]
      }
    ])
    for (const n of agent.notifications)
      expect(n).toMatchObject({ method: 'session/update', params: { sessionId } })
  })

  it('sends one update for another session during a prompt when told to (ACP_STAND_IN_STRAY_UPDATE)', async () => {
    const agent = standIn(stateDir(), { ACP_STAND_IN_STRAY_UPDATE: '1' })
    const { sessionId } = await open(agent)
    agent.notifications.length = 0
    await say(agent, sessionId, 'hello')
    const strays = agent.notifications.filter(
      (n) => (n.params as { sessionId: string }).sessionId !== sessionId
    )
    expect(strays).toEqual([
      {
        method: 'session/update',
        params: {
          sessionId: 'ses_other',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'stray text of another session' }
          }
        }
      }
    ])
  })

  it('asks permission and echoes the chosen option', async () => {
    const agent = standIn(stateDir())
    const { sessionId } = await open(agent)
    agent.answer((frame) =>
      agent.connection.respond(frame.id, {
        outcome: { outcome: 'selected', optionId: 'allow_always' }
      })
    )
    agent.notifications.length = 0
    await expect(say(agent, sessionId, 'please ask permission')).resolves.toEqual({
      stopReason: 'end_turn'
    })
    expect(agent.requests).toEqual([
      {
        id: 1,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: {
            toolCallId: expect.stringMatching(/^call_/),
            title: 'Write notes.md',
            kind: 'edit',
            status: 'pending',
            rawInput: { path: 'notes.md' }
          },
          options: [
            { optionId: 'allow_once', name: expect.any(String), kind: 'allow_once' },
            { optionId: 'allow_always', name: expect.any(String), kind: 'allow_always' },
            { optionId: 'reject_once', name: expect.any(String), kind: 'reject_once' }
          ]
        }
      }
    ])
    expect(agent.updates()[0]).toEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'permission: allow_always' }
    })
  })

  it('ends a slow prompt cancelled on session/cancel', async () => {
    const agent = standIn(stateDir())
    const { sessionId } = await open(agent)
    const turn = say(agent, sessionId, 'be slow')
    await new Promise((r) => setTimeout(r, 200))
    const started = Date.now()
    agent.connection.notify('session/cancel', { sessionId })
    await expect(turn).resolves.toEqual({ stopReason: 'cancelled' })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('replays what a prompt recorded on session/load, and refuses an unknown id', async () => {
    const state = stateDir()
    const first = standIn(state)
    const { sessionId } = await open(first)
    await say(first, sessionId, 'remember me')
    await first.connection.close()

    const second = standIn(state)
    await second.connection.request('initialize', init)
    const loaded = (await second.connection.request('session/load', {
      sessionId,
      cwd: '/tmp/project',
      mcpServers: []
    })) as Opened
    expect(loaded.configOptions[0].currentValue).toBe('stand-in/one')
    expect(second.updates().map((u) => u.sessionUpdate)).toEqual([
      'user_message_chunk',
      'agent_message_chunk',
      'tool_call',
      'tool_call_update'
    ])
    expect(second.updates()[0]).toMatchObject({ content: { text: 'remember me' } })
    expect(second.updates()[1]).toMatchObject({ content: { text: 'You said: remember me' } })
    await expect(
      second.connection.request('session/load', {
        sessionId: 'ses_0000000000000000',
        cwd: '/tmp',
        mcpServers: []
      })
    ).rejects.toMatchObject({ code: -32602, message: 'Unknown session' })
  })

  it('sets the model with set_config_option and refuses an unknown value', async () => {
    const agent = standIn(stateDir())
    const { sessionId } = await open(agent)
    const set = (await agent.connection.request('session/set_config_option', {
      sessionId,
      configId: 'model',
      value: 'stand-in/two'
    })) as Opened
    expect(set.configOptions[0].currentValue).toBe('stand-in/two')
    await expect(
      agent.connection.request('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: 'other/model'
      })
    ).rejects.toMatchObject({ code: -32602 })
  })

  it('lists its sessions newest first, filtered by cwd', async () => {
    const agent = standIn(stateDir())
    await agent.connection.request('initialize', init)
    const a = (await agent.connection.request('session/new', {
      cwd: '/a',
      mcpServers: []
    })) as Opened
    await new Promise((r) => setTimeout(r, 10))
    const b = (await agent.connection.request('session/new', {
      cwd: '/a',
      mcpServers: []
    })) as Opened
    await agent.connection.request('session/new', { cwd: '/b', mcpServers: [] })
    const listed = (await agent.connection.request('session/list', { cwd: '/a' })) as {
      sessions: { sessionId: string; cwd: string; updatedAt: string }[]
    }
    expect(listed.sessions.map((s) => s.sessionId)).toEqual([b.sessionId, a.sessionId])
    expect(listed.sessions[0]).toMatchObject({ cwd: '/a', updatedAt: expect.any(String) })
    const all = (await agent.connection.request('session/list', {})) as { sessions: unknown[] }
    expect(all.sessions).toHaveLength(3)
  })

  it('refuses session/new when told to, and an unknown method', async () => {
    const agent = standIn(stateDir(), { ACP_STAND_IN_REFUSE: 'auth' })
    await agent.connection.request('initialize', init)
    await expect(
      agent.connection.request('session/new', { cwd: '/tmp', mcpServers: [] })
    ).rejects.toMatchObject({ code: -32000, message: 'Not signed in' })
    await expect(agent.connection.request('fs/whatever', {})).rejects.toMatchObject({
      code: -32601
    })
  })

  it('records every frame it receives, and exits 0 at the end of stdin', async () => {
    const state = stateDir()
    const agent = standIn(state)
    await agent.connection.request('initialize', init)
    agent.child.stdin.write('not json\n')
    const exited = new Promise<number | null>((done) => agent.child.on('close', done))
    agent.child.stdin.end()
    expect(await exited).toBe(0)
    const frames = readFileSync(join(state, 'frames.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(frames).toEqual([
      { t: expect.any(Number), frame: expect.objectContaining({ method: 'initialize' }) }
    ])
  })
})
