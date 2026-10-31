/**
 * The enrollment client: lane A's device routes on a Clave server, exactly
 * as its brief and its contract (`packages/contract/src/devices.ts`) define
 * them. `POST /devices/pair` takes no bearer, the proof is in the body (the
 * ID token of the hub for the phone's own client id, and how the phone
 * names itself); `GET /devices/pair?id=` says where the pairing stands and
 * carries the device session exactly once on `approved`; the device's own
 * routes (`/devices/me`, the push token) take the device session as the
 * bearer. The base URL is the machine's road (`<relay>/m/<id>` or a direct
 * https address): lane C's transport policy decides whether a credential
 * may travel there at all, in this build.
 *
 * Over the platform's `fetch` (lane C's `FetchLike`), with lane C's two
 * deadlines and its reading of a 401, a 422 and the network's failures.
 */
import type { FetchLike } from '../api/client'
import { assertCredentialMayTravelTo, type BuildKind } from '../machines/transport-policy'

export type DevicePlatform = 'ios' | 'android'

/** How the phone names itself when it asks to pair. */
export interface DeviceDescription {
  readonly name: string
  readonly platform: DevicePlatform
  readonly appVersion: string
}

export interface PairingTicket {
  readonly pairingId: string
  /** Epoch milliseconds, the server's clock: ten minutes after the request. */
  readonly expiresAt: number
}

export type PairingStatus = 'pending' | 'approved' | 'refused' | 'expired'

/** The credential the server issues the phone, shown once. */
export interface DeviceSession {
  readonly token: string
  readonly deviceId: string
  readonly serverId: string
  readonly serverName: string
}

export interface PairingRead {
  readonly status: PairingStatus
  readonly deviceSession?: DeviceSession
}

/** The phone's own record on the server: never its tokens. */
export interface DeviceView {
  readonly id: string
  readonly name: string
  readonly platform: DevicePlatform
  readonly appVersion: string
  readonly createdAt: number
  readonly lastSeenAt: number | null
}

export type EnrollmentFailure =
  /** The request never completed, or the deadline passed. */
  | 'network'
  | 'timeout'
  /** The server refused the ID token by one of its checks (`check` names it). */
  | 'refused'
  /** The server has no Antasphere login: nobody owns it, so it admits no phone. */
  | 'no-owner'
  /** The device session is not this server's any more. */
  | 'unauthenticated'
  /** The phone's record is gone: the owner revoked it. */
  | 'revoked'
  /** The server answered something this client does not read. */
  | 'protocol'
  /** This build sends no credential to that address (lane C's transport policy). */
  | 'policy'
  /** The approval was already handed out to an earlier read. */
  | 'consumed'

export class EnrollmentError extends Error {
  constructor(
    readonly kind: EnrollmentFailure,
    message: string,
    readonly options: { readonly check?: string; readonly status?: number } = {}
  ) {
    super(message)
    this.name = 'EnrollmentError'
  }

  /** The name of the check that refused the token, on a `refused`. */
  get check(): string | undefined {
    return this.options.check
  }
}

export interface EnrollmentClientOptions {
  readonly fetch?: FetchLike
  readonly timeoutMs?: number
  readonly build?: BuildKind
}

const DEFAULT_TIMEOUT_MS = 10_000

type Rec = Record<string, unknown>
const isRecord = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value)
    throw new EnrollmentError('protocol', `The server's answer lacks ${what}.`)
  return value
}

const defaultFetch = (): FetchLike => {
  const f = (globalThis as { fetch?: unknown }).fetch
  if (typeof f !== 'function')
    throw new Error('No fetch in this environment: pass one in the options')
  return f as FetchLike
}

function decodeDeviceSession(value: unknown): DeviceSession {
  if (!isRecord(value)) throw new EnrollmentError('protocol', 'The device session is unreadable.')
  return {
    token: str(value.token, 'the session token'),
    deviceId: str(value.deviceId, 'the device id'),
    serverId: str(value.serverId, 'the server id'),
    serverName: typeof value.serverName === 'string' ? value.serverName : ''
  }
}

function decodeDeviceView(value: unknown): DeviceView {
  if (!isRecord(value)) throw new EnrollmentError('protocol', 'The device record is unreadable.')
  const platform = value.platform
  if (platform !== 'ios' && platform !== 'android')
    throw new EnrollmentError('protocol', "The device record's platform is unreadable.")
  return {
    id: str(value.id, 'the device id'),
    name: str(value.name, 'the device name'),
    platform,
    appVersion: typeof value.appVersion === 'string' ? value.appVersion : '',
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : 0,
    lastSeenAt: typeof value.lastSeenAt === 'number' ? value.lastSeenAt : null
  }
}

export class EnrollmentClient {
  readonly baseUrl: string
  private readonly fetch: FetchLike
  private readonly timeoutMs: number

