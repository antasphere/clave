/**
 * The APNs transport (the mobile wave, lane B): an iPhone's road, on
 * `node:http2` and `node:crypto` alone. One HTTP/2 session to Apple, opened
 * by the first push and kept for the ones after it; a session Apple closes,
 * that errs, or that lets a push run past its deadline is dropped, and the
 * next push opens another. The provider token is signed with the team's .p8
 * key (ES256, `jwt.ts`), kept fifty minutes of the hour Apple accepts it, and
 * signed again at once, for one retry, when Apple calls it expired or
 * invalid. Apple's answer becomes a `SendResult`: 200 sent; 410, or 400
 * BadDeviceToken, the token gone; anything else a failure carrying the status
 * and Apple's reason. No reason and no line of the log carries the device
 * token, and once closed the transport holds nothing that keeps the process
 * alive.
 */
import * as http2 from 'node:http2'
import type { KeyObject } from 'node:crypto'
import { Effect } from 'effect'
import type { NotificationPayload } from '@clave/contract/notify'
import { signJwt } from './jwt'
import { bounded, closedPayload, payloadTitle } from './payload'
import type { PushTarget, PushTransport, SendResult } from './port'

export const APNS_HOST = 'api.push.apple.com'
export const APNS_SANDBOX_HOST = 'api.sandbox.push.apple.com'
/** Apple accepts a provider token for an hour; a new one is signed after this. */
export const PROVIDER_TOKEN_TTL_MS = 50 * 60_000
const TIMEOUT_MS = 10_000
/** What a 403 says of a provider token Apple no longer takes: sign another. */
const STALE_TOKEN_REASONS: ReadonlySet<string> = new Set([
  'ExpiredProviderToken',
  'InvalidProviderToken'
])
/** Apple's error bodies are a few bytes; past this nothing more is read. */
const BODY_MAX = 8 * 1024
const REASON_MAX = 120

export interface ApnsOptions {
  readonly keyId: string
  readonly teamId: string
  readonly bundleId: string
  /** The team's .p8 key: a PKCS#8 PEM string or a KeyObject (EC P-256). */
  readonly privateKey: string | KeyObject
  readonly sandbox?: boolean
  /** Test only: the origin to connect to instead of Apple's (an h2c fake, `http://127.0.0.1:<port>`). */
  readonly endpoint?: string
  readonly now?: () => number
  /** One request's deadline, 10 s by default. */
  readonly timeoutMs?: number
  readonly log?: (line: string) => void
}

export interface ApnsTransport extends PushTransport {
  /** Where the session connects: Apple's production or sandbox host, or the test's fake. */
  readonly origin: string
  close(): void
}

/** The JSON body of one push, pure (the tests assert it). */
export function apnsBody(payload: NotificationPayload): Record<string, unknown> {
  return {
    aps: {
      alert: {
        title: payloadTitle(payload),
        // Under a session's title, the machine it runs on; a notification
        // about an account or a test already has the machine as its title.
        ...(payload.sessionTitle !== '' && { subtitle: payload.serverName }),
        body: payload.text
      },
      sound: 'default',
      category: `clave.${payload.category}`,
      'thread-id': payload.sessionId || payload.serverId
    },
    clave: closedPayload(payload)
  }
}

/** What one request came back with: Apple's status and reason, or why there was none. */
type Exchange =
  | { readonly answered: true; readonly status: number; readonly reason: string | undefined }
  | { readonly answered: false; readonly reason: string }

