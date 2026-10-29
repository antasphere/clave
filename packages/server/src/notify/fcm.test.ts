import { afterEach, describe, expect, it } from 'vitest'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import { Effect } from 'effect'
import type { NotificationPayload } from '@clave/contract/notify'
import { FCM_SCOPE, fcmMessage, fcmTransport, type FcmOptions, type FcmTransport } from './fcm'
import { verifyJwt } from './jwt'
import type { PushTarget, SendResult } from './port'

/**
 * The FCM transport (the mobile wave, lane B) against a fake Google on
 * `node:http`: a token route that verifies the service account's assertion
 * against the public half of its key and hands out numbered access tokens,
 * and a messages:send route that checks the bearer, records the message and
 * answers what the test scripted. The message of a push, the assertion's
 * claims, the access token's life, each answer Google gives as its outcome,
 * the deadline, and the device token and the access tokens kept out of every
 * reason and every line of the log.
 */
const PROJECT = 'clave-mobile'
const EMAIL = 'push@clave-mobile.iam.gserviceaccount.com'
const GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
const TOKEN = 'dQw4w9WgXcQ:APA91bH' + 'k3Lm9Qx7'.repeat(16)
const T0 = 1_800_000_000_000
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const PEM = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string

const target: PushTarget = { deviceId: 'device-2', platform: 'android', token: TOKEN }
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
const UNREGISTERED = {
  error: {
    status: 'NOT_FOUND',
    details: [
      { '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }
    ]
  }
}

interface Scripted {
  readonly status?: number
  readonly body?: unknown
  /** Never answered: the request waits until the client gives up on it. */
  readonly hang?: boolean
}

interface Exchange {
  readonly contentType: string | undefined
  readonly header: Record<string, unknown>
  readonly claims: Record<string, unknown>
}

interface Seen {
  readonly path: string | undefined
  readonly bearer: string | undefined
  readonly contentType: string | undefined
  readonly body: unknown
}

interface FakeFcm {
  readonly base: string
  readonly tokenUri: string
  /** Every assertion that verified with the right claims: one access token each. */
  readonly exchanges: Exchange[]
  /** The bodies of the token requests that did not verify. */
  readonly refused: string[]
  readonly seen: Seen[]
  readonly answers: Scripted[]
  /** What the token route answers instead of a token, while it holds any. */
  readonly tokenAnswers: Scripted[]
  close(): Promise<void>
}

async function fakeFcm(): Promise<FakeFcm> {
  const exchanges: Exchange[] = []
  const refused: string[] = []
  const seen: Seen[] = []
  const answers: Scripted[] = []
  const tokenAnswers: Scripted[] = []
  const issued = new Set<string>()
  let tokenUri = ''
  const server = http.createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      raw += chunk
    })
    req.on('end', () => {
      const reply = (status: number, body?: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(body === undefined ? '' : JSON.stringify(body))
      }
      if (req.method === 'POST' && req.url === '/token') {
        const form = new URLSearchParams(raw)
        const jwt = verifyJwt(form.get('assertion') ?? '', publicKey, 'RS256')
        if (
          jwt === null ||
          form.get('grant_type') !== GRANT ||
          jwt.claims.iss !== EMAIL ||
          jwt.claims.aud !== tokenUri ||
          jwt.claims.scope !== FCM_SCOPE
        ) {
          refused.push(raw)
          reply(400, { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' })
          return
        }
        const scripted = tokenAnswers.shift()
        if (scripted !== undefined) {
          reply(scripted.status ?? 200, scripted.body)
          return
        }
        exchanges.push({
          contentType: req.headers['content-type'],
          header: jwt.header,
          claims: jwt.claims
        })
        const accessToken = `access-${exchanges.length}`
        issued.add(accessToken)
        reply(200, { access_token: accessToken, expires_in: 3600, token_type: 'Bearer' })
        return
      }
      if (req.method === 'POST' && req.url === `/v1/projects/${PROJECT}/messages:send`) {
        const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
        let body: unknown = raw
        try {
          body = JSON.parse(raw)
        } catch {
          // Kept as it came.
        }
        seen.push({ path: req.url, bearer, contentType: req.headers['content-type'], body })
        if (bearer === undefined || !issued.has(bearer)) {
          reply(401, { error: { status: 'UNAUTHENTICATED' } })
          return
        }
        const answer = answers.shift() ?? {
          status: 200,
          body: { name: `projects/${PROJECT}/messages/${seen.length}` }
        }
        if (answer.hang) return
        reply(answer.status ?? 200, answer.body)
        return
      }
      reply(400, { error: { status: 'NO_SUCH_ROUTE', message: `${req.method} ${req.url}` } })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  const base = `http://127.0.0.1:${port}`
  tokenUri = `${base}/token`
  return {
    base,
    tokenUri,
    exchanges,
    refused,
    seen,
    answers,
    tokenAnswers,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
  }
}

let fakes: FakeFcm[] = []
let transports: FcmTransport[] = []
afterEach(async () => {
  for (const transport of transports) transport.close()
  transports = []
  await Promise.all(fakes.map((fake) => fake.close()))
  fakes = []
})

const started = async (): Promise<FakeFcm> => {
  const fake = await fakeFcm()
  fakes.push(fake)
  return fake
}

const open = (fake: FakeFcm, more: Partial<FcmOptions> = {}): FcmTransport => {
  const transport = fcmTransport({
    projectId: PROJECT,
    clientEmail: EMAIL,
    privateKey: PEM,
    tokenUri: fake.tokenUri,
    endpoint: fake.base,
    ...more
  })
  transports.push(transport)
  return transport
}

const send = (
  transport: FcmTransport,
  payload: NotificationPayload = question
): Promise<SendResult> => Effect.runPromise(transport.send(target, payload))

describe('the FCM message', () => {
  it('says the session and the text, collapses on the request, and carries the closed payload as strings', () => {
    expect(fcmMessage(target, { ...question, secret: 'never' } as NotificationPayload)).toEqual({
      message: {
        token: TOKEN,
        notification: { title: 'Fix the login', body: 'Which branch should I use?' },
        android: {
          priority: 'high',
          collapse_key: 'request-1',
          notification: { channel_id: 'clave', tag: 'request-1' }
        },
        data: {
          category: 'question',
          serverId: 'server-1',
          serverName: 'studio-mac',
          sessionId: 'session-1',
          sessionTitle: 'Fix the login',
          workspaceName: 'clave',
          requestId: 'request-1',
          text: 'Which branch should I use?',
          actions: 'reply,open'
        }
      }
    })
  })

  it('titles an account notification with the machine, with no collapse key and no tag', () => {
    expect(fcmMessage(target, limit)).toEqual({
      message: {
        token: TOKEN,
        notification: { title: 'studio-mac', body: 'Work: 5-hour window has 4% left' },
        android: { priority: 'high', notification: { channel_id: 'clave' } },
        data: {
          category: 'account_limit',
          serverId: 'server-1',
          serverName: 'studio-mac',
          sessionId: '',
          sessionTitle: '',
          text: 'Work: 5-hour window has 4% left',
          actions: 'open'
        }
      }
    })
  })
})

describe('the FCM transport', () => {
  it('posts the message to the project with the bearer, collapsing on the request id when there is one', async () => {
    const fake = await started()
    const transport = open(fake)
    expect(await send(transport, question)).toEqual({ outcome: 'sent' })
    expect(await send(transport, limit)).toEqual({ outcome: 'sent' })
    const [first, second] = fake.seen
    expect(first.path).toBe(`/v1/projects/${PROJECT}/messages:send`)
    expect(first.bearer).toBe('access-1')
    expect(first.contentType).toBe('application/json')
    expect(first.body).toEqual(fcmMessage(target, question))
    expect(first.body).toMatchObject({
      message: {
        android: {
          collapse_key: 'request-1',
          notification: { channel_id: 'clave', tag: 'request-1' }
        }
      }
    })
    expect(second.body).toEqual(fcmMessage(target, limit))
    expect((second.body as { message: { android: unknown } }).message.android).toEqual({
      priority: 'high',
      notification: { channel_id: 'clave' }
    })
  })

  it('exchanges an assertion signed with the service account key, with its claims', async () => {
    const fake = await started()
    const transport = open(fake, { now: () => T0 })
    expect(await send(transport)).toEqual({ outcome: 'sent' })
    expect(fake.refused).toEqual([])
    expect(fake.exchanges).toHaveLength(1)
    const [exchange] = fake.exchanges
    expect(exchange.contentType).toBe('application/x-www-form-urlencoded')
    expect(exchange.header).toEqual({ typ: 'JWT', alg: 'RS256' })
    const iat = Math.floor(T0 / 1000)
    expect(exchange.claims).toEqual({
      iss: EMAIL,
      scope: FCM_SCOPE,
      aud: fake.tokenUri,
      iat,
      exp: iat + 3600
    })
  })

  it('reuses the access token until a minute before it expires, then exchanges again', async () => {
    const fake = await started()
    let clock = T0
    const transport = open(fake, { now: () => clock })
    const expiresAt = T0 + 3600 * 1000 - 60_000
    await send(transport)
    clock = expiresAt - 1
    await send(transport)
    expect(fake.exchanges).toHaveLength(1)
    clock = expiresAt + 1
    await send(transport)
    expect(fake.exchanges).toHaveLength(2)
    expect(fake.seen.map((s) => s.bearer)).toEqual(['access-1', 'access-1', 'access-2'])
  })

  it('shares one exchange between the sends that wait on it', async () => {
    const fake = await started()
    const transport = open(fake)
    expect(await Promise.all([send(transport), send(transport), send(transport)])).toEqual([
      { outcome: 'sent' },
      { outcome: 'sent' },
      { outcome: 'sent' }
    ])
    expect(fake.exchanges).toHaveLength(1)
  })

  const answers: ReadonlyArray<{ name: string; answer: Scripted; result: SendResult }> = [
    { name: '200', answer: { status: 200, body: { name: 'm/1' } }, result: { outcome: 'sent' } },
    {
      name: '404 UNREGISTERED',
      answer: { status: 404, body: UNREGISTERED },
      result: { outcome: 'gone' }
    },
    // A bare 404 (a project path Google does not know) is a failure, never a
    // token gone: it would forget every phone.
    {
      name: '404 with no body',
      answer: { status: 404 },
      result: { outcome: 'failed', reason: '404' }
    },
    {
      name: '400 with an UNREGISTERED detail',
      answer: {
        status: 400,
        body: { error: { ...UNREGISTERED.error, status: 'INVALID_ARGUMENT' } }
      },
      result: { outcome: 'gone' }
    },
    {
      name: '400 INVALID_ARGUMENT',
      answer: { status: 400, body: { error: { status: 'INVALID_ARGUMENT', message: 'bad' } } },
      result: { outcome: 'failed', reason: '400 INVALID_ARGUMENT' }
    },
    {
      name: '500 with a message only',
      answer: { status: 500, body: { error: { message: 'boom' } } },
      result: { outcome: 'failed', reason: '500 boom' }
    },
    {
      name: '503 with no body',
      answer: { status: 503 },
      result: { outcome: 'failed', reason: '503' }
    }
  ]
  it.each(answers)(
    'answers $name as $result.outcome, in one request',
    async ({ answer, result }) => {
      const fake = await started()
      const transport = open(fake)
      fake.answers.push(answer)
      expect(await send(transport)).toEqual(result)
      expect(fake.seen).toHaveLength(1)
      expect(fake.exchanges).toHaveLength(1)
    }
  )

  it('exchanges again when Google refuses the access token, and retries once', async () => {
    const fake = await started()
    const transport = open(fake)
    fake.answers.push({ status: 401, body: { error: { status: 'UNAUTHENTICATED' } } })
    expect(await send(transport)).toEqual({ outcome: 'sent' })
    expect(fake.exchanges).toHaveLength(2)
    expect(fake.seen.map((s) => s.bearer)).toEqual(['access-1', 'access-2'])
  })

  it('retries a refused access token once, never twice', async () => {
    const fake = await started()
    const transport = open(fake)
    fake.answers.push(
      { status: 401, body: { error: { status: 'UNAUTHENTICATED' } } },
      { status: 401, body: { error: { status: 'UNAUTHENTICATED' } } },
      { status: 200 }
    )
    expect(await send(transport)).toEqual({ outcome: 'failed', reason: '401 UNAUTHENTICATED' })
    expect(fake.seen).toHaveLength(2)
    expect(fake.exchanges).toHaveLength(2)
  })

  it('fails the send with the exchange reason when Google refuses the assertion, and keeps nothing', async () => {
    const fake = await started()
    const transport = open(fake)
    fake.tokenAnswers.push({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Token must be a short-lived token' }
    })
    expect(await send(transport)).toEqual({
      outcome: 'failed',
      reason: 'token exchange 400 invalid_grant (Token must be a short-lived token)'
    })
    expect(fake.seen).toHaveLength(0)
    expect(await send(transport)).toEqual({ outcome: 'sent' })
    expect(fake.exchanges).toHaveLength(1)
  })

  it('fails a request past its deadline as a timeout', async () => {
    const fake = await started()
    const transport = open(fake, { timeoutMs: 200 })
    fake.answers.push({ hang: true })
    expect(await send(transport)).toEqual({ outcome: 'failed', reason: 'timeout' })
    expect(fake.seen).toHaveLength(1)
  })

  it('forgets the access token on close', async () => {
    const fake = await started()
    const transport = open(fake)
    await send(transport)
    transport.close()
    await send(transport)
    expect(fake.exchanges).toHaveLength(2)
    expect(fake.seen.map((s) => s.bearer)).toEqual(['access-1', 'access-2'])
  })

  it('never says the device token or an access token in a reason or a line of the log', async () => {
    const fake = await started()
    const lines: string[] = []
    const transport = open(fake, { timeoutMs: 200, log: (line) => lines.push(line) })
    fake.answers.push(
      { status: 401, body: { error: { status: 'UNAUTHENTICATED' } } },
      { status: 400, body: { error: { message: `bad ${TOKEN} with access-1 and access-2` } } },
      { status: 500, body: { error: { message: `still ${TOKEN} on access-2` } } },
      { hang: true }
    )
    const results: SendResult[] = []
    for (let i = 0; i < 3; i++) results.push(await send(transport))
    const reasons = results.map((r) => (r.outcome === 'failed' ? r.reason : r.outcome))
    expect(reasons).toEqual([
      '400 bad <redacted> with <redacted> and <redacted>',
      '500 still <redacted> on <redacted>',
      'timeout'
    ])
    expect(lines).toEqual(['push: FCM refused the access token (401), exchanging a new one'])
    for (const text of [...reasons, ...lines]) {
      expect(text).not.toContain(TOKEN)
      expect(text).not.toMatch(/access-\d/)
    }
  })
})