  constructor(serverUrl: string, options: EnrollmentClientOptions = {}) {
    this.baseUrl = serverUrl.replace(/\/+$/, '')
    try {
      assertCredentialMayTravelTo(this.baseUrl, options.build ?? 'release')
    } catch (error) {
      throw new EnrollmentError('policy', error instanceof Error ? error.message : String(error))
    }
    this.fetch = options.fetch ?? defaultFetch()
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  /** Asks to pair; the owner's word is awaited through `readPairing`. */
  async requestPairing(input: {
    readonly idToken: string
    readonly clientId: string
    readonly device: DeviceDescription
  }): Promise<PairingTicket> {
    const json = await this.send('POST', '/devices/pair', {
      body: JSON.stringify({
        idToken: input.idToken,
        clientId: input.clientId,
        device: {
          name: input.device.name,
          platform: input.device.platform,
          appVersion: input.device.appVersion
        }
      })
    })
    if (!isRecord(json)) throw new EnrollmentError('protocol', 'The pairing answer is unreadable.')
    return {
      pairingId: str(json.pairingId, 'the pairing id'),
      expiresAt: typeof json.expiresAt === 'number' ? json.expiresAt : 0
    }
  }

  async readPairing(pairingId: string): Promise<PairingRead> {
    const json = await this.send('GET', `/devices/pair?id=${encodeURIComponent(pairingId)}`)
    if (!isRecord(json)) throw new EnrollmentError('protocol', 'The pairing answer is unreadable.')
    const status = json.status
    if (
      status !== 'pending' &&
      status !== 'approved' &&
      status !== 'refused' &&
      status !== 'expired'
    )
      throw new EnrollmentError('protocol', "The pairing's status is unreadable.")
    return json.deviceSession === undefined
      ? { status }
      : { status, deviceSession: decodeDeviceSession(json.deviceSession) }
  }

  async me(bearer: string): Promise<DeviceView> {
    return decodeDeviceView(await this.send('GET', '/devices/me', { bearer }))
  }

  async setPushToken(bearer: string, token: string, platform: DevicePlatform): Promise<void> {
    await this.send('POST', '/devices/me/push-token', {
      bearer,
      body: JSON.stringify({ token, platform })
    })
  }

  async clearPushToken(bearer: string): Promise<void> {
    await this.send('POST', '/devices/me/push-token/clear', { bearer, body: '{}' })
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    options: { readonly bearer?: string; readonly body?: string } = {}
  ): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let status: number
    let text: string
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(options.bearer ? { Authorization: `Bearer ${options.bearer}` } : {}),
          ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {})
        },
        ...(options.body !== undefined ? { body: options.body } : {}),
        signal: controller.signal
      })
      status = response.status
      text = await response.text()
    } catch {
      if (controller.signal.aborted)
        throw new EnrollmentError(
          'timeout',
          `The machine did not answer within ${this.timeoutMs / 1000} s.`
        )
      throw new EnrollmentError('network', 'The machine could not be reached.', {
        status: undefined
      })
    } finally {
      clearTimeout(timer)
    }
    let json: unknown = undefined
    if (text.length > 0) {
      try {
        json = JSON.parse(text)
      } catch {
        if (status >= 200 && status < 300)
          throw new EnrollmentError('protocol', 'The machine answered something unreadable.', {
            status
          })
      }
    }
    if (status === 401)
      throw new EnrollmentError('unauthenticated', 'The machine refused the device session.', {
        status
      })
    if (status === 422) throw this.refusal(json, status)
    if (status < 200 || status >= 300)
      throw new EnrollmentError('protocol', `The machine answered ${status}.`, { status })
    return json
  }

  /** A declared failure, by its tag: the server names the check that
   *  refused the token, never the token. */
  private refusal(json: unknown, status: number): EnrollmentError {
    const tag = isRecord(json) && typeof json._tag === 'string' ? json._tag : ''
    const message =
      isRecord(json) && typeof json.message === 'string' && json.message ? json.message : ''
    switch (tag) {
      case 'DevicePairingRefused': {
        const check = isRecord(json) && typeof json.check === 'string' ? json.check : 'unknown'
        return new EnrollmentError(
          'refused',
          message || `The machine refused the sign-in (${check}).`,
          { check, status }
        )
      }
      case 'CapabilityUnavailable':
        return new EnrollmentError(
          'no-owner',
          'This machine has no Antasphere login. Sign in on it first, then pair.',
          { status }
        )
      case 'DeviceNotFound':
      case 'DeviceSessionRequired':
        return new EnrollmentError(
          'revoked',
          message || 'This phone is no longer paired with the machine.',
          { status }
        )
      default:
        return new EnrollmentError('protocol', message || `The machine refused (${tag || 422}).`, {
          status
        })
    }
  }
}
