/**
 * The phone's road to this server without a relay (`road.ts`, PRDCT-4448):
 * the relay's two shapes answered by the server itself. The unchanged native
 * app types this server's own HTTPS address as its relay, lists the machine
 * at `GET /machines` with its hub access token, pairs and works at
 * `/m/<machine>/<path>`. What is proven here: the list only for the owner
 * signed in on this server and only on the trusted hub, every hub request
 * bounded, and the alias resolved before the push upgrade, the token check
 * and the device scope, for this server's own id and nothing else.
 */
import { createHash, randomBytes } from 'node:crypto'
import { request as httpRequest } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { CLOSE_DEVICE_REVOKED, DEVICE_PAIR_PATH } from '@clave/contract/devices'
import { startOidcProvider } from '../../../../tests/e2e/fixtures/oidc-provider.mjs'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { FakeSource, Peer, aSession } from '../test-support'
import { memoryDeviceStorage, type DevicesPortService } from './port'
import { DEVICE_FORBIDDEN_MESSAGE } from './scope'
import {
  ROAD_HUB_CONCURRENCY,
  ROAD_HUB_PER_MINUTE,
  ROAD_HUB_TIMEOUT_MS,
  ROAD_MACHINE_ID,
  budgetedFetch,
  roadRoute,
  type RoadRoute
} from './road'

const ID = 'm_0123456789abcdef0123456789abcdef'
const OTHER = 'm_fedcba9876543210fedcba9876543210'
const OWNER = 'user-7f3a'

describe('the road a request takes (pure)', () => {
  const alias = (url: string): RoadRoute => ({ kind: 'alias', url })
  const refused: RoadRoute = { kind: 'refused' }
  const pass: RoadRoute = { kind: 'pass' }
  it.each([
    ['/machines', { kind: 'machines' }],
    ['/machines?x=1', { kind: 'machines' }],
    ['/machinesx', pass],
    ['/sessions', pass],
    ['/mx/whatever', pass],
    ['/M/' + ID + '/sessions', pass],
    [`/m/${ID}/sessions`, alias('/sessions')],
    [`/m/${ID}/sessions?id=s1&limit=50`, alias('/sessions?id=s1&limit=50')],
    [`/m/${ID}/push`, alias('/push')],
    [`/m/${ID}/devices/pair?id=p1`, alias('/devices/pair?id=p1')],
    [`/m/${ID}/devices/me/push-token/clear`, alias('/devices/me/push-token/clear')],
    [`/m/${ID}/files/attachments/prepare`, alias('/files/attachments/prepare')],
    ['/m', refused],
    ['/m/', refused],
    [`/m/${ID}`, refused],
    [`/m/${ID}?x=1`, refused],
    [`/m/${ID}/`, refused],
    [`/m/${ID}//sessions`, refused],
    [`/m/${ID}/./sessions`, refused],
    [`/m/${ID}/../sessions`, refused],
    [`/m/${ID}/sessions/../devices`, refused],
    [`/m/${ID}/%2e%2e/devices`, refused],
    [`/m/${ID}/sessions%2f..%2fdevices`, refused],
    [`/m/${ID}/a\\b`, refused],
    [`/m/${ID}/sessions/`, refused],
    [`/m/${OTHER}/sessions`, refused],
    [`/m/${ID.toUpperCase()}/sessions`, refused],
    [`/m/%6d${ID.slice(1)}/sessions`, refused],
    [`/m/${ID}x/sessions`, refused],
    [`/m/${ID.slice(0, -1)}/sessions`, refused]
  ] as const)('%s', (url, expected) => {
    expect(roadRoute(url, () => ID)).toEqual(expected)
  })
  it('refuses every road when the server has no machine id it can trust', () => {
    expect(roadRoute(`/m/${ID}/sessions`, () => null)).toEqual(refused)
    expect(roadRoute('/machines', () => null)).toEqual({ kind: 'machines' })
    expect(roadRoute('/sessions', () => null)).toEqual(pass)
  })
  it('asks for the machine id only for a request on the road', () => {
    let asked = 0
    const id = (): string => {
      asked += 1
      return ID
    }
    for (const url of ['/sessions', '/machines', '/devices/pair', '/mx/a', '/push'])
      roadRoute(url, id)
    expect(asked).toBe(0)
    roadRoute(`/m/${ID}/sessions`, id)
    expect(asked).toBe(1)
  })
})

