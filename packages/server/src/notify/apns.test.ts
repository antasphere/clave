import { afterEach, describe, expect, it } from 'vitest'
import * as http2 from 'node:http2'
import * as net from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import { Effect } from 'effect'
import type { NotificationPayload } from '@clave/contract/notify'
import {
  APNS_HOST,
  APNS_SANDBOX_HOST,
  PROVIDER_TOKEN_TTL_MS,
  apnsBody,
  apnsTransport,
  type ApnsOptions,
  type ApnsTransport
} from './apns'
import { verifyJwt } from './jwt'
import type { PushTarget, SendResult } from './port'

/**
 * The APNs transport (the mobile wave, lane B) against a fake APNs on
 * `node:http2` (h2c, no TLS): it verifies every provider token against the
 * public half of the key, records what each push carried and answers what
 * the test scripted. The headers and the body of a push, the provider
 * token's claims and its life, each answer Apple gives as its outcome, the
 * deadline, the one session and its end, and the device token kept out of
 * every reason and every line of the log.
 */
const KEY_ID = 'ABCDE12345'
const TEAM_ID = 'TEAM123456'
const BUNDLE_ID = 'com.antasphere.clave'
const TOKEN = '7f3a9c'.repeat(10) + 'b2e4'
const T0 = 1_800_000_000_000
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })

const target: PushTarget = { deviceId: 'device-1', platform: 'ios', token: TOKEN }
const question: NotificationPayload = {
  category: 'question',
  serverId: 'server-1',
  serverName: 'studio-mac',
  sessionId: 'session-1',
  sessionTitle: 'Fix the login',
  workspaceName: 'clave',
  requestId: 'request-1',
  text: 'Which branch should I use?',
  actions: ['reply', 'open']
}
const limit: NotificationPayload = {
  category: 'account_limit',
  serverId: 'server-1',
  serverName: 'studio-mac',
  sessionId: '',
  sessionTitle: '',
  text: 'Work: 5-hour window has 4% left',
  actions: ['open']
}

interface Scripted {
  readonly status?: number
  readonly body?: unknown
  /** Never answered: the request waits until the client gives up on it. */
  readonly hang?: boolean
  /** The session is closed (a GOAWAY) once this answer is written. */
  readonly goaway?: boolean
  /** Run as the request arrives, before it is answered. */
  readonly arrived?: () => void
}

interface Seen {
  readonly headers: http2.IncomingHttpHeaders
  readonly body: unknown
  readonly jwt: string
  /** The bearer verified against the public key, with the kid and the iss. */
  readonly verified: boolean
}

interface FakeApns {
  readonly endpoint: string
  readonly seen: Seen[]
  readonly answers: Scripted[]
  readonly sessions: http2.ServerHttp2Session[]
  /** The RST code of every unanswered stream the client closed. */
  readonly cancelled: number[]
  close(): Promise<void>
}

