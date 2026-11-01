/**
 * The FCM transport (the mobile wave, lane B): an Android phone's road, on
 * the global `fetch` and `node:crypto` alone. Google's HTTP v1 API takes an
 * OAuth access token: the transport signs the service account's assertion
 * (RS256, `jwt.ts`), exchanges it at the account's token URI, keeps the
 * access token until a minute before Google says it expires, lets the sends
 * that wait on one exchange share it, and exchanges again, for one retry,
 * when a send is refused with 401. Google's answer becomes a `SendResult`:
 * 200 sent; an UNREGISTERED error (Google's 404 for a token it no longer
 * knows, named in the error's details), the token gone; anything else a
 * failure carrying the status and Google's error, a bare 404 included: a
 * project path Google does not know must never forget every phone. No reason
 * and no line of the log carries the device token or an access token.
 */
import { Effect } from 'effect'
import type { NotificationPayload } from '@clave/contract/notify'
import { signJwt } from './jwt'
import { PUSH_PAYLOAD_MAX_BYTES, bounded, payloadAsStrings, payloadTitle } from './payload'
import type { PushTarget, PushTransport, SendResult } from './port'

export const FCM_ENDPOINT = 'https://fcm.googleapis.com'
export const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer'
/** How long the assertion says it is good for, the most Google takes. */
const ASSERTION_TTL_S = 3600
/** An access token is let go this long before Google says it expires. */
const EXPIRY_MARGIN_MS = 60_000
const TIMEOUT_MS = 10_000
const REASON_MAX = 120

export interface FcmOptions {
  readonly projectId: string
  readonly clientEmail: string
  /** The service account's private key, PEM. */
  readonly privateKey: string
  readonly tokenUri: string
  /** Test only: the base of the messages:send URL instead of FCM_ENDPOINT. */
  readonly endpoint?: string
  readonly fetch?: typeof fetch
  readonly now?: () => number
  readonly timeoutMs?: number
  readonly log?: (line: string) => void
}

export interface FcmTransport extends PushTransport {
  close(): void
}

const notificationData = (
  payload: NotificationPayload
): { notification: { title: string; body: string }; data: Record<string, string> } => ({
  notification: { title: payloadTitle(payload), body: payload.text },
  data: payloadAsStrings(payload)
})

/** The HTTP v1 message of one push, pure (the tests assert it). */
export function fcmMessage(
  target: PushTarget,
  payload: NotificationPayload
): Record<string, unknown> {
  const collapse = payload.requestId
  const fields = notificationData(payload)
  return {
    message: {
      token: target.token,
      notification: fields.notification,
      android: {
        priority: 'high',
        ...(collapse ? { collapse_key: collapse } : {}),
        notification: { channel_id: 'clave', ...(collapse ? { tag: collapse } : {}) }
      },
      data: fields.data
    }
  }
}

type TokenAnswer =
  | { readonly ok: true; readonly token: string; readonly expiresAt: number }
  | { readonly ok: false; readonly reason: string }

/** What one POST came back with: its status and JSON body, or why there was none. */
type Posted =
  | { readonly answered: true; readonly status: number; readonly body: unknown }
  | { readonly answered: false; readonly reason: string }

