import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { ClaveServerClient } from './client'
import { ServerError } from './errors'

/** A stub of the audited routes, recording what it was asked. */
interface Seen {
  method: string
  url: string
  auth?: string
  body?: string
}
const seen: Seen[] = []
let server: Server
let slowServer: Server
let url = ''
let slowUrl = ''
const TOKEN = 'tok-123'

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const session = {
  id: 's1',
  provider: 'echo',
  transport: 'events',
  cwd: '/tmp/scratch',
  windowKey: 'server',
  state: 'idle',
  createdAt: 1,
  adapterId: 'echo',
  title: 'Echo'
}

function handle(req: IncomingMessage, res: ServerResponse, body: string): void {
  const auth = req.headers.authorization
  seen.push({ method: req.method ?? '', url: req.url ?? '', auth, body: body || undefined })
  const u = new URL(req.url ?? '/', 'http://x')
  if (u.pathname.startsWith('/health/')) return json(res, 200, { ok: true })
  if (auth !== `Bearer ${TOKEN}`) return json(res, 401, { error: 'Unauthenticated' })
  switch (`${req.method} ${u.pathname}`) {
    case 'GET /sessions':
      return json(res, 200, [session])
    case 'GET /sessions/by-id':
      return u.searchParams.get('id') === 's1'
        ? json(res, 200, session)
        : json(res, 422, { _tag: 'SessionNotFound', id: u.searchParams.get('id') })
    case 'GET /sessions/history':
      return json(res, 200, {
        items: [
          { event: { type: 'user_message', text: `page before ${u.searchParams.get('before')}` } }
        ],
        before: u.searchParams.get('before') === null ? 200 : null
      })
    case 'GET /sessions/records':
      return json(res, 200, [
        { id: 's1', cwd: '/tmp/scratch', folderName: 'scratch', workspaceId: 'ws1', running: true }
      ])
    case 'POST /sessions/start': {
      const input = JSON.parse(body) as {
        options?: { launchProfile?: { name: string; command: string[] } }
      }
      const profile = input.options?.launchProfile
      if (profile && profile.command[0] === 'missing-agent')
        return json(res, 422, {
          _tag: 'SessionStartFailed',
          message: `Program "missing-agent" was not found on this server (launch profile "${profile.name}")`
        })
      return json(res, 200, {
        id: 's2',
        cwd: '/tmp/scratch',
        folderName: 'scratch',
        alive: true,
        claudeSessionId: null,
        piSessionId: null
      })
    }
    case 'POST /sessions/write':
      res.writeHead(204).end()
      return
    case 'GET /requests/pending':
      return json(res, 422, {
        _tag: 'CapabilityUnavailable',
        capability: 'requests',
        message: 'This server holds no pending requests.'
      })
    case 'GET /launch-profiles':
      return json(res, 200, {
        version: 1,
        customProfiles: [],
        globalDefaults: {},
        workspaceOverrides: {}
      })
    case 'GET /workspaces':
      return json(res, 200, { version: 1, workspaces: 'not a list' })
    case 'GET /slow':
      return
    default:
      return json(res, 404, { error: 'no such route' })
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => handle(req, res, body))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('no port')
  url = `http://127.0.0.1:${address.port}`
  // The same routes, every answer 60 ms late: what a deadline is measured against.
  slowServer = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => setTimeout(() => handle(req, res, body), 60))
  })
  await new Promise<void>((resolve) => slowServer.listen(0, '127.0.0.1', resolve))
  const slow = slowServer.address()
  if (!slow || typeof slow === 'string') throw new Error('no port')
  slowUrl = `http://127.0.0.1:${slow.port}`
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await new Promise<void>((resolve) => slowServer.close(() => resolve()))
})

const client = (): ClaveServerClient =>
  new ClaveServerClient(
    { serverUrl: `${url}/`, bearer: TOKEN },
    { timeoutMs: 2_000, build: 'development' }
  )

