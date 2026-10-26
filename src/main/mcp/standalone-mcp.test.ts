import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SessionHost } from '@clave/server'
import type { Session } from '@clave/contract/sessions'
import { SERVER_LAYOUT_KEY } from '@clave/contract/sidebar'
import { SidebarLayouts, memorySidebarStorage, noWindowsHost } from '@clave/server/sidebar-layouts'
import { PendingRequests } from '../../../packages/server/src/requests/service'
import { createAgentTokenStore } from '../sessions/agent-tokens'
import { executeSecretAction } from '../secret-actions'
import { startStandaloneMcp } from './standalone-mcp'

const closes: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
})
const payload = (result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> => {
  const content = result.content as Array<{ type: string; text?: string }>
  expect(content[0].type).toBe('text')
  return JSON.parse(content[0].text!)
}
async function fixture(): Promise<{
  requests: PendingRequests
  client: Client
  other: Client
  directory: string
  url: string
}> {
  const scratch = join('/tmp', process.env.CLAVE_E2E_NS ?? 'clave-vps-d-impl')
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, 'mcp-'))
  closes.push(() => rm(directory, { force: true, recursive: true }))
  const tokens = createAgentTokenStore(join(directory, 'mcp-configs'))
  const requests = new PendingRequests()
  const mcp = await startStandaloneMcp({
    sessions: {
      ...SessionHost.none,
      get: (id) => ({
        id,
        cwd: directory,
        windowKey: 'server',
        provider: 'codex',
        adapterId: 'codex-chat',
        transport: 'events',
        state: 'working',
        createdAt: 1,
        title: 'MCP caller'
      }),
      list: () => []
    },
    requests,
    agentTools: tokens,
    executeSecret: async (action, value) => {
      const result = await executeSecretAction(action, value, { shell: '/bin/sh', env: {} })
      if (!result.ok) throw new Error('Action failed.')
    }
  })
  closes.push(() => mcp.close())
  tokens.announce(mcp.url)
  const clients: Client[] = []
  for (const id of ['caller', 'other']) {
    const file = tokens.mcpConfig.write(id)!
    const config = JSON.parse(await readFile(file, 'utf8'))
    const auth = config.mcpServers.clave.headers.Authorization
    const client = new Client({ name: 'isolated-test', version: '1' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcp.url), {
        requestInit: { headers: { Authorization: auth } }
      })
    )
    closes.push(() => client.close())
    clients.push(client)
  }
  return { requests, client: clients[0], other: clients[1], directory, url: mcp.url }
}