async function fakeApns(): Promise<FakeApns> {
  const seen: Seen[] = []
  const answers: Scripted[] = []
  const sessions: http2.ServerHttp2Session[] = []
  const cancelled: number[] = []
  const server = http2.createServer()
  server.on('session', (session) => sessions.push(session))
  server.on('request', (req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      raw += chunk
    })
    req.on('end', () => {
      const authorization = String(req.headers.authorization ?? '')
      const jwt = authorization.startsWith('bearer ') ? authorization.slice('bearer '.length) : ''
      const decoded = verifyJwt(jwt, publicKey, 'ES256')
      const verified =
        decoded !== null && decoded.header.kid === KEY_ID && decoded.claims.iss === TEAM_ID
      let body: unknown = raw
      try {
        body = JSON.parse(raw)
      } catch {
        // Kept as it came.
      }
      seen.push({ headers: req.headers, body, jwt, verified })
      const answer: Scripted = verified
        ? (answers.shift() ?? { status: 200 })
        : { status: 403, body: { reason: 'InvalidProviderToken' } }
      answer.arrived?.()
      if (answer.hang) {
        req.stream.once('close', () => cancelled.push(req.stream.rstCode))
        return
      }
      // Taken now: a stream that has closed no longer knows its session.
      const session = req.stream.session
      res.writeHead(answer.status ?? 200, {
        'content-type': 'application/json',
        'apns-id': `apns-${seen.length}`
      })
      res.end(answer.body === undefined ? '' : JSON.stringify(answer.body))
      if (answer.goaway) session?.close()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as net.AddressInfo
  return {
    endpoint: `http://127.0.0.1:${port}`,
    seen,
    answers,
    sessions,
    cancelled,
    close: () =>
      new Promise<void>((resolve) => {
        for (const session of sessions) if (!session.destroyed) session.destroy()
        server.close(() => resolve())
      })
  }
}

let fakes: FakeApns[] = []
let transports: ApnsTransport[] = []
afterEach(async () => {
  for (const transport of transports) transport.close()
  transports = []
  await Promise.all(fakes.map((fake) => fake.close()))
  fakes = []
})

const started = async (): Promise<FakeApns> => {
  const fake = await fakeApns()
  fakes.push(fake)
  return fake
}

const open = (options: ApnsOptions): ApnsTransport => {
  const transport = apnsTransport(options)
  transports.push(transport)
  return transport
}

const optionsFor = (fake: FakeApns, more: Partial<ApnsOptions> = {}): ApnsOptions => ({
  keyId: KEY_ID,
  teamId: TEAM_ID,
  bundleId: BUNDLE_ID,
  privateKey,
  endpoint: fake.endpoint,
  ...more
})

const send = (
  transport: ApnsTransport,
  payload: NotificationPayload = question
): Promise<SendResult> => Effect.runPromise(transport.send(target, payload))

/** A port nothing listens on. */
const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const probe = net.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo
      probe.close(() => resolve(port))
    })
  })