describe('the hub budget (pure)', () => {
  it('keeps a few requests in flight and so many a minute, and recovers after the minute', async () => {
    let now = 0
    const held: Array<() => void> = []
    const base = (() =>
      new Promise<Response>((resolve) =>
        held.push(() => resolve(new Response('{}')))
      )) as typeof globalThis.fetch
    const limited = budgetedFetch(base, () => now, { concurrency: 2, perMinute: 3 })
    const a = limited('http://hub/a')
    const b = limited('http://hub/b')
    await expect(limited('http://hub/c')).rejects.toThrow('budget')
    held.splice(0).forEach((release) => release())
    await Promise.all([a, b])
    const c = limited('http://hub/c')
    held.splice(0).forEach((release) => release())
    await c
    await expect(limited('http://hub/d')).rejects.toThrow('budget')
    now = 60_001
    const d = limited('http://hub/d')
    held.splice(0).forEach((release) => release())
    await expect(d).resolves.toBeInstanceOf(Response)
  })
})

type Provider = Awaited<ReturnType<typeof startOidcProvider>>
let provider: Provider
let server: EmbeddedServer | null = null

beforeAll(async () => {
  provider = await startOidcProvider()
})
afterAll(async () => {
  await provider.close()
})
afterEach(async () => {
  await server?.stop()
  server = null
})

/** The hub's answer to `userinfo`, by bearer: the people this hub knows. */
interface Hub {
  people: Map<string, string>
  userinfo: number
  down: boolean
  delayMs: number
  /** Send the headers at once and never finish the body. */
  stallBody: boolean
  /** The same, for the discovery document. */
  stallDiscovery: boolean
  openBodies: number
  maxOpenBodies: number
}

async function start(
  options: {
    owner?: () => string | null
    road?: boolean
    machineId?: () => string
  } = {}
): Promise<{ server: EmbeddedServer; hub: Hub; source: FakeSource }> {
  const hub: Hub = {
    people: new Map(),
    userinfo: 0,
    down: false,
    delayMs: 0,
    stallBody: false,
    stallDiscovery: false,
    openBodies: 0,
    maxOpenBodies: 0
  }
  const userinfo = `${provider.issuer}/userinfo`
  // The hub's userinfo is answered here, by bearer; everything else (the
  // discovery document, the keys) is the local provider's own.
  const fetchHub: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (hub.stallDiscovery && url.endsWith('/.well-known/openid-configuration'))
      return new Response(new ReadableStream({ start: () => {} }), {
        headers: { 'content-type': 'application/json' }
      })
    if (url !== userinfo) return globalThis.fetch(input, init)
    hub.userinfo += 1
    if (hub.delayMs) await new Promise((resolve) => setTimeout(resolve, hub.delayMs))
    if (hub.down) throw new Error('connection refused')
    if (hub.stallBody) {
      hub.openBodies += 1
      hub.maxOpenBodies = Math.max(hub.maxOpenBodies, hub.openBodies)
      return new Response(
        new ReadableStream({
          start: () => {},
          cancel: () => {
            hub.openBodies -= 1
          }
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    }
    const header = new Headers(init?.headers).get('authorization') ?? ''
    const sub = hub.people.get(header.replace(/^Bearer /, ''))
    return sub
      ? new Response(JSON.stringify({ sub }), { headers: { 'content-type': 'application/json' } })
      : new Response('{"error":"invalid_token"}', { status: 401 })
  }
  const source = new FakeSource(aSession('s1'))
  const port: DevicesPortService = {
    storage: memoryDeviceStorage(),
    owner: options.owner ?? (() => OWNER),
    issuer: provider.issuer,
    serverName: () => 'the-mac',
    fetch: fetchHub,
    ...(options.road !== false && {
      road: {
        machineId: options.machineId ?? (() => ID),
        platform: 'macos' as const,
        version: '3.0.0-test'
      }
    })
  }
  server = await startEmbedded({ ports: { sessions: source, devices: port } })
  return { server, hub, source }
}

/** One request with the path exactly as written: `fetch` would normalise a `..`. */
function raw(
  url: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string
): Promise<{ status: number; body: string }> {
  const target = new URL(url)
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: target.hostname, port: target.port, method, path, headers },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => (text += chunk))
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text }))
      }
    )
    request.on('error', reject)
    if (body !== undefined) request.write(body)
    request.end()
  })
}

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