export function apnsTransport(options: ApnsOptions): ApnsTransport {
  const origin =
    options.endpoint ?? `https://${options.sandbox === true ? APNS_SANDBOX_HOST : APNS_HOST}:443`
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  const log = options.log ?? ((): void => {})
  let session: http2.ClientHttp2Session | undefined
  let token: { readonly jwt: string; readonly signedAt: number } | undefined
  let closed = false

  /** The provider token in hand, or a new one when it is stale or `fresh` is asked. */
  const providerToken = (fresh: boolean): string => {
    const at = now()
    const age = token === undefined ? -1 : at - token.signedAt
    if (!fresh && token !== undefined && age >= 0 && age < PROVIDER_TOKEN_TTL_MS) return token.jwt
    const jwt = signJwt(
      { kid: options.keyId },
      { iss: options.teamId, iat: Math.floor(at / 1000) },
      options.privateKey,
      'ES256'
    )
    token = { jwt, signedAt: at }
    return jwt
  }

  /** A session no new push is given: its streams finish on their own, and it
   *  no longer holds the process. */
  const retire = (retired: http2.ClientHttp2Session): void => {
    if (session === retired) session = undefined
    if (!retired.closed && !retired.destroyed) retired.close()
    if (!retired.destroyed) retired.unref()
  }

  const connection = (): http2.ClientHttp2Session => {
    if (session !== undefined && !session.closed && !session.destroyed) return session
    const opened = http2.connect(origin)
    const drop = (): void => {
      if (session === opened) session = undefined
    }
    opened.on('error', (error) => {
      drop()
      log(`push: APNs connection error (${failureOf(error)})`)
    })
    opened.on('goaway', (code: number) => {
      drop()
      log(`push: APNs closed the connection (GOAWAY ${code}), the next push reconnects`)
    })
    opened.on('close', drop)
    session = opened
    return opened
  }

  const request = (
    target: PushTarget,
    payload: NotificationPayload,
    jwt: string
  ): Promise<Exchange> =>
    new Promise<Exchange>((resolve) => {
      let current: http2.ClientHttp2Session
      let stream: http2.ClientHttp2Stream
      try {
        current = connection()
        stream = current.request({
          ':method': 'POST',
          ':path': `/3/device/${encodeURIComponent(target.token)}`,
          authorization: `bearer ${jwt}`,
          'apns-topic': options.bundleId,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          ...(payload.requestId ? { 'apns-collapse-id': payload.requestId } : {}),
          'content-type': 'application/json'
        })
      } catch (error) {
        resolve({ answered: false, reason: failureOf(error) })
        return
      }
      let settled = false
      const settle = (exchange: Exchange): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(exchange)
      }
      const timer = setTimeout(() => {
        settle({ answered: false, reason: 'timeout' })
        stream.close(http2.constants.NGHTTP2_CANCEL)
        // A connection that answers nothing is likely dead (a Mac that
        // slept): the next push opens another.
        retire(current)
      }, timeoutMs)
      // The current session holds the process while a push is in flight; a
      // closed transport's deadline must not.
      timer.unref()
      let status = 0
      let body = ''
      stream.setEncoding('utf8')
      stream.on('response', (headers) => {
        status = Number(headers[':status'])
      })
      stream.on('data', (chunk: string | Buffer) => {
        if (body.length < BODY_MAX)
          body += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      })
      stream.on('end', () => settle({ answered: true, status, reason: reasonOf(body) }))
      stream.on('error', (error) => settle({ answered: false, reason: failureOf(error) }))
      stream.on('close', () =>
        settle({
          answered: false,
          reason: closed ? 'transport closed' : `stream closed (code ${stream.rstCode})`
        })
      )
      stream.end(JSON.stringify(apnsBody(payload)))
    })

  const attempt = async (
    target: PushTarget,
    payload: NotificationPayload,
    fresh: boolean
  ): Promise<SendResult> => {
    const exchange = await request(target, payload, providerToken(fresh))
    if (!exchange.answered) return { outcome: 'failed', reason: exchange.reason }
    const { status, reason } = exchange
    if (status === 200) return { outcome: 'sent' }
    if (status === 410 || (status === 400 && reason === 'BadDeviceToken'))
      return { outcome: 'gone' }
    if (status === 403 && !fresh && reason !== undefined && STALE_TOKEN_REASONS.has(reason)) {
      log(`push: APNs refused the provider token (${reason}), signing a new one`)
      return attempt(target, payload, true)
    }
    return { outcome: 'failed', reason: reason === undefined ? `${status}` : `${status} ${reason}` }
  }

  return {
    origin,
    send(target: PushTarget, payload: NotificationPayload): Effect.Effect<SendResult> {
      return Effect.promise(async (): Promise<SendResult> => {
        if (closed) return { outcome: 'failed', reason: 'transport closed' }
        let result: SendResult
        try {
          result = await attempt(target, payload, false)
        } catch (error) {
          // A key that does not sign, a header Node refuses: a failure, never a defect.
          result = { outcome: 'failed', reason: failureOf(error) }
        }
        return result.outcome === 'failed'
          ? { outcome: 'failed', reason: said(result.reason, target.token) }
          : result
      })
    },
    close(): void {
      closed = true
      if (session !== undefined) retire(session)
    }
  }
}

/** Apple's reason, from the JSON body when it has one. */
function reasonOf(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body)
    const reason = (parsed as { reason?: unknown } | null)?.reason
    return typeof reason === 'string' && reason !== '' ? reason : undefined
  } catch {
    return undefined
  }
}

/** An error as a reason: its code (a stream cancelled by its connection's
 *  error says the connection's code), else its message. */
function failureOf(error: unknown): string {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null | undefined
  if (typeof e?.cause?.code === 'string') return e.cause.code
  const message = error instanceof Error ? error.message : String(error)
  if (typeof e?.code !== 'string') return message
  const nghttp2 = /NGHTTP2_\w+/.exec(message)?.[0]
  return nghttp2 === undefined ? e.code : `${e.code} ${nghttp2}`
}

/** A reason as it may be said: the device token taken out, then one short line. */
function said(reason: string, deviceToken: string): string {
  const out = deviceToken === '' ? reason : reason.split(deviceToken).join('<redacted>')
  return bounded(out, REASON_MAX)
}