const until = async (condition: () => boolean, ms = 2000): Promise<void> => {
  const deadline = Date.now() + ms
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('the condition never held')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('the APNs body', () => {
  it('says the session, the machine under it, the category and the closed payload', () => {
    expect(apnsBody({ ...question, secret: 'never' } as NotificationPayload)).toEqual({
      aps: {
        alert: {
          title: 'Fix the login',
          subtitle: 'studio-mac',
          body: 'Which branch should I use?'
        },
        sound: 'default',
        category: 'clave.question',
        'thread-id': 'session-1'
      },
      clave: question
    })
  })

  it('titles an account notification with the machine, with no subtitle, threaded by server', () => {
    expect(apnsBody(limit)).toEqual({
      aps: {
        alert: { title: 'studio-mac', body: 'Work: 5-hour window has 4% left' },
        sound: 'default',
        category: 'clave.account_limit',
        'thread-id': 'server-1'
      },
      clave: limit
    })
  })
})

describe('the APNs transport', () => {
  it('sends the topic, the push type, the priority and the collapse id, to the token, with the body', async () => {
    const fake = await started()
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string
    const transport = open(optionsFor(fake, { privateKey: pem }))
    expect(await send(transport, question)).toEqual({ outcome: 'sent' })
    expect(await send(transport, limit)).toEqual({ outcome: 'sent' })
    const [first, second] = fake.seen
    expect(first.headers).toMatchObject({
      ':method': 'POST',
      ':path': `/3/device/${TOKEN}`,
      'apns-topic': BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-collapse-id': 'request-1',
      'content-type': 'application/json'
    })
    expect(first.verified).toBe(true)
    expect(first.body).toEqual(apnsBody(question))
    expect(second.headers[':path']).toBe(`/3/device/${TOKEN}`)
    expect(second.headers['apns-collapse-id']).toBeUndefined()
    expect(second.body).toEqual(apnsBody(limit))
  })

  it('signs a provider token that verifies with the kid and the iss, and keeps it fifty minutes', async () => {
    const fake = await started()
    let clock = T0
    const transport = open(optionsFor(fake, { now: () => clock }))
    await send(transport)
    clock = T0 + PROVIDER_TOKEN_TTL_MS - 1
    await send(transport)
    expect(new Set(fake.seen.map((s) => s.jwt)).size).toBe(1)
    const first = verifyJwt(fake.seen[0].jwt, publicKey, 'ES256')
    expect(first?.header).toEqual({ kid: KEY_ID, alg: 'ES256' })
    expect(first?.claims).toEqual({ iss: TEAM_ID, iat: Math.floor(T0 / 1000) })

    clock = T0 + PROVIDER_TOKEN_TTL_MS + 1
    await send(transport)
    const tokens = fake.seen.map((s) => s.jwt)
    expect(new Set(tokens).size).toBe(2)
    expect(verifyJwt(tokens[2], publicKey, 'ES256')?.claims).toEqual({
      iss: TEAM_ID,
      iat: Math.floor(clock / 1000)
    })
    expect(fake.seen.every((s) => s.verified)).toBe(true)
  })

  const answers: ReadonlyArray<{ name: string; answer: Scripted; result: SendResult }> = [
    { name: '200', answer: { status: 200 }, result: { outcome: 'sent' } },
    {
      name: '410 Unregistered',
      answer: { status: 410, body: { reason: 'Unregistered' } },
      result: { outcome: 'gone' }
    },
    {
      name: '400 BadDeviceToken',
      answer: { status: 400, body: { reason: 'BadDeviceToken' } },
      result: { outcome: 'gone' }
    },
    {
      name: '400 BadTopic',
      answer: { status: 400, body: { reason: 'BadTopic' } },
      result: { outcome: 'failed', reason: '400 BadTopic' }
    },
    {
      name: '429 TooManyRequests',
      answer: { status: 429, body: { reason: 'TooManyRequests' } },
      result: { outcome: 'failed', reason: '429 TooManyRequests' }
    },
    {
      name: '403 Forbidden',
      answer: { status: 403, body: { reason: 'Forbidden' } },
      result: { outcome: 'failed', reason: '403 Forbidden' }
    },
    {
      name: '500 with no body',
      answer: { status: 500 },
      result: { outcome: 'failed', reason: '500' }
    }
  ]
  it.each(answers)(
    'answers $name as $result.outcome, in one request',
    async ({ answer, result }) => {
      const fake = await started()
      const transport = open(optionsFor(fake))
      fake.answers.push(answer)
      expect(await send(transport)).toEqual(result)
      expect(fake.seen).toHaveLength(1)
    }
  )

  it('signs a fresh provider token when Apple calls it expired, and retries once', async () => {
    const fake = await started()
    let clock = T0
    const transport = open(optionsFor(fake, { now: () => clock }))
    // A second later: the token in hand is still young, so only the refusal renews it.
    fake.answers.push(
      { status: 403, body: { reason: 'ExpiredProviderToken' }, arrived: () => (clock += 1000) },
      { status: 200 }
    )
    expect(await send(transport)).toEqual({ outcome: 'sent' })
    expect(fake.seen).toHaveLength(2)
    const [stale, fresh] = fake.seen.map((s) => s.jwt)
    expect(fresh).not.toBe(stale)
    expect(fake.seen.every((s) => s.verified)).toBe(true)
    await send(transport)
    expect(fake.seen[2].jwt).toBe(fresh)
  })

  it('retries a refused provider token once, never twice', async () => {
    const fake = await started()
    const transport = open(optionsFor(fake))
    fake.answers.push(
      { status: 403, body: { reason: 'InvalidProviderToken' } },
      { status: 403, body: { reason: 'InvalidProviderToken' } },
      { status: 200 }
    )
    expect(await send(transport)).toEqual({
      outcome: 'failed',
      reason: '403 InvalidProviderToken'
    })
    expect(fake.seen).toHaveLength(2)
  })

  it('fails a request past its deadline as a timeout, cancels its stream and reconnects', async () => {
    const fake = await started()
    const transport = open(optionsFor(fake, { timeoutMs: 200 }))
    fake.answers.push({ hang: true })
    expect(await send(transport)).toEqual({ outcome: 'failed', reason: 'timeout' })
    await until(() => fake.cancelled.length === 1)
    expect(fake.cancelled).toEqual([http2.constants.NGHTTP2_CANCEL])
    expect(await send(transport)).toEqual({ outcome: 'sent' })
    expect(fake.sessions).toHaveLength(2)
  })

  it('fails a refused connection with its code, and says it in the log', async () => {
    const lines: string[] = []
    const transport = open({
      keyId: KEY_ID,
      teamId: TEAM_ID,
      bundleId: BUNDLE_ID,
      privateKey,
      endpoint: `http://127.0.0.1:${await freePort()}`,
      log: (line) => lines.push(line)
    })
    expect(await send(transport)).toEqual({ outcome: 'failed', reason: 'ECONNREFUSED' })
    await until(() => lines.length > 0)
    expect(lines).toEqual(['push: APNs connection error (ECONNREFUSED)'])
  })

  it('carries every push on one session, and close() ends it', async () => {
    const fake = await started()
    const transport = open(optionsFor(fake))
    expect(await send(transport)).toEqual({ outcome: 'sent' })
    expect(await send(transport)).toEqual({ outcome: 'sent' })
    expect(fake.sessions).toHaveLength(1)
    const ended = new Promise<void>((resolve) => fake.sessions[0].once('close', () => resolve()))
    transport.close()
    await ended
    expect(await send(transport)).toEqual({ outcome: 'failed', reason: 'transport closed' })
    expect(fake.sessions).toHaveLength(1)
  })

  it('drops a session Apple closes, and the next push opens another', async () => {
    const fake = await started()
    const lines: string[] = []
    const transport = open(optionsFor(fake, { log: (line) => lines.push(line) }))
    fake.answers.push({ status: 200, goaway: true })
    expect(await send(transport)).toEqual({ outcome: 'sent' })
    await until(() => lines.some((line) => line.includes('GOAWAY')))
    expect(await send(transport)).toEqual({ outcome: 'sent' })
    expect(fake.sessions).toHaveLength(2)
  })

  it('never says the device token in a reason or a line of the log', async () => {
    const fake = await started()
    const lines: string[] = []
    const log = (line: string): void => {
      lines.push(line)
    }
    const transport = open(optionsFor(fake, { timeoutMs: 200, log }))
    fake.answers.push(
      { status: 400, body: { reason: `BadTopic for ${TOKEN}` } },
      { status: 500, body: { reason: TOKEN } },
      { status: 403, body: { reason: 'ExpiredProviderToken' } },
      { status: 403, body: { reason: 'ExpiredProviderToken' } },
      { hang: true }
    )
    const results: SendResult[] = []
    for (let i = 0; i < 4; i++) results.push(await send(transport))
    const refused = open({
      ...optionsFor(fake, { log }),
      endpoint: `http://127.0.0.1:${await freePort()}`
    })
    results.push(await send(refused))
    await until(() => lines.some((line) => line.includes('connection error')))
    const reasons = results.map((r) => (r.outcome === 'failed' ? r.reason : r.outcome))
    expect(reasons).toEqual([
      '400 BadTopic for <redacted>',
      '500 <redacted>',
      '403 ExpiredProviderToken',
      'timeout',
      'ECONNREFUSED'
    ])
    expect(lines.length).toBeGreaterThanOrEqual(2)
    for (const text of [...reasons, ...lines]) expect(text).not.toContain(TOKEN)
  })

  it('connects to Apple, to the sandbox when the flag says so', () => {
    const base = { keyId: KEY_ID, teamId: TEAM_ID, bundleId: BUNDLE_ID, privateKey }
    expect(open(base).origin).toBe(`https://${APNS_HOST}:443`)
    expect(open({ ...base, sandbox: false }).origin).toBe(`https://${APNS_HOST}:443`)
    expect(open({ ...base, sandbox: true }).origin).toBe(`https://${APNS_SANDBOX_HOST}:443`)
  })
})