describe('GET /machines', () => {
  it('lists this server to its owner, under its own id, and to nobody else', async () => {
    const { server, hub } = await start()
    hub.people.set('owner-token', OWNER).set('stranger-token', 'someone-else')
    const listed = await fetch(`${server.url}/machines`, { headers: bearer('owner-token') })
    expect(listed.status).toBe(200)
    const body = (await listed.json()) as { machines: Array<Record<string, unknown>> }
    expect(body.machines).toEqual([
      {
        id: ID,
        name: 'the-mac',
        platform: 'macos',
        version: '3.0.0-test',
        online: true,
        lastSeen: expect.any(Number),
        direct: []
      }
    ])
    expect(ROAD_MACHINE_ID.test(ID)).toBe(true)
    const stranger = await fetch(`${server.url}/machines`, { headers: bearer('stranger-token') })
    expect(stranger.status).toBe(200)
    expect(await stranger.json()).toEqual({ machines: [] })
  })

  it('refuses a missing or refused bearer, and the hub never hears a missing one', async () => {
    const { server, hub } = await start()
    const none = await fetch(`${server.url}/machines`)
    expect(none.status).toBe(401)
    expect(hub.userinfo).toBe(0)
    const refusedByHub = await fetch(`${server.url}/machines`, { headers: bearer('unknown-token') })
    expect(refusedByHub.status).toBe(401)
    expect(hub.userinfo).toBe(1)
    expect(await refusedByHub.text()).not.toContain('unknown-token')
  })

  it('answers 401 and asks the hub nothing while nobody is signed in on this server', async () => {
    const { server, hub } = await start({ owner: () => null })
    hub.people.set('owner-token', OWNER)
    const answer = await fetch(`${server.url}/machines`, { headers: bearer('owner-token') })
    expect(answer.status).toBe(401)
    expect(hub.userinfo).toBe(0)
  })

  it('lists nothing when the owner signs out or changes while the hub answers', async () => {
    let reads = 0
    const { server, hub } = await start({
      owner: () => (reads++ === 0 ? OWNER : 'another-account')
    })
    hub.people.set('owner-token', OWNER)
    const answer = await fetch(`${server.url}/machines`, { headers: bearer('owner-token') })
    expect(answer.status).toBe(200)
    expect(await answer.json()).toEqual({ machines: [] })
  })

  it('answers 503 when the hub does not answer, and remembers a subject it was told', async () => {
    const { server, hub } = await start()
    hub.people.set('owner-token', OWNER)
    expect((await fetch(`${server.url}/machines`, { headers: bearer('owner-token') })).status).toBe(
      200
    )
    expect((await fetch(`${server.url}/machines`, { headers: bearer('owner-token') })).status).toBe(
      200
    )
    expect(hub.userinfo).toBe(1)
    hub.down = true
    const down = await fetch(`${server.url}/machines`, { headers: bearer('another-token') })
    expect(down.status).toBe(503)
  })

  it('answers within its deadline when the hub sends its headers and stalls its body', async () => {
    const { server, hub } = await start()
    hub.stallBody = true
    const began = Date.now()
    const answer = await fetch(`${server.url}/machines`, {
      headers: bearer('owner-token'),
      signal: AbortSignal.timeout(ROAD_HUB_TIMEOUT_MS + 4_000)
    })
    expect(answer.status).toBe(503)
    expect(Date.now() - began).toBeLessThan(ROAD_HUB_TIMEOUT_MS + 1_500)
  }, 20_000)

  it('answers within its deadline when the hub’s discovery document stalls', async () => {
    const { server, hub } = await start()
    hub.stallDiscovery = true
    hub.people.set('owner-token', OWNER)
    const began = Date.now()
    const answer = await fetch(`${server.url}/machines`, {
      headers: bearer('owner-token'),
      signal: AbortSignal.timeout(ROAD_HUB_TIMEOUT_MS * 2 + 4_000)
    })
    // The discovery falls back to the hub's known userinfo path within one deadline.
    expect([200, 401, 503]).toContain(answer.status)
    expect(Date.now() - began).toBeLessThan(ROAD_HUB_TIMEOUT_MS * 2 + 1_500)
  }, 25_000)

  it('holds no more requests at the hub than its concurrency while their bodies stall', async () => {
    const { server, hub } = await start()
    hub.stallBody = true
    const answers = await Promise.all(
      Array.from({ length: ROAD_HUB_CONCURRENCY + 2 }, (_, i) =>
        fetch(`${server.url}/machines`, {
          headers: bearer(`stalled-${i}`),
          signal: AbortSignal.timeout(ROAD_HUB_TIMEOUT_MS + 4_000)
        }).then((response) => response.status)
      )
    )
    expect(answers.every((status) => status === 503)).toBe(true)
    expect(hub.maxOpenBodies).toBeLessThanOrEqual(ROAD_HUB_CONCURRENCY)
    // Every stalled body the road started reading is let go, none left open.
    expect(hub.openBodies).toBe(0)
  }, 20_000)

  it('asks the hub no more than its budget a minute, whatever the callers send', async () => {
    const { server, hub } = await start()
    const statuses: number[] = []
    for (let i = 0; i < ROAD_HUB_PER_MINUTE + 5; i++) {
      const answer = await fetch(`${server.url}/machines`, { headers: bearer(`junk-${i}`) })
      statuses.push(answer.status)
    }
    // The discovery document is one of the requests the budget counts.
    expect(hub.userinfo).toBeLessThanOrEqual(ROAD_HUB_PER_MINUTE)
    expect(statuses.filter((status) => status === 503).length).toBeGreaterThanOrEqual(5)
  })

  it('does not exist on a server whose devices port names no road', async () => {
    const { server, hub } = await start({ road: false })
    hub.people.set('owner-token', OWNER)
    // Not the road's answer: the token check's, since there is no such route behind it.
    expect((await fetch(`${server.url}/machines`, { headers: bearer('owner-token') })).status).toBe(
      401
    )
    expect((await fetch(`${server.url}/machines`, { headers: bearer(server.token) })).status).toBe(
      404
    )
    expect(hub.userinfo).toBe(0)
    expect((await raw(server.url, 'GET', `/m/${ID}/sessions`, bearer(server.token))).status).toBe(
      404
    )
  })

  it('reads the machine id for no request outside the road, so none is minted by them', async () => {
    let reads = 0
    const { server } = await start({
      machineId: () => {
        reads += 1
        return ID
      }
    })
    expect((await raw(server.url, 'GET', '/sessions', bearer(server.token))).status).toBe(200)
    expect((await raw(server.url, 'GET', '/health/ready')).status).toBe(200)
    expect(reads).toBe(0)
    expect((await raw(server.url, 'GET', `/m/${ID}/sessions`, bearer(server.token))).status).toBe(
      200
    )
    expect(reads).toBeGreaterThan(0)
  })

  it('refuses the road when the machine id cannot be read, rather than inventing one', async () => {
    const { server, hub } = await start({
      machineId: () => {
        throw new Error('unreadable document')
      }
    })
    hub.people.set('owner-token', OWNER)
    expect((await fetch(`${server.url}/machines`, { headers: bearer('owner-token') })).status).toBe(
      503
    )
    expect((await raw(server.url, 'GET', `/m/${ID}/sessions`, bearer(server.token))).status).toBe(
      404
    )
  })
})