describe('server-owned MCP without an Electron callback', () => {
  it('creates explicit approval and clarification work without a desktop and polls caller-scoped results', async () => {
    const { requests, client, other, url } = await fixture()
    const approval = payload(
      await client.callTool({
        name: 'clave_request_approval',
        arguments: { description: 'Run migration?' }
      })
    )
    expect(approval).toMatchObject({ status: 'pending', requestId: expect.any(String) })
    const question = payload(
      await client.callTool({
        name: 'clave_request_clarification',
        arguments: {
          description: 'Select a branch',
          questions: [{ question: 'Branch?', options: [{ label: 'dev' }] }]
        }
      })
    )
    expect(requests.snapshot().pending).toHaveLength(2)
    const foreign = await other.callTool({
      name: 'clave_request_result',
      arguments: { requestId: question.requestId }
    })
    expect(foreign.isError).toBe(true)
    await requests.resolve({
      requestId: approval.requestId as string,
      response: { type: 'permission', optionId: 'approve' }
    })
    await requests.resolve({
      requestId: question.requestId as string,
      response: { type: 'clarification', answers: { 'Branch?': 'dev' } }
    })
    expect(
      payload(
        await client.callTool({
          name: 'clave_request_result',
          arguments: { requestId: question.requestId }
        })
      )
    ).toMatchObject({ status: 'completed', response: { answers: { 'Branch?': 'dev' } } })
    expect(
      (await fetch(url, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' }))
        .status
    ).toBe(401)
  }, 15_000)

  it('keeps secret work after MCP disconnection and executes only the first valid client answer', async () => {
    const { requests, client, other, directory } = await fixture()
    const file = join(directory, '.env')
    const result = payload(
      await client.callTool({
        name: 'clave_request_secret',
        arguments: {
          description: 'Store the integration token',
          action: { type: 'env-file', file, key: 'API_KEY' }
        }
      })
    )
    const requestId = result.requestId as string
    await client.close()
    expect(requests.snapshot().pending).toHaveLength(1)
    const secret = 'secret-that-must-not-be-replayed'
    const responses = await Promise.all(
      [secret, 'loser-secret'].map((value) =>
        requests.resolve({
          requestId,
          response: { type: 'secret', value }
        })
      )
    )
    expect(responses.map((r) => r.accepted)).toEqual([true, false])
    expect(await readFile(file, 'utf8')).toBe(`API_KEY=${secret}\n`)
    expect(requests.result(requestId, 'caller')).toEqual({ requestId, status: 'completed' })
    expect(JSON.stringify(requests.result(requestId, 'caller'))).not.toContain(secret)
    expect(
      (await other.callTool({ name: 'clave_secret_result', arguments: { requestId } })).isError
    ).toBe(true)
  }, 15_000)

  it('validates secret actions and never returns subprocess output', async () => {
    const { requests, client, directory } = await fixture()
    expect(
      (
        await client.callTool({
          name: 'clave_request_secret',
          arguments: {
            description: 'Invalid action',
            action: { type: 'run', cwd: directory, command: 'echo inline', envVar: 'SECRET' }
          }
        })
      ).isError
    ).toBe(true)
    expect(requests.snapshot().pending).toHaveLength(0)
    const result = payload(
      await client.callTool({
        name: 'clave_request_secret',
        arguments: {
          description: 'Run a reviewed command',
          action: {
            type: 'run',
            cwd: directory,
            command: 'printf "%s" "$SECRET"',
            envVar: 'SECRET'
          }
        }
      })
    )
    const requestId = result.requestId as string
    await requests.resolve({ requestId, response: { type: 'secret', value: 'output-sentinel' } })
    const polled = payload(
      await client.callTool({ name: 'clave_secret_result', arguments: { requestId } })
    )
    expect(polled).toEqual({ requestId, status: 'completed' })
    expect(JSON.stringify(polled)).not.toContain('output-sentinel')
  }, 15_000)
})

interface StartedCall {
  cwd: string
  windowKey?: string | undefined
  options?: Record<string, unknown> | undefined
}
/** A host that runs sessions the way the daemon's server-owned host does: a
 *  start lands in the server sidebar, a chat tab is ready at once and a
 *  terminal waits for its first size. */
async function sessionFixture(): Promise<{
  client: Client
  started: StartedCall[]
  stopped: string[]
  resized: Array<[string, number, number]>
  sessions: Map<string, Session>
  sidebar: SidebarLayouts
  directory: string
}> {
  const scratch = join('/tmp', process.env.CLAVE_E2E_NS ?? 'clave-vps-d-impl')
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, 'mcp-sessions-'))
  closes.push(() => rm(directory, { force: true, recursive: true }))
  const tokens = createAgentTokenStore(join(directory, 'mcp-configs'))
  const sidebar = new SidebarLayouts(memorySidebarStorage(), noWindowsHost, {
    layoutKey: SERVER_LAYOUT_KEY
  })
  const sessions = new Map<string, Session>()
  const caller: Session = {
    id: 'caller',
    cwd: directory,
    windowKey: SERVER_LAYOUT_KEY,
    provider: 'claude',
    adapterId: 'claude-chat',
    transport: 'events',
    state: 'working',
    createdAt: 1,
    title: 'Lane lead'
  }
  sessions.set(caller.id, caller)
  const started: StartedCall[] = []
  const stopped: string[] = []
  const resized: Array<[string, number, number]> = []
  let next = 0
  const mcp = await startStandaloneMcp({
    sessions: {
      ...SessionHost.none,
      get: (id) => sessions.get(id),
      list: () => [...sessions.values()],
      start: async (input) => {
        started.push(input as StartedCall)
        const options = input.options ?? {}
        const id = `started-${++next}`
        const chat = typeof options.launchProfileId === 'string'
        sessions.set(id, {
          id,
          cwd: input.cwd,
          windowKey: SERVER_LAYOUT_KEY,
          provider: options.codexMode ? 'codex' : options.claudeMode ? 'claude' : 'terminal',
          adapterId: chat ? String(options.launchProfileId) : 'pty',
          transport: chat ? 'events' : 'pty',
          state: 'idle',
          createdAt: 2,
          title: 'new tab'
        })
        sidebar.placeSession(SERVER_LAYOUT_KEY, id, null)
        return {
          id,
          cwd: input.cwd,
          folderName: 'repo',
          alive: true,
          claudeSessionId: null,
          piSessionId: null
        }
      },
      stop: async (id) => {
        stopped.push(id)
        sessions.delete(id)
      },
      rename: (id, name) => {
        const session = sessions.get(id)
        if (!session) throw new Error('Unknown session.')
        const renamed = { ...session, title: name }
        sessions.set(id, renamed)
        return renamed
      },
      resize: (id, cols, rows) => {
        resized.push([id, cols, rows])
      }
    },
    sidebar,
    requests: new PendingRequests(),
    agentTools: tokens,
    executeSecret: async () => {}
  })
  closes.push(() => mcp.close())
  tokens.announce(mcp.url)
  const file = tokens.mcpConfig.write('caller')!
  const config = JSON.parse(await readFile(file, 'utf8'))
  const client = new Client({ name: 'session-tools-test', version: '1' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcp.url), {
      requestInit: { headers: { Authorization: config.mcpServers.clave.headers.Authorization } }
    })
  )
  closes.push(() => client.close())
  return { client, started, stopped, resized, sessions, sidebar, directory }
}
const errorText = (result: Awaited<ReturnType<Client['callTool']>>): string => {
  expect(result.isError).toBe(true)
  return (result.content as Array<{ text?: string }>).map((c) => c.text ?? '').join('\n')
}