export function fcmTransport(options: FcmOptions): FcmTransport {
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  const log = options.log ?? ((): void => {})
  const url = `${options.endpoint ?? FCM_ENDPOINT}/v1/projects/${options.projectId}/messages:send`
  let cached: { readonly token: string; readonly expiresAt: number } | undefined
  let exchanging: Promise<TokenAnswer> | undefined

  const post = async (
    to: string,
    headers: Record<string, string>,
    body: string
  ): Promise<Posted> => {
    const signal = AbortSignal.timeout(timeoutMs)
    try {
      const fetchImpl = options.fetch ?? globalThis.fetch
      const response = await fetchImpl(to, { method: 'POST', headers, body, signal })
      const text = await response.text()
      return { answered: true, status: response.status, body: parseJson(text) }
    } catch (error) {
      return { answered: false, reason: signal.aborted ? 'timeout' : failureOf(error) }
    }
  }

  /** The service account's assertion exchanged for an access token; never rejects. */
  const exchange = async (): Promise<TokenAnswer> => {
    let assertion: string
    try {
      const iat = Math.floor(now() / 1000)
      assertion = signJwt(
        { typ: 'JWT' },
        {
          iss: options.clientEmail,
          scope: FCM_SCOPE,
          aud: options.tokenUri,
          iat,
          exp: iat + ASSERTION_TTL_S
        },
        options.privateKey,
        'RS256'
      )
    } catch (error) {
      return {
        ok: false,
        reason: `token exchange: the assertion is not signed (${failureOf(error)})`
      }
    }
    const answer = await post(
      options.tokenUri,
      { 'content-type': 'application/x-www-form-urlencoded' },
      new URLSearchParams({ grant_type: GRANT_TYPE, assertion }).toString()
    )
    if (!answer.answered) return { ok: false, reason: `token exchange ${answer.reason}` }
    const body = asRecord(answer.body)
    if (answer.status < 200 || answer.status >= 300)
      return { ok: false, reason: `token exchange ${answer.status}${oauthError(body)}` }
    const token = body?.access_token
    if (typeof token !== 'string' || token === '')
      return { ok: false, reason: 'token exchange: no access token in the answer' }
    const expiresIn = Number(body?.expires_in)
    const lifetime = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : ASSERTION_TTL_S
    return { ok: true, token, expiresAt: now() + lifetime * 1000 - EXPIRY_MARGIN_MS }
  }

  /** The access token in hand, or one exchange shared by every send waiting on it. */
  const accessToken = (): Promise<TokenAnswer> => {
    if (cached !== undefined && now() < cached.expiresAt)
      return Promise.resolve({ ok: true, ...cached })
    if (exchanging !== undefined) return exchanging
    const started: Promise<TokenAnswer> = exchange().then((answer) => {
      // An exchange that `close()` let go of is not kept.
      if (exchanging === started) {
        exchanging = undefined
        if (answer.ok) cached = { token: answer.token, expiresAt: answer.expiresAt }
      }
      return answer
    })
    exchanging = started
    return started
  }

  const attempt = async (
    target: PushTarget,
    payload: NotificationPayload,
    secrets: string[],
    retried: boolean
  ): Promise<SendResult> => {
    // JSON punctuation makes this a conservative upper bound on the
    // notification/data keys and values. Routing tokens are not payload.
    if (Buffer.byteLength(JSON.stringify(notificationData(payload))) > PUSH_PAYLOAD_MAX_BYTES)
      return { outcome: 'failed', reason: 'payload exceeds 4096 bytes' }
    const access = await accessToken()
    if (!access.ok) return { outcome: 'failed', reason: access.reason }
    secrets.push(access.token)
    const answer = await post(
      url,
      { authorization: `Bearer ${access.token}`, 'content-type': 'application/json' },
      JSON.stringify(fcmMessage(target, payload))
    )
    if (!answer.answered) return { outcome: 'failed', reason: answer.reason }
    const { status, body } = answer
    if (status === 200) return { outcome: 'sent' }
    // Only Google's own word on the token: a 404 with no FcmError detail is a
    // misconfigured path, and forgetting every phone for it would be wrong.
    if (unregistered(body)) return { outcome: 'gone' }
    if (status === 401) {
      // Google refuses the token: whoever needs one next exchanges again.
      if (cached?.token === access.token) cached = undefined
      if (!retried) {
        log('push: FCM refused the access token (401), exchanging a new one')
        return attempt(target, payload, secrets, true)
      }
    }
    const error = fcmError(body)
    return { outcome: 'failed', reason: error === undefined ? `${status}` : `${status} ${error}` }
  }

  return {
    send(target: PushTarget, payload: NotificationPayload): Effect.Effect<SendResult> {
      return Effect.promise(async (): Promise<SendResult> => {
        const secrets = [target.token]
        let result: SendResult
        try {
          result = await attempt(target, payload, secrets, false)
        } catch (error) {
          result = { outcome: 'failed', reason: failureOf(error) }
        }
        return result.outcome === 'failed'
          ? { outcome: 'failed', reason: said(result.reason, secrets) }
          : result
      })
    },
    close(): void {
      cached = undefined
      exchanging = undefined
    }
  }
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** A token gone: one of the error's details is FCM's UNREGISTERED. */
function unregistered(body: unknown): boolean {
  const details = asRecord(asRecord(body)?.error)?.details
  return Array.isArray(details) && details.some((d) => asRecord(d)?.errorCode === 'UNREGISTERED')
}

/** Google's word for the error: its status, else its message. */
function fcmError(body: unknown): string | undefined {
  const error = asRecord(asRecord(body)?.error)
  if (typeof error?.status === 'string' && error.status !== '') return error.status
  if (typeof error?.message === 'string' && error.message !== '') return error.message
  return undefined
}

/** The token endpoint's error and its description, after a space; empty when it says none. */
function oauthError(body: Record<string, unknown> | undefined): string {
  if (typeof body?.error !== 'string') return ''
  const description = body.error_description
  return typeof description === 'string' && description !== ''
    ? ` ${body.error} (${description})`
    : ` ${body.error}`
}

/** A network error as a reason: its message, with the code of its cause. */
function failureOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const code = (error as { cause?: { code?: unknown } } | null | undefined)?.cause?.code
  return typeof code === 'string' ? `${message} (${code})` : message
}

/** A reason as it may be said: the device token and every access token of
 *  the send taken out, then one short line. */
function said(reason: string, secrets: ReadonlyArray<string>): string {
  let out = reason
  for (const secret of secrets) if (secret !== '') out = out.split(secret).join('<redacted>')
  return bounded(out, REASON_MAX)
}