describe('the alias /m/<id>/<path>', () => {
  it('reaches exactly what the path reaches without it, the token check included', async () => {
    const { server } = await start()
    const direct = await raw(server.url, 'GET', '/sessions', bearer(server.token))
    const aliased = await raw(server.url, 'GET', `/m/${ID}/sessions`, bearer(server.token))
    expect(aliased.status).toBe(200)
    expect(aliased.body).toBe(direct.body)
    expect((await raw(server.url, 'GET', `/m/${ID}/sessions`)).status).toBe(401)
    expect((await raw(server.url, 'GET', `/m/${ID}/sessions`, bearer('nope'))).status).toBe(401)
  })

  it.each([
    [`/m/${OTHER}/sessions`, `/m/${OTHER}/sessions/write`],
    [`/m/${ID.toUpperCase()}/sessions`, `/m/${ID.toUpperCase()}/sessions/write`],
    [`/m/%6d${ID.slice(1)}/sessions`, `/m/%6d${ID.slice(1)}/sessions/write`],
    [`/m/${ID}/../sessions`, `/m/${ID}/../sessions/write`],
    [`/m/${ID}/%2e%2e/sessions`, `/m/${ID}/%2e%2e/sessions/write`],
    [`/m/${ID}//sessions`, `/m/${ID}//sessions/write`],
    [`/m/${ID}/sessions%2f..`, `/m/${ID}/sessions%2fwrite`],
    [`/m/${ID}/a\\b`, `/m/${ID}/sessions\\write`],
    [`/m/${ID}`, `/m/${ID}/sessions/write/`]
  ])('answers 404 and reaches nothing for %s, even with the server token', async (read, write) => {
    const { server, source } = await start()
    const answer = await raw(server.url, 'GET', read, bearer(server.token))
    expect(answer.status).toBe(404)
    expect(JSON.parse(answer.body)).toMatchObject({ error: 'NotFound' })
    const written = await raw(
      server.url,
      'POST',
      write,
      { ...bearer(server.token), 'content-type': 'application/json' },
      JSON.stringify({ id: 's1', input: { type: 'interrupt' } })
    )
    expect(written.status, write).toBe(404)
    expect(source.writes).toEqual([])
  })

  it('pairs a phone, scopes its session and closes its socket on revocation, all through the alias', async () => {
    const { server } = await start()
    const minted = await mintIdToken(provider)
    const asked = await raw(
      server.url,
      'POST',
      `/m/${ID}${DEVICE_PAIR_PATH}`,
      { 'content-type': 'application/json' },
      JSON.stringify({
        ...minted,
        device: { name: 'Pixel 9', platform: 'android', appVersion: '1.0.0' }
      })
    )
    expect(asked.status, asked.body).toBe(200)
    const { pairingId } = JSON.parse(asked.body) as { pairingId: string }
    const pending = await raw(server.url, 'GET', `/m/${ID}${DEVICE_PAIR_PATH}?id=${pairingId}`)
    expect(JSON.parse(pending.body)).toEqual({ status: 'pending' })
    // The owner approves with the server's own token, never through the phone's road.
    const approved = await raw(
      server.url,
      'POST',
      '/devices/approve',
      { ...bearer(server.token), 'content-type': 'application/json' },
      JSON.stringify({ pairingId })
    )
    expect(approved.status, approved.body).toBe(200)
    const read = await raw(server.url, 'GET', `/m/${ID}${DEVICE_PAIR_PATH}?id=${pairingId}`)
    const { deviceSession } = JSON.parse(read.body) as {
      deviceSession: { token: string; deviceId: string }
    }
    expect(deviceSession.token).toBeTruthy()
    // Handed out once: the next read carries no session.
    const again = await raw(server.url, 'GET', `/m/${ID}${DEVICE_PAIR_PATH}?id=${pairingId}`)
    expect(JSON.parse(again.body)).toEqual({ status: 'approved' })
    const phone = bearer(deviceSession.token)
    expect((await raw(server.url, 'GET', `/m/${ID}/sessions`, phone)).status).toBe(200)
    // A paired phone's control it did not identify is acknowledged too: the phone reads an
    // answer to every write (the owner's desktop keeps the old empty one).
    const interrupt = await raw(
      server.url,
      'POST',
      `/m/${ID}/sessions/write`,
      { ...phone, 'content-type': 'application/json' },
      JSON.stringify({ id: 's1', input: { type: 'interrupt' } })
    )
    expect(interrupt.status).toBe(200)
    expect(JSON.parse(interrupt.body)).toMatchObject({ status: 'accepted' })
    const forbidden = await raw(server.url, 'GET', `/m/${ID}/devices`, phone)
    expect(forbidden.status).toBe(403)
    expect(JSON.parse(forbidden.body)).toMatchObject({ message: DEVICE_FORBIDDEN_MESSAGE })
    const socket = new Peer(`${server.url.replace('http:', 'ws:')}/m/${ID}/push`)
    await socket.opened
    socket.send({ _tag: 'hello', token: deviceSession.token })
    expect((await socket.next())._tag).toBe('welcome')
    const revoked = await raw(
      server.url,
      'POST',
      '/devices/revoke',
      { ...bearer(server.token), 'content-type': 'application/json' },
      JSON.stringify({ deviceId: deviceSession.deviceId })
    )
    expect(revoked.status, revoked.body).toBe(204)
    expect((await socket.closed).code).toBe(CLOSE_DEVICE_REVOKED)
    expect((await raw(server.url, 'GET', `/m/${ID}/sessions`, phone)).status).toBe(401)
  })

  it('opens no socket on another machine id', async () => {
    const { server } = await start()
    const socket = new Peer(`${server.url.replace('http:', 'ws:')}/m/${OTHER}/push`)
    await expect(socket.opened).rejects.toBeDefined()
  })
})

