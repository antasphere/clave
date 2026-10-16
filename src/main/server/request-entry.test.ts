import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { createApiClient } from '../../../packages/client/src/api'

const children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    await exited
    clearTimeout(timer)
  }
})

it('wires requests, server-owned MCP and C FilesPort in the real built daemon', async () => {
  const scratch = join('/tmp', process.env.CLAVE_E2E_NS ?? 'clave-vps-d-impl')
  await mkdir(scratch, { recursive: true })
  const dataDir = await mkdtemp(join(scratch, 'daemon-'))
  const id = 'ce3069da-c48e-4304-b5f5-bb601f907e01'
  const token = 'isolated-agent-token-for-daemon-check'
  await mkdir(join(dataDir, 'mcp-configs'))
  await writeFile(
    join(dataDir, 'mcp-configs', `${id}.json`),
    JSON.stringify({
      mcpServers: {
        clave: {
          type: 'http',
          url: 'http://127.0.0.1:1/mcp',
          headers: { Authorization: `Bearer ${token}` }
        }
      }
    }),
    { mode: 0o600 }
  )
  const child = spawn(
    process.execPath,
    [
      resolve('out/main/server-entry.js'),
      '--data-dir',
      dataDir,
      '--daemon',
      '--test-no-activate',
      '--dev-echo-adapter'
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CLAVE_E2E_NS: process.env.CLAVE_E2E_NS ?? 'clave-vps-d-impl',
        CLAVE_KEYCHAIN_FILE: join(dataDir, 'test-keychain.json')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  )
  children.push(child)
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  let discovery!: { url: string; token: string; serverId: string; agentToolsUrl: string }
  await vi.waitFor(
    async () => {
      if (child.exitCode !== null) throw new Error(`Daemon exited ${child.exitCode}: ${stderr}`)
      discovery = JSON.parse(await readFile(join(dataDir, 'clave-server.json'), 'utf8'))
      expect(discovery.agentToolsUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    },
    { timeout: 20_000, interval: 50 }
  )
  const api = createApiClient({ url: discovery.url, token: discovery.token })
  const client = new Client({ name: 'built-daemon-check', version: '1' })
  try {
    await api.sessions.start({
      cwd: dataDir,
      options: {
        adoptSessionId: id,
        launchProfileId: 'dev-echo-adapter'
      }
    })
    expect(await api.requests.list()).toMatchObject({ pending: [] })
    await api.agentTools.announce('http://127.0.0.1:1/desktop-is-gone')
    // A listener alone would survive an accidental desktop takeover. Prove
    // the next provider's actual config still points at the daemon endpoint.
    // This is a deterministic protocol fixture, with no provider/network call.
    const provider = join(dataDir, 'provider-fixture.cjs')
    const providerReplies = join(dataDir, 'provider-replies.jsonl')
    await writeFile(
      provider,
      `
      const readline = require('node:readline');
      const fs = require('node:fs');
      readline.createInterface({input:process.stdin}).on('line', line => {
        const frame = JSON.parse(line);
        if (frame.id === 'native-input' && frame.result) {
          fs.appendFileSync(${JSON.stringify(providerReplies)}, JSON.stringify(frame)+'\\n');
          return;
        }
        if (frame.id === undefined) return;
        const result = frame.method === 'thread/start' ? {thread:{id:'fixture-thread'}} : {};
        process.stdout.write(JSON.stringify({id:frame.id,result})+'\\n');
        if (frame.method === 'thread/start') process.stdout.write(JSON.stringify({
          id:'native-input', method:'item/tool/requestUserInput', params:{
            threadId:'fixture-thread',turnId:'fixture-turn',itemId:'fixture-item',isBlocking:true,
            questions:[{id:'private-question-id',header:'Private',question:'Native private input?',isSecret:true,options:null}]
          }
        })+'\\n');
      });
    `
    )
    await api.settings.launchProfiles.upsert({
      id: 'request-fixture',
      name: 'Isolated protocol fixture',
      family: 'codex',
      command: [process.execPath, provider],
      additionalArgs: []
    })
    const providerSession = await api.sessions.start({
      cwd: dataDir,
      options: {
        codexMode: true,
        claudeMode: false,
        launchProfileId: 'chat:codex:request-fixture'
      }
    })
    await vi.waitFor(
      async () => {
        const config = JSON.parse(
          await readFile(join(dataDir, 'mcp-configs', `${providerSession.id}.json`), 'utf8')
        )
        expect(config.mcpServers.clave.url).toBe(discovery.agentToolsUrl)
      },
      { timeout: 10_000 }
    )
    let nativeId = ''
    await vi.waitFor(
      async () => {
        const pending = (await api.requests.list()).pending.find(
          (r) => r.providerRequestId === '"native-input"'
        )
        expect(pending).toMatchObject({
          kind: 'clarification',
          secretQuestions: ['Native private input?']
        })
        nativeId = pending!.id
      },
      { timeout: 10_000 }
    )
    const anotherClient = createApiClient({ url: discovery.url, token: discovery.token })
    const privateValue = 'BUILT-PROVIDER-PRIVATE-SENTINEL'
    try {
      const raced = await Promise.all(
        [api, anotherClient].map((owner) =>
          owner.requests.resolve({
            requestId: nativeId,
            response: {
              type: 'permission',
              optionId: 'answer',
              answers: { 'Native private input?': privateValue }
            }
          })
        )
      )
      expect(raced.filter((r) => r.accepted)).toHaveLength(1)
      await vi.waitFor(async () => {
        const replies = (await readFile(providerReplies, 'utf8'))
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        expect(replies).toEqual([
          {
            id: 'native-input',
            result: {
              answers: {
                'private-question-id': { answers: [privateValue] }
              }
            }
          }
        ])
      })
      expect((await api.requests.list()).pending).toEqual([])
      expect(
        await readFile(join(dataDir, 'server-history', `${providerSession.id}.json`), 'utf8')
      ).not.toContain(privateValue)
    } finally {
      await anotherClient.dispose()
    }
    await client.connect(
      new StreamableHTTPClientTransport(new URL(discovery.agentToolsUrl), {
        requestInit: { headers: { authorization: `Bearer ${token}` } }
      })
    )
    const created = await client.callTool({
      name: 'clave_request_approval',
      arguments: { description: 'Built-server approval' }
    })
    const { requestId } = JSON.parse((created.content as Array<{ text: string }>)[0].text) as {
      requestId: string
    }
    expect((await api.requests.list()).pending[0].id).toBe(requestId)
    expect(
      await api.requests.resolve({
        requestId,
        response: { type: 'permission', optionId: 'approve' }
      })
    ).toEqual({ accepted: true })
    const file = { root: dataDir, path: 'owned.txt' }
    await api.files.write({ ...file, content: 'FilesPort is wired on this daemon.' })
    expect((await api.files.read(file)).content).toBe('FilesPort is wired on this daemon.')
    const attachment = await api.files.prepareAttachment({
      sessionId: id,
      source: {
        kind: 'upload',
        name: 'local.txt',
        image: false,
        base64: Buffer.from('owner attachment').toString('base64')
      }
    })
    expect(
      attachment.path.startsWith(join(await realpath(dataDir), 'session-attachments') + '/')
    ).toBe(true)
    expect(await readFile(attachment.path, 'utf8')).toBe('owner attachment')
    await api.sessions.stop(id)
    await api.sessions.stop(providerSession.id)
  } finally {
    await client.close()
    await api.dispose()
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      await exited
      clearTimeout(timer)
    }
    await rm(dataDir, { recursive: true, force: true })
  }
}, 30_000)