describe('ClaveServerClient', () => {
  it('sends the bearer on every call and decodes the answer', async () => {
    seen.length = 0
    const sessions = await client().sessions.list()
    expect(sessions).toEqual([session])
    expect(seen[0]).toMatchObject({ method: 'GET', url: '/sessions', auth: `Bearer ${TOKEN}` })
  })
  it('puts a query payload in the query string, and omits what is undefined', async () => {
    seen.length = 0
    const page = await client().sessions.history('s1')
    expect(page.before).toBe(200)
    expect(seen[0]?.url).toBe('/sessions/history?id=s1')
    const older = await client().sessions.history('s1', 200, 50)
    expect(older.before).toBeNull()
    expect(seen[1]?.url).toBe('/sessions/history?id=s1&before=200&limit=50')
  })
  it('joins record ids with a comma, and asks nothing for no ids', async () => {
    seen.length = 0
    expect(await client().sessions.records([])).toEqual([])
    expect(seen).toHaveLength(0)
    const records = await client().sessions.records(['s1', 's2'])
    expect(records[0]?.workspaceId).toBe('ws1')
    expect(decodeURIComponent(seen[0]?.url ?? '')).toBe('/sessions/records?ids=s1,s2')
  })
  it('posts a command as JSON', async () => {
    seen.length = 0
    await client().sessions.write('s1', {
      type: 'user_message',
      text: 'hi',
      clientMessageId: 'm-12345678'
    })
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/sessions/write' })
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      id: 's1',
      input: { type: 'user_message', text: 'hi', clientMessageId: 'm-12345678' }
    })
  })
  it('a 401 is unauthenticated', async () => {
    const bad = new ClaveServerClient(
      { serverUrl: url, bearer: 'wrong' },
      { timeoutMs: 2_000, build: 'development' }
    )
    await expect(bad.sessions.list()).rejects.toMatchObject({
      kind: 'unauthenticated',
      status: 401
    })
  })
  it("a 422 is a refusal in the server's words, the failure kept", async () => {
    const error = await client()
      .sessions.start({
        cwd: '/tmp/scratch',
        options: {
          claudeMode: true,
          launchProfileId: 'x',
          launchProfile: {
            id: 'x',
            name: 'Missing',
            family: 'claude',
            command: ['missing-agent'],
            additionalArgs: []
          }
        }
      })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ServerError)
    const refused = error as ServerError
    expect(refused.kind).toBe('refused')
    expect(refused.message).toBe(
      'Program "missing-agent" was not found on this server (launch profile "Missing")'
    )
    expect(refused.failure?._tag).toBe('SessionStartFailed')
  })
  it('CapabilityUnavailable is a refusal the caller can tell apart', async () => {
    const error = (await client()
      .requests.list()
      .catch((e: unknown) => e)) as ServerError
    expect(error.kind).toBe('refused')
    expect(error.capabilityUnavailable).toBe(true)
    expect(error.failure?.capability).toBe('requests')
  })
  it('a 422 without a message still has a sentence', async () => {
    const error = (await client()
      .sessions.get('nope')
      .catch((e: unknown) => e)) as ServerError
    expect(error.kind).toBe('refused')
    expect(error.failure?._tag).toBe('SessionNotFound')
    expect(error.message).toContain('SessionNotFound')
  })
  it('an answer of the wrong shape is a protocol error naming the route', async () => {
    const error = (await client()
      .workspaces.load()
      .catch((e: unknown) => e)) as ServerError
    expect(error.kind).toBe('protocol')
    expect(error.message).toContain('/workspaces')
  })
  it('a server that never answers is a timeout at the deadline', async () => {
    const slow = new ClaveServerClient(
      { serverUrl: url, bearer: TOKEN },
      { timeoutMs: 100, build: 'development' }
    )
    const error = (await (
      slow as unknown as {
        query: (
          p: string,
          q: Record<string, string>,
          d: (v: unknown) => unknown
        ) => Promise<unknown>
      }
    )
      .query('/slow', {}, (v) => v)
      .catch((e: unknown) => e)) as ServerError
    expect(error.kind).toBe('timeout')
  })
  it('a closed port is a network error', async () => {
    const gone = new ClaveServerClient(
      { serverUrl: 'http://127.0.0.1:9', bearer: TOKEN },
      { timeoutMs: 2_000, build: 'development' }
    )
    const error = (await gone.sessions.list().catch((e: unknown) => e)) as ServerError
    expect(error.kind).toBe('network')
  })
  it('a page of history runs under the long deadline', async () => {
    const quick = new ClaveServerClient(
      { serverUrl: slowUrl, bearer: TOKEN },
      { timeoutMs: 20, historyTimeoutMs: 2_000, build: 'development' }
    )
    await expect(quick.sessions.history('s1')).resolves.toBeTruthy()
    await expect(quick.sessions.list()).rejects.toMatchObject({ kind: 'timeout' })
  })
})