/** An ID token from the local provider for a client registered on the spot (the phone's dynamic client). */
async function mintIdToken(p: Provider): Promise<{ idToken: string; clientId: string }> {
  const redirect = 'clave-android://oauth/callback'
  const registration = await fetch(`${p.issuer}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      client_name: 'Clave on Android'
    })
  })
  const { client_id: clientId } = (await registration.json()) as { client_id: string }
  const verifier = randomBytes(32).toString('base64url')
  const authorize = new URL(`${p.issuer}/authorize`)
  authorize.searchParams.set('client_id', clientId)
  authorize.searchParams.set('redirect_uri', redirect)
  authorize.searchParams.set('response_type', 'code')
  authorize.searchParams.set('scope', 'openid profile email')
  authorize.searchParams.set('state', 's')
  authorize.searchParams.set('nonce', 'n')
  authorize.searchParams.set(
    'code_challenge',
    createHash('sha256').update(verifier).digest('base64url')
  )
  authorize.searchParams.set('code_challenge_method', 'S256')
  const sent = await fetch(authorize, { redirect: 'manual' })
  const code = new URL(sent.headers.get('location')!).searchParams.get('code')!
  const exchanged = await fetch(`${p.issuer}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: verifier
    })
  })
  return { idToken: ((await exchanged.json()) as { id_token: string }).id_token, clientId }
}