describe('standalone MCP session tools', () => {
  it('opens a Codex chat tab with its model, name and prompt, linked to its caller', async () => {
    const { client, started, sessions, directory } = await sessionFixture()
    const opened = payload(
      await client.callTool({
        name: 'clave_open_session',
        arguments: {
          cwd: directory,
          mode: 'codex',
          model: 'gpt-6.1-sol',
          name: 'Lane A verify | Codex',
          prompt: 'Read the brief and reply READY.'
        }
      })
    )
    expect(opened).toEqual({ sessionId: 'started-1', groupId: null })
    expect(started).toHaveLength(1)
    expect(started[0].cwd).toBe(directory)
    expect(started[0].options).toMatchObject({
      codexMode: true,
      claudeMode: false,
      dangerousMode: false,
      model: 'gpt-6.1-sol',
      launchProfileId: 'codex-chat',
      initialPrompt: 'Read the brief and reply READY.'
    })
    expect(sessions.get('started-1')?.title).toBe('Lane A verify | Codex')
    const listed = payload(await client.callTool({ name: 'clave_list', arguments: {} }))
    const entry = (listed.sessions as Array<Record<string, unknown>>).find(
      (s) => s.id === 'started-1'
    )
    expect(entry).toMatchObject({ id: 'started-1', parentId: 'caller' })
    const self = (listed.sessions as Array<Record<string, unknown>>).find((s) => s.id === 'caller')
    expect(self?.parentId).toBeUndefined()
  }, 15_000)

  it('opens a terminal tab with its command and gives it a first size so the process starts', async () => {
    const { client, started, resized, directory } = await sessionFixture()
    payload(
      await client.callTool({
        name: 'clave_open_session',
        arguments: { cwd: directory, mode: 'terminal', command: 'ls' }
      })
    )
    expect(started[0].options).toMatchObject({
      claudeMode: false,
      codexMode: false,
      initialCommand: 'ls',
      autoExecute: true
    })
    expect(started[0].options?.launchProfileId).toBeUndefined()
    expect(resized).toEqual([['started-1', 120, 30]])
  }, 15_000)

  it('opens a Claude terminal instead of the chat view with chat: false', async () => {
    const { client, started, resized, directory } = await sessionFixture()
    payload(
      await client.callTool({
        name: 'clave_open_session',
        arguments: { cwd: directory, chat: false, dangerous: true }
      })
    )
    expect(started[0].options).toMatchObject({ claudeMode: true, dangerousMode: true })
    expect(started[0].options?.launchProfileId).toBeUndefined()
    expect(resized).toEqual([['started-1', 120, 30]])
  }, 15_000)

  it('rejects a relative or missing directory, an unknown mode and desktop-only arguments without starting anything', async () => {
    const { client, started, directory } = await sessionFixture()
    expect(
      errorText(
        await client.callTool({ name: 'clave_open_session', arguments: { cwd: 'relative/dir' } })
      )
    ).toContain('absolute')
    expect(
      errorText(
        await client.callTool({
          name: 'clave_open_session',
          arguments: { cwd: join(directory, 'missing') }
        })
      )
    ).toContain('no such directory')
    errorText(
      await client.callTool({
        name: 'clave_open_session',
        arguments: { cwd: directory, mode: 'emacs' }
      })
    )
    for (const extra of [{ account: 'Work' }, { window: 2 }, { workspace: 'Main' }]) {
      expect(
        errorText(
          await client.callTool({
            name: 'clave_open_session',
            arguments: { cwd: directory, ...extra }
          })
        )
      ).toContain('standalone server')
    }
    expect(started).toHaveLength(0)
  }, 15_000)

  it('closes and renames sessions, resolving "mine" to the caller and refusing an unknown id', async () => {
    const { client, stopped, sessions, directory } = await sessionFixture()
    const { sessionId } = payload(
      await client.callTool({ name: 'clave_open_session', arguments: { cwd: directory } })
    )
    payload(
      await client.callTool({
        name: 'clave_rename',
        arguments: { target: 'session', id: sessionId, name: 'Verifier' }
      })
    )
    expect(sessions.get(sessionId as string)?.title).toBe('Verifier')
    payload(
      await client.callTool({
        name: 'clave_rename',
        arguments: { target: 'session', id: 'mine', name: 'Lane lead | Claude' }
      })
    )
    expect(sessions.get('caller')?.title).toBe('Lane lead | Claude')
    errorText(
      await client.callTool({
        name: 'clave_rename',
        arguments: { target: 'session', id: 'nope', name: 'x' }
      })
    )
    payload(await client.callTool({ name: 'clave_close_session', arguments: { sessionId } }))
    expect(stopped).toEqual([sessionId])
    expect(
      errorText(
        await client.callTool({ name: 'clave_close_session', arguments: { sessionId: 'nope' } })
      )
    ).toContain('Unknown session')
    expect(stopped).toEqual([sessionId])
  }, 15_000)

  it('creates a group, opens a tab in it, moves another into it and refuses an unknown group', async () => {
    const { client, started, sidebar, directory } = await sessionFixture()
    const { groupId } = payload(
      await client.callTool({ name: 'clave_create_group', arguments: { name: 'Lane lll-1026' } })
    )
    expect(groupId).toEqual(expect.any(String))
    const inGroup = payload(
      await client.callTool({
        name: 'clave_open_session',
        arguments: { cwd: directory, mode: 'codex', groupId }
      })
    )
    expect(inGroup.groupId).toBe(groupId)
    const loose = payload(
      await client.callTool({ name: 'clave_open_session', arguments: { cwd: directory } })
    )
    payload(
      await client.callTool({
        name: 'clave_move_session',
        arguments: { sessionId: loose.sessionId, groupId }
      })
    )
    const group = sidebar.get(SERVER_LAYOUT_KEY).groups.find((g) => g.id === groupId)
    expect(group?.name).toBe('Lane lll-1026')
    expect([...(group?.sessionIds ?? [])].sort()).toEqual(
      [inGroup.sessionId, loose.sessionId].sort()
    )
    payload(
      await client.callTool({
        name: 'clave_rename',
        arguments: { target: 'group', id: groupId, name: 'Lane C' }
      })
    )
    expect(sidebar.get(SERVER_LAYOUT_KEY).groups.find((g) => g.id === groupId)?.name).toBe('Lane C')
    const before = started.length
    expect(
      errorText(
        await client.callTool({
          name: 'clave_open_session',
          arguments: { cwd: directory, groupId: 'no-such-group' }
        })
      )
    ).toContain('Unknown group')
    expect(started).toHaveLength(before)
    errorText(
      await client.callTool({
        name: 'clave_move_session',
        arguments: { sessionId: loose.sessionId, groupId: 'no-such-group' }
      })
    )
  }, 15_000)
})
