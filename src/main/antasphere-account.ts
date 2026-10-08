import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as client from 'openid-client'
import { lazySettingsPorts, type SettingsPorts } from './ports/registry'
import { readJson, writeJson } from './ports/storage'
import type {
  AntasphereAccountStatus,
  AntasphereAccountView,
  AntasphereHandoff,
  AntasphereLoginFailure,
  AntasphereSignInResult
} from '../shared/antasphere-account-types'

/**
 * Signing in to Clave with an Antasphere account (PRDCT-3259).
 *
 * The flow is OpenID Connect Authorization Code with PKCE (S256), state and
 * nonce, for a public native client: the browser the user already trusts
 * does the signing in at the hub, and comes back to a listener this process
 * holds on 127.0.0.1 for exactly as long as one login lasts. The manager
 * never opens that browser: a start answers the authorization URL as a
 * handoff bound to the login's generation, to the one caller that asked
 * (the settings source, the server's command, the preload that asked for
 * it), and the shell opens it (`ipc-handlers/antasphere-account-handlers.ts`).
 * The server running on its own has no browser and needs none. The client is
 * registered at the hub's registration endpoint the first time and kept
 * (`antasphere-account-client.json`: its id and the loopback port it was
 * registered with, nothing secret), so a login reuses it and the hub sees
 * one Clave per install rather than one per sign-in. The ID token's
 * signature is checked against the hub's JWKS (`enableNonRepudiationChecks`),
 * its issuer, audience, expiry and nonce by openid-client; a token that is
 * only decoded is never accepted.
 *
 * What is asked for is the identity and nothing else: `openid profile email`,
 * plus `offline_access` whose refresh token serves one purpose, renewing this
 * login without the browser. The hub's own scopes (`account:*` and the rest)
 * are never requested and no hub API is ever called: "for now only log them
 * into Clave".
 *
 * The session (who, until when, the refresh token) is one document sealed
 * through the secret port (`antasphere-account-session.json`, owner-only),
 * bound to the issuer and the client it was obtained for, and opened again at
 * boot: valid, it is the login; lapsed with a refresh token, it is renewed;
 * anything else is signed out. A login lasts as long as the verified
 * identity does (the ID token's `exp`, or the access token's lifetime when
 * that is shorter): with a refresh token it is renewed ahead of that, without
 * one it ends there, in a running app as at a boot. Signing out is local:
 * the file goes, every window hears, and a generation counter (`epoch`),
 * bumped by every sign-out, cancel, new login and shutdown, makes sure an
 * answer that was still in flight cannot put a login back or overwrite a
 * newer one.
 *
 * The sealed document is serialised to printable ASCII first
 * (`serializeSessionSecret`): the standalone secret port files what
 * `security` can read back verbatim, and a name or an email is Unicode for
 * most of the world. The serialisation is JSON with every character beyond
 * ASCII escaped, so a record the previous version sealed as plain JSON opens
 * the same way.
 *
 * No Electron here: the network and the clock are handed in, so the whole
 * flow runs under vitest against a local provider.
 */

export const DEFAULT_ANTASPHERE_ISSUER = 'https://account.antasphere.com'
/** The environment variable that points a process at a loopback test provider. */
export const ANTASPHERE_ISSUER_ENV = 'CLAVE_ANTASPHERE_ISSUER'
/** The identity scopes, and the one that renews the login. Never more. */
export const ANTASPHERE_SCOPE = 'openid profile email offline_access'
export const CALLBACK_PATH = '/callback'
const CLIENT_FILE = 'antasphere-account-client.json'
const SESSION_FILE = 'antasphere-account-session.json'
/** Nobody signs in for longer than this; the browser tab is gone by then. */
export const DEFAULT_LOGIN_TIMEOUT_MS = 5 * 60_000
/** Every request to the issuer: this long, this big, no redirects. */
const REQUEST_TIMEOUT_MS = 15_000
const RESPONSE_MAX_BYTES = 256 * 1024
/** A renewal runs this long before the session lapses. */
const RENEW_AHEAD_MS = 60_000
const MAX_TIMER_MS = 2 ** 31 - 1

export interface AntasphereIssuerConfig {
  issuer: URL
  /** Plain HTTP, allowed for the literal loopback test target and nothing else. */
  insecure: boolean
}

/**
 * The issuer this process signs in at: the hub, or the loopback provider
 * named in the environment for a test. The override is validated rather
 * than trusted: an origin (no path, query, credentials or fragment), https,
 * or http to the literal `127.0.0.1`. Anything else is refused, and a
 * refused override does NOT fall back to the hub: a process told to use a
 * test provider must never reach production because the variable had a typo.
 */
export function resolveAntasphereIssuer(
  env: NodeJS.ProcessEnv = process.env
): { ok: true; config: AntasphereIssuerConfig } | { ok: false; reason: string } {
  const raw = env[ANTASPHERE_ISSUER_ENV]?.trim()
  if (!raw)
    return { ok: true, config: { issuer: new URL(DEFAULT_ANTASPHERE_ISSUER), insecure: false } }
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'not a URL' }
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    return { ok: false, reason: 'not a bare origin' }
  }
  if (url.protocol === 'https:') return { ok: true, config: { issuer: url, insecure: false } }
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1') {
    return { ok: true, config: { issuer: url, insecure: true } }
  }
  return { ok: false, reason: 'plain http is only accepted for 127.0.0.1' }
}

/** What the manager needs of the world, each one replaceable in a test. */
export interface AntasphereAccountDeps {
  ports?: SettingsPorts
  fetch?: typeof globalThis.fetch
  now?: () => number
  env?: NodeJS.ProcessEnv
  loginTimeoutMs?: number
  /** One line per boundary event, codes only, never a token or a server's text. */
  log?: (event: string, fields?: Record<string, string | number | boolean>) => void
}

interface ClientFile {
  v: 1
  issuer: string
  clientId: string
  /** The loopback port the redirect URI was registered with. */
  redirectPort: number
  registeredAt: number
}

/** The sealed half of the session: the whole of what the login is. */
interface SessionSecret {
  v: 1
  issuer: string
  clientId: string
  account: AntasphereAccountView
  signedInAt: number
  expiresAt: number
  refreshToken: string | null
}

interface SessionFile {
  v: 1
  issuer: string
  clientId: string
  sealed: string
  savedAt: number
}

/**
 * The session as the secret port is handed it: JSON, with every character
 * outside printable ASCII written as a JSON escape (`\u00e9`, a surrogate
 * pair for an emoji). Reversible by `JSON.parse` alone, which is why a
 * record sealed before this existed, plain JSON with the Unicode in it,
 * opens through the same `parseSessionSecret`. Exported for the tests.
 */
export function serializeSessionSecret(session: SessionSecret): string {
  return JSON.stringify(session).replace(
    /[^\x20-\x7e]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

/** The session a sealed value opened to, or null when it is not one. */
export function parseSessionSecret(opened: string): SessionSecret | null {
  try {
    return readSessionSecret(JSON.parse(opened))
  } catch {
    return null
  }
}

/** How the browser's visit ended, as a value: never a rejected promise that
 *  nobody is waiting on yet. */
type CallbackOutcome = { ok: true; url: URL } | { ok: false; failure: AntasphereLoginFailure }

interface PendingLogin {
  epoch: number
  state: string
  nonce: string
  verifier: string
  /** The handoff once the client is configured and the page built; null
   *  when the login ended before that. Every start on this login waits on
   *  the same promise, so a repeat sign-in reopens the same flow. */
  ready: Promise<AntasphereHandoff | null>
  settleReady: (handoff: AntasphereHandoff | null) => void
  /** The handoff issued for this login, once the page is built: what a
   *  confirmation must name exactly, URL and generation. */
  issued: AntasphereHandoff | null
  server: Server
  port: number
  startedAt: number
  consumed: boolean
  timer: ReturnType<typeof setTimeout>
  settle: (outcome: CallbackOutcome) => void
}

type Listener = (status: AntasphereAccountStatus) => void

/** The kind of failure an error from the client, the network or the disk is. */
export class LoginFailure extends Error {
  constructor(
    readonly failure: AntasphereLoginFailure,
    message?: string
  ) {
    super(message ?? failure)
  }
}

/** The failure this error is, through openid-client's own wrapping: a
 *  `ClientError` carries what the fetch threw as its cause. */
function classify(err: unknown): AntasphereLoginFailure {
  if (err instanceof LoginFailure) return err.failure
  if (err instanceof client.ClientError && err.cause instanceof LoginFailure)
    return err.cause.failure
  if (err instanceof client.AuthorizationResponseError) {
    return err.error === 'access_denied' ? 'denied' : 'invalid-response'
  }
  if (
    err instanceof client.ResponseBodyError ||
    err instanceof client.WWWAuthenticateChallengeError
  ) {
    return 'invalid-response'
  }
  if (err instanceof client.ClientError) {
    const cause = err.cause
    if (cause instanceof Error && ['AbortError', 'TimeoutError'].includes(cause.name))
      return 'network'
    if (cause instanceof TypeError) return 'network'
    return 'invalid-response'
  }
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return 'network'
  }
  if (err instanceof TypeError) return 'network'
  return 'invalid-response'
}

/** Whether a refresh failure means the stored session is dead (as opposed
 *  to the network being down): the token endpoint said so. */
function permanentRefreshFailure(err: unknown): boolean {
  if (err instanceof client.ResponseBodyError) return err.status >= 400 && err.status < 500
  if (
    err instanceof client.ClientError &&
    err.cause instanceof Error &&
    !(err.cause instanceof LoginFailure)
  ) {
    // A wrapped abort or timeout is the network's, not the session's.
    return !['AbortError', 'TimeoutError'].includes(err.cause.name)
  }
  const failure = classify(err)
  return failure !== 'network' && failure !== 'storage'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readClientFile(value: unknown): ClientFile | null {
  if (!isRecord(value) || value.v !== 1) return null
  if (typeof value.issuer !== 'string' || typeof value.clientId !== 'string') return null
  if (!value.clientId || !Number.isInteger(value.redirectPort)) return null
  const port = value.redirectPort as number
  if (port < 1 || port > 65535) return null
  return {
    v: 1,
    issuer: value.issuer,
    clientId: value.clientId,
    redirectPort: port,
    registeredAt: typeof value.registeredAt === 'number' ? value.registeredAt : 0
  }
}

function readSessionFile(value: unknown): SessionFile | null {
  if (!isRecord(value) || value.v !== 1) return null
  if (typeof value.issuer !== 'string' || typeof value.clientId !== 'string') return null
  if (typeof value.sealed !== 'string' || !value.sealed) return null
  return {
    v: 1,
    issuer: value.issuer,
    clientId: value.clientId,
    sealed: value.sealed,
    savedAt: typeof value.savedAt === 'number' ? value.savedAt : 0
  }
}

function readAccountView(value: unknown): AntasphereAccountView | null {
  if (!isRecord(value) || typeof value.subject !== 'string' || !value.subject) return null
  return {
    subject: value.subject,
    name: typeof value.name === 'string' ? value.name : null,
    email: typeof value.email === 'string' ? value.email : null,
    emailVerified: value.emailVerified === true
  }
}

function readSessionSecret(value: unknown): SessionSecret | null {
  if (!isRecord(value) || value.v !== 1) return null
  if (typeof value.issuer !== 'string' || typeof value.clientId !== 'string') return null
  const account = readAccountView(value.account)
  if (!account) return null
  if (typeof value.signedInAt !== 'number' || typeof value.expiresAt !== 'number') return null
  const refreshToken =
    typeof value.refreshToken === 'string' && value.refreshToken ? value.refreshToken : null
  return {
    v: 1,
    issuer: value.issuer,
    clientId: value.clientId,
    account,
    signedInAt: value.signedInAt,
    expiresAt: value.expiresAt,
    refreshToken
  }
}

/** The person, from validated ID token claims (and userinfo, when the token
 *  carried no email). Only the four fields the windows show. */
function accountFromClaims(
  claims: client.IDToken,
  extra?: client.UserInfoResponse
): AntasphereAccountView {
  const pick = (key: string): string | null => {
    const fromToken = claims[key]
    if (typeof fromToken === 'string' && fromToken) return fromToken
    const fromInfo = extra?.[key]
    return typeof fromInfo === 'string' && fromInfo ? fromInfo : null
  }
  return {
    subject: claims.sub,
    name: pick('name'),
    email: pick('email'),
    emailVerified: claims.email_verified === true || extra?.email_verified === true
  }
}

/** A fetch for the issuer and the issuer only: every request goes to its
 *  origin, waits at most `REQUEST_TIMEOUT_MS`, follows no redirect and reads
 *  at most `RESPONSE_MAX_BYTES`. The client's own signal still applies. */
export function boundedFetch(base: typeof globalThis.fetch, origin: string): client.CustomFetch {
  return async (url, options) => {
    const target = new URL(url)
    if (target.origin !== origin) {
      throw new LoginFailure('invalid-response', 'a request left the issuer')
    }
    const signals = [AbortSignal.timeout(REQUEST_TIMEOUT_MS)]
    if (options.signal) signals.push(options.signal)
    const response = await base(url, {
      method: options.method,
      headers: options.headers,
      body: options.body as BodyInit | null | undefined,
      redirect: 'manual',
      signal: AbortSignal.any(signals)
    })
    if (response.status >= 300 && response.status < 400) {
      throw new LoginFailure('invalid-response', 'the issuer redirected')
    }
    const chunks: Uint8Array[] = []
    let size = 0
    if (response.body) {
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > RESPONSE_MAX_BYTES) {
          await reader.cancel()
          throw new LoginFailure('network', 'the issuer answered with too large a body')
        }
        chunks.push(value)
      }
    }
    const canCarryBody = ![101, 204, 205, 304].includes(response.status)
    return new Response(canCarryBody ? Buffer.concat(chunks) : null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    })
  }
}

/** The page the browser lands on after the hub sends it back. It never
 *  claims a sign-in: the tokens are still to be exchanged and checked when
 *  it is served, and the outcome is told in Clave. */
const CALLBACK_PAGE = (title: string, text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:system-ui;margin:3rem;color:#222"><h1>${title}</h1><p>${text}</p></body>`

/** What a login run needs of the configured client: the configuration, and
 *  the registration it made, if it made one, for the OWNING run to persist
 *  once it knows it is still the login in flight. */
interface Configured {
  config: client.Configuration
  registration: ClientFile | null
}

export class AntasphereAccountManager {
  private readonly ports: SettingsPorts
  private readonly fetch: typeof globalThis.fetch
  private readonly now: () => number
  private readonly loginTimeoutMs: number
  private readonly log: NonNullable<AntasphereAccountDeps['log']>
  private readonly issuer: AntasphereIssuerConfig | null
  private readonly listeners = new Set<Listener>()
  /** Bumped by every sign-out, cancel, new login and shutdown: an answer
   *  from before is dropped at every point where it would write. */
  private epoch = 0
  private pending: PendingLogin | null = null
  private session: SessionSecret | null = null
  private lastFailure: AntasphereLoginFailure | null = null
  /** The session's clock: the renewal ahead of its end, or its end. */
  private sessionTimer: ReturnType<typeof setTimeout> | null = null
  /** A renewable session's end, told to the windows when the renewal has
   *  not landed by then. */
  private lapseTimer: ReturnType<typeof setTimeout> | null = null
  /** The sessions whose lapse was already told. */
  private readonly lapseAnnounced = new WeakSet<SessionSecret>()
  private renewing: Promise<void> | null = null
  private restored: Promise<void> | null = null
  private closed = false

  constructor(deps: AntasphereAccountDeps) {
    this.ports = deps.ports ?? lazySettingsPorts
    this.fetch = deps.fetch ?? ((input, init) => globalThis.fetch(input, init))
    this.now = deps.now ?? (() => Date.now())
    this.loginTimeoutMs = deps.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS
    this.log =
      deps.log ?? ((event, fields) => console.log(`[antasphere-account] ${event}`, fields ?? ''))
    const resolved = resolveAntasphereIssuer(deps.env ?? process.env)
    if (resolved.ok) {
      this.issuer = resolved.config
    } else {
      this.issuer = null
      this.lastFailure = 'configuration'
      this.log('antasphere.config.refused', { reason: resolved.reason })
    }
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The read model the windows get. Built fresh each time: nothing here
   *  holds a reference into the session, and a session past its end is no
   *  login whether or not its timer has fired yet. */
  status(): AntasphereAccountStatus {
    const session = this.liveSession()
    // A session kept only for the renewal that may still land: signed out
    // to every reader until it does, and said to have expired meanwhile.
    const lapsed = this.session !== null && session === null
    return {
      phase: this.pending ? 'signing-in' : session ? 'signed-in' : 'signed-out',
      account: session ? { ...session.account } : null,
      issuerHost: this.issuer?.issuer.host ?? '',
      signedInAt: session?.signedInAt ?? null,
      expiresAt: session?.expiresAt ?? null,
      renewable: this.session !== null && this.session.refreshToken !== null,
      loginStartedAt: this.pending?.startedAt ?? null,
      lastFailure: this.lastFailure ?? (lapsed ? 'expired' : null),
      secureStorage: this.secureStorageAvailable()
    }
  }

  /** The session while its identity is valid, and only then. One that
   *  lapsed with a refresh token is kept, not returned: the renewal that is
   *  due or running may still land and make it a login again. One that
   *  lapsed without a refresh token ends here, whoever asks first: the timer
   *  or a read. */
  private liveSession(): SessionSecret | null {
    const session = this.session
    if (!session) return null
    if (session.expiresAt > this.now()) return session
    if (session.refreshToken) {
      // A read can notice before the timer does (a capped timer, a sleep).
      this.announceLapse(session)
      if (!this.renewing && !this.closed) void this.renew(session, this.epoch)
      return null
    }
    this.expire(session)
    return null
  }

  /** The identity lapsed while its renewal is due or running: every window
   *  hears it once, now, whether the end timer or a read noticed. The push
   *  is the read model, signed out with `expired`; the renewal that lands
   *  pushes signed in again. */
  private announceLapse(session: SessionSecret): void {
    if (this.session !== session || session.expiresAt > this.now()) return
    if (this.lapseAnnounced.has(session)) return
    this.lapseAnnounced.add(session)
    this.log('antasphere.session.lapsed')
    // On the next tick: a read must not re-enter the listeners.
    queueMicrotask(() => {
      if (this.session === session) this.emit()
    })
  }

  private expire(session: SessionSecret): void {
    if (this.session !== session) return
    this.session = null
    this.lastFailure = 'expired'
    this.clearTimer()
    this.clearSession()
    this.log('antasphere.session.expired')
    // The windows hear it on the next tick, whoever noticed first: a read
    // must not re-enter the listeners, and the timer's own emit is a no-op
    // once this has run.
    queueMicrotask(() => this.emit())
  }

  private secureStorageAvailable(): boolean {
    try {
      return this.ports.secrets.available()
    } catch {
      return false
    }
  }

  private emit(): void {
    const snapshot = this.status()
    for (const listener of this.listeners) listener(snapshot)
  }

  // ── The stored client ──────────────────────────────────────────────────

  private readClient(): ClientFile | null {
    let stored: ClientFile | null
    try {
      stored = readClientFile(readJson(this.ports.storage, CLIENT_FILE))
    } catch {
      return null
    }
    if (!stored || !this.issuer || stored.issuer !== this.issuer.issuer.origin) return null
    return stored
  }

  private writeClient(file: ClientFile): void {
    try {
      writeJson(this.ports.storage, CLIENT_FILE, file, { mode: 0o600 })
    } catch (err) {
      throw new LoginFailure('storage', (err as Error).message)
    }
  }

  // ── The stored session ─────────────────────────────────────────────────

  /** Seal and write the session, replacing the previous one atomically:
   *  the previous sealed value is discarded only once the new file is in
   *  place, and a new value whose file could not be written is discarded
   *  itself, so the secret port holds exactly one item for this login. */
  private writeSession(session: SessionSecret): void {
    let previous: SessionFile | null = null
    try {
      previous = readSessionFile(readJson(this.ports.storage, SESSION_FILE))
    } catch {
      previous = null
    }
    let sealed: string
    try {
      sealed = this.ports.secrets.seal(serializeSessionSecret(session))
    } catch (err) {
      throw new LoginFailure('storage', (err as Error).message)
    }
    const file: SessionFile = {
      v: 1,
      issuer: session.issuer,
      clientId: session.clientId,
      sealed,
      savedAt: this.now()
    }
    try {
      writeJson(this.ports.storage, SESSION_FILE, file, { mode: 0o600 })
    } catch (err) {
      this.discardSealed(sealed)
      throw new LoginFailure('storage', (err as Error).message)
    }
    if (previous && previous.sealed !== sealed) this.discardSealed(previous.sealed)
  }

  private discardSealed(sealed: string): void {
    try {
      this.ports.secrets.discard(sealed)
    } catch {
      // The port's own record, if it keeps one; nothing else depends on it.
    }
  }

  /**
   * Forget the stored session. Never throws. The file is removed; a disk
   * that will not let go of it gets the record overwritten, atomically,
   * with one that no boot reads as a session (with the Electron adapter the
   * ciphertext IS the file, so leaving it would let a later boot restore a
   * login that was signed out). Returns whether the record is gone one way
   * or the other: a caller that promised the user a sign-out tells them when
   * it is not.
   */
  private clearSession(): boolean {
    let stored: SessionFile | null = null
    try {
      stored = readSessionFile(readJson(this.ports.storage, SESSION_FILE))
    } catch {
      stored = null
    }
    if (stored) this.discardSealed(stored.sealed)
    try {
      this.ports.storage.remove(SESSION_FILE)
      return true
    } catch (err) {
      this.log('antasphere.session.remove-failed', {
        reason: err instanceof Error ? err.name : 'unknown'
      })
    }
    try {
      // Not a session to `readSessionFile`: no `sealed`, and a marker that
      // says why it is there.
      writeJson(this.ports.storage, SESSION_FILE, { v: 1, revoked: true }, { mode: 0o600 })
      return true
    } catch (err) {
      this.log('antasphere.session.clear-failed', {
        reason: err instanceof Error ? err.name : 'unknown'
      })
      return false
    }
  }

  /**
   * Read the session back at boot. Valid, it is the login; lapsed with a
   * refresh token, it is renewed first; bound to another issuer or client,
   * unreadable, or malformed, it is discarded. The result is a state, never
   * an exception: a boot must not fail on a login, and a disk that fails is
   * a `storage` failure in the status.
   */
  restore(): Promise<void> {
    if (!this.restored) {
      this.restored = this.doRestore().catch((err: unknown) => {
        this.lastFailure = 'storage'
        this.log('antasphere.restore.failed', {
          reason: err instanceof Error ? err.name : 'unknown'
        })
        this.emit()
      })
    }
    return this.restored
  }

  private async doRestore(): Promise<void> {
    const epoch = this.epoch
    if (!this.issuer) return
    const stored = readSessionFile(readJson(this.ports.storage, SESSION_FILE))
    if (!stored) return
    const clientFile = this.readClient()
    if (
      stored.issuer !== this.issuer.issuer.origin ||
      !clientFile ||
      stored.clientId !== clientFile.clientId
    ) {
      this.log('antasphere.session.discarded', { reason: 'binding' })
      this.clearSession()
      return
    }
    if (!this.secureStorageAvailable()) {
      // Kept on disk: the OS encryption may be back next time. Not a login.
      this.lastFailure = 'storage'
      this.log('antasphere.session.unreadable', { reason: 'storage' })
      this.emit()
      return
    }
    let opened: string | undefined
    try {
      opened = this.ports.secrets.open(stored.sealed)
    } catch {
      opened = undefined
    }
    const secret = opened === undefined ? null : parseSessionSecret(opened)
    if (!secret || secret.issuer !== stored.issuer || secret.clientId !== stored.clientId) {
      this.log('antasphere.session.discarded', { reason: 'corrupt' })
      this.clearSession()
      return
    }
    if (secret.expiresAt > this.now()) {
      if (this.epoch !== epoch || this.closed) return
      this.session = secret
      this.scheduleSessionTimer()
      this.log('antasphere.session.restored', { renewable: secret.refreshToken !== null })
      this.emit()
      return
    }
    if (!secret.refreshToken) {
      this.log('antasphere.session.discarded', { reason: 'expired' })
      this.clearSession()
      return
    }
    await this.renew(secret, epoch)
  }

  // ── The session's clock ────────────────────────────────────────────────

  private clearTimer(): void {
    if (this.sessionTimer) clearTimeout(this.sessionTimer)
    this.sessionTimer = null
    if (this.lapseTimer) clearTimeout(this.lapseTimer)
    this.lapseTimer = null
  }

  /** Arm the session's clock: with a refresh token, a renewal a minute
   *  ahead of its end and, at its end, the lapse told to the windows if the
   *  renewal has not landed; without one, its end, at which it is signed
   *  out. */
  private scheduleSessionTimer(): void {
    this.clearTimer()
    const session = this.session
    if (!session || this.closed) return
    const epoch = this.epoch
    if (session.refreshToken) {
      // A renewal never spins: an issuer handing out very short tokens gets
      // one request a second at most.
      this.sessionTimer = this.arm(
        'sessionTimer',
        session.expiresAt - RENEW_AHEAD_MS,
        1_000,
        session,
        epoch,
        () => {
          // A timer that fires late (the machine slept) past the end: the
          // lapse is told before the renewal is asked for.
          this.announceLapse(session)
          void this.renew(session, epoch)
        }
      )
      this.lapseTimer = this.arm('lapseTimer', session.expiresAt, 0, session, epoch, () =>
        this.announceLapse(session)
      )
    } else {
      this.sessionTimer = this.arm('sessionTimer', session.expiresAt, 0, session, epoch, () =>
        this.expire(session)
      )
    }
  }

  /** One timer for `at`, in `slot`: fires `due` only when the moment has
   *  come and the session and generation are still the ones armed. A wait
   *  longer than a timer can hold is cut at the platform's maximum and
   *  re-armed for the rest, never fired early. */
  private arm(
    slot: 'sessionTimer' | 'lapseTimer',
    at: number,
    floor: number,
    session: SessionSecret,
    epoch: number,
    due: () => void
  ): ReturnType<typeof setTimeout> {
    const delay = Math.min(MAX_TIMER_MS, Math.max(floor, at - this.now()))
    const timer = setTimeout(() => {
      this[slot] = null
      if (this.session !== session || this.epoch !== epoch || this.closed) return
      if (at > this.now()) {
        this[slot] = this.arm(slot, at, floor, session, epoch, due)
        return
      }
      due()
    }, delay)
    timer.unref?.()
    return timer
  }

  /** One renewal at a time; a second ask joins the first. An answer that
   *  arrives after a sign-out, a new login or a shutdown is dropped. */
  private renew(session: SessionSecret, epoch: number): Promise<void> {
    if (!this.renewing) {
      this.renewing = this.doRenew(session, epoch).finally(() => {
        this.renewing = null
      })
    }
    return this.renewing
  }

  private stale(epoch: number): boolean {
    return this.epoch !== epoch || this.closed
  }

  private async doRenew(session: SessionSecret, epoch: number): Promise<void> {
    if (!this.issuer || !session.refreshToken) return
    try {
      const { config } = await this.configure(session.clientId, null)
      const tokens = await client.refreshTokenGrant(config, session.refreshToken)
      const claims = tokens.claims()
      // Identity continuity: a renewed login is the same person, or it is no login.
      if (claims && claims.sub !== session.account.subject) {
        throw new LoginFailure('invalid-response', 'the renewed token names another subject')
      }
      // A renewal with no usable lifetime is no renewal: none stated, or one
      // already past (the library tolerates a token a little beyond its
      // `exp`; kept, it would be asked for again at once). The login would
      // otherwise either never end or be renewed in a loop.
      const expiresAt = this.expiryOf(tokens)
      if (expiresAt === null || expiresAt <= this.now()) {
        throw new LoginFailure('invalid-response', 'the renewed tokens name no usable lifetime')
      }
      // The profile: the renewed token's claims first, userinfo when the
      // token carries no email, and what the login had for anything still
      // missing. A renewal never erases a name or an email it was shown.
      let account = session.account
      if (claims) {
        let info: client.UserInfoResponse | undefined
        if (typeof claims.email !== 'string' && config.serverMetadata().userinfo_endpoint) {
          try {
            info = await client.fetchUserInfo(config, tokens.access_token, claims.sub)
          } catch (err) {
            this.log('antasphere.renew.userinfo-failed', { reason: classify(err) })
          }
        }
        const fresh = accountFromClaims(claims, info)
        account = {
          subject: fresh.subject,
          name: fresh.name ?? session.account.name,
          email: fresh.email ?? session.account.email,
          emailVerified: fresh.email ? fresh.emailVerified : session.account.emailVerified
        }
      }
      if (this.stale(epoch)) {
        this.log('antasphere.renew.dropped', { reason: 'epoch' })
        return
      }
      const renewed: SessionSecret = {
        ...session,
        account,
        expiresAt,
        refreshToken: tokens.refresh_token ?? session.refreshToken
      }
      this.writeSession(renewed)
      this.session = renewed
      this.lastFailure = null
      this.scheduleSessionTimer()
      this.log('antasphere.renew.ok')
      this.emit()
    } catch (err) {
      if (this.stale(epoch)) {
        this.log('antasphere.renew.dropped', { reason: 'epoch' })
        return
      }
      const failure = classify(err)
      const permanent = permanentRefreshFailure(err)
      this.log('antasphere.renew.failed', { reason: failure, permanent })
      this.session = null
      this.clearTimer()
      this.lastFailure = failure
      if (permanent) this.clearSession()
      this.emit()
    }
  }

  /** When the login ends: the verified identity's own expiry (the ID
   *  token's `exp`), and no later than the access token's lifetime when the
   *  response names a shorter one. A response with neither (a renewal
   *  without an ID token and without `expires_in`) names no lifetime, and
   *  the caller refuses it: a login never runs on an end nobody stated. */
  private expiryOf(
    tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers
  ): number | null {
    const ends: number[] = []
    const claims = tokens.claims()
    if (claims && typeof claims.exp === 'number') ends.push(claims.exp * 1000)
    const seconds = tokens.expiresIn()
    if (typeof seconds === 'number') ends.push(this.now() + seconds * 1000)
    if (ends.length === 0) return null
    return Math.min(...ends)
  }

  // ── The client configuration ───────────────────────────────────────────

  private requestOptions(): client.DiscoveryRequestOptions {
    const issuer = this.issuer!
    const execute = [client.enableNonRepudiationChecks]
    if (issuer.insecure) execute.push(client.allowInsecureRequests)
    return {
      [client.customFetch]: boundedFetch(this.fetch, issuer.issuer.origin),
      execute,
      timeout: Math.ceil(REQUEST_TIMEOUT_MS / 1000)
    }
  }

  /** Every endpoint the flow touches sits on the issuer's own origin, or the
   *  metadata is refused. The bounded fetch already refuses a request that
   *  would leave it; this names the condition at discovery, before the
   *  browser is sent anywhere. */
  private pinMetadata(config: client.Configuration): void {
    const issuer = this.issuer!
    const metadata = config.serverMetadata()
    if (metadata.issuer !== issuer.issuer.origin) {
      throw new LoginFailure('invalid-response', 'the metadata names another issuer')
    }
    for (const key of [
      'authorization_endpoint',
      'token_endpoint',
      'jwks_uri',
      'registration_endpoint',
      'userinfo_endpoint'
    ] as const) {
      const value = metadata[key]
      if (value === undefined) continue
      if (typeof value !== 'string' || new URL(value).origin !== issuer.issuer.origin) {
        throw new LoginFailure('invalid-response', `${key} is off the issuer`)
      }
    }
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      if (!metadata[key]) throw new LoginFailure('invalid-response', `${key} is missing`)
    }
  }

  /** Discover the issuer and configure the client: the stored registration
   *  when there is one, else a new public native client registered for the
   *  reserved loopback port. A registration made here is returned, not
   *  persisted: only the login that is still current may keep it. */
  private async configure(
    clientId: string | null,
    redirectPort: number | null
  ): Promise<Configured> {
    const issuer = this.issuer!
    const options = this.requestOptions()
    if (clientId) {
      const config = await client.discovery(
        issuer.issuer,
        clientId,
        { token_endpoint_auth_method: 'none', id_token_signed_response_alg: 'RS256' },
        client.None(),
        options
      )
      this.pinMetadata(config)
      return { config, registration: null }
    }
    if (redirectPort === null) throw new LoginFailure('registration', 'no port to register')
    let config: client.Configuration
    try {
      config = await client.dynamicClientRegistration(
        issuer.issuer,
        {
          client_name: 'Clave',
          application_type: 'native',
          redirect_uris: [`http://127.0.0.1:${redirectPort}${CALLBACK_PATH}`],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          scope: ANTASPHERE_SCOPE,
          id_token_signed_response_alg: 'RS256'
        },
        client.None(),
        options
      )
    } catch (err) {
      // The registration endpoint said no: that is a registration failure,
      // whatever the status; the network's own failures keep their kind.
      if (
        err instanceof client.ResponseBodyError ||
        err instanceof client.WWWAuthenticateChallengeError
      ) {
        throw new LoginFailure('registration', 'the issuer refused the registration')
      }
      throw err
    }
    this.pinMetadata(config)
    const registered = config.clientMetadata()
    if (
      registered.client_secret !== undefined ||
      registered.token_endpoint_auth_method !== 'none'
    ) {
      throw new LoginFailure('registration', 'the issuer registered a confidential client')
    }
    const grants = registered.grant_types
    if (!Array.isArray(grants) || !grants.includes('authorization_code')) {
      throw new LoginFailure('registration', 'the registration lacks the code grant')
    }
    return {
      config,
      registration: {
        v: 1,
        issuer: issuer.issuer.origin,
        clientId: registered.client_id,
        redirectPort,
        registeredAt: this.now()
      }
    }
  }

  // ── The loopback listener ──────────────────────────────────────────────

  /** Listen on 127.0.0.1: the stored port, so the stored registration's
   *  redirect URI holds; else, or when that port is taken, any free one,
   *  for which a replacement registration is made once. */
  private listen(port: number): Promise<{ server: Server; port: number; reused: boolean }> {
    const server = createServer((req, res) => this.onCallback(req, res))
    server.on('connection', (socket) => socket.unref?.())
    const tryPort = (p: number): Promise<number> =>
      new Promise((resolve, reject) => {
        const onError = (err: Error): void => {
          server.removeListener('listening', onListening)
          reject(err)
        }
        const onListening = (): void => {
          server.removeListener('error', onError)
          resolve((server.address() as AddressInfo).port)
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(p, '127.0.0.1')
      })
    return (async () => {
      if (port > 0) {
        try {
          return { server, port: await tryPort(port), reused: true }
        } catch (err) {
          this.log('antasphere.listener.port-taken', {
            port,
            code: (err as NodeJS.ErrnoException).code ?? ''
          })
        }
      }
      try {
        return { server, port: await tryPort(0), reused: false }
      } catch (err) {
        throw new LoginFailure('network', (err as Error).message)
      }
    })()
  }

  private onCallback(req: IncomingMessage, res: ServerResponse): void {
    const pending = this.pending
    const base = `http://127.0.0.1:${pending?.port ?? 0}`
    // The request target as sent: an origin-form path, or an absolute form
    // that must name this listener. A target that does not parse, or names
    // another origin, is answered and changes nothing: the login that is
    // waiting keeps waiting.
    let url: URL
    try {
      url = new URL(req.url ?? '/', base)
    } catch {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(CALLBACK_PAGE('This sign-in link is not valid', 'Go back to Clave and start again.'))
      return
    }
    if (url.origin !== base) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(CALLBACK_PAGE('This sign-in link is not valid', 'Go back to Clave and start again.'))
      return
    }
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      res.end(CALLBACK_PAGE('Not found', 'Nothing is served here.'))
      return
    }
    // Only the login that is waiting, exactly once: a stale, replayed or
    // unsolicited callback is answered and changes nothing.
    // One `state`, exactly the pending login's: a second value, whatever
    // it is, makes the callback one that was not sent as asked.
    const states = url.searchParams.getAll('state')
    if (!pending || pending.consumed || states.length !== 1 || states[0] !== pending.state) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
      res.end(CALLBACK_PAGE('This sign-in link is not valid', 'Go back to Clave and start again.'))
      return
    }
    pending.consumed = true
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    // The page says what is true at this point: the browser's part is done.
    // Whether the sign-in lands is decided by the exchange that follows, and
    // told in Clave; a response carrying the hub's refusal says so.
    res.end(
      url.searchParams.has('error')
        ? CALLBACK_PAGE('The sign-in did not complete', 'Go back to Clave for what happened next.')
        : CALLBACK_PAGE(
            'Go back to Clave',
            'You can close this tab. Clave is finishing the sign-in.'
          )
    )
    pending.settle({ ok: true, url })
  }

  private closePending(pending: PendingLogin): void {
    clearTimeout(pending.timer)
    pending.server.closeAllConnections?.()
    pending.server.close()
    // A start still waiting on this login's page gets no handoff: the page,
    // built or not, belongs to a login that is over.
    pending.settleReady(null)
    if (this.pending === pending) this.pending = null
  }

  /** The generation of the login in flight, or null: what a handoff must
   *  name to be opened. Bumped by every cancel, sign-out, new login and
   *  shutdown, so a handoff from before any of those names a generation
   *  that is no longer this. */
  pendingGeneration(): number | null {
    return this.pending && this.epoch === this.pending.epoch ? this.pending.epoch : null
  }

  /**
   * Whether a handoff is the one issued for the login in flight: the exact
   * URL this manager built, for the generation that is still current. A
   * read, never a start: it changes nothing, reopens nothing and logs
   * nothing. The shell asks before it opens a browser (through the server,
   * so the manager that issued the handoff is the one that answers); a
   * cancel, a sign-out, a new login or a shutdown between the sign-in's
   * answer and the open makes this false, and a URL that is not the issued
   * one, whatever its origin, is false too.
   */
  confirmHandoff(handoff: { url: string; generation: number }): boolean {
    const pending = this.pending
    if (!pending || this.closed || this.epoch !== pending.epoch) return false
    if (!pending.issued || pending.consumed) return false
    return pending.issued.generation === handoff.generation && pending.issued.url === handoff.url
  }

  // ── The login ──────────────────────────────────────────────────────────

  /**
   * Start a login, or, while one is waiting on the browser, answer that same
   * login's handoff again so the caller can reopen the browser on it.
   * Answers once the client is configured and the authorization page built:
   * the status as it is then, and the handoff for the caller to open, or
   * null when the login ended before the page was ready (a cancel, a
   * sign-out, a failure to reach the issuer, a shutdown). The outcome of the
   * browser's visit reaches the windows through `onChange`. A new login is a
   * new generation: whatever an older renewal or login still has in flight
   * is dropped when it lands.
   */
  async start(): Promise<AntasphereSignInResult> {
    const answer = async (pending: PendingLogin | null): Promise<AntasphereSignInResult> => {
      const handoff = pending ? await pending.ready : null
      // The page belongs to the login that is still this one, or to nobody:
      // a login replaced or ended while the page was being built hands out
      // nothing, whatever the page it built.
      const current = pending !== null && this.pending === pending && this.epoch === pending.epoch
      return { status: this.status(), handoff: current ? handoff : null }
    }
    if (this.pending) return answer(this.pending)
    if (this.closed) return answer(null)
    if (!this.issuer) {
      this.lastFailure = 'configuration'
      this.emit()
      return answer(null)
    }
    if (!this.secureStorageAvailable()) {
      this.lastFailure = 'storage'
      this.log('antasphere.login.refused', { reason: 'storage' })
      this.emit()
      return answer(null)
    }
    const epoch = ++this.epoch
    const stored = this.readClient()
    let listener: { server: Server; port: number; reused: boolean }
    try {
      listener = await this.listen(stored?.redirectPort ?? 0)
    } catch (err) {
      this.lastFailure = classify(err)
      this.log('antasphere.login.failed', { reason: this.lastFailure, step: 'listen' })
      this.emit()
      return answer(null)
    }
    if (this.epoch !== epoch || this.pending || this.closed) {
      listener.server.close()
      return answer(null)
    }
    let settle!: (outcome: CallbackOutcome) => void
    const callback = new Promise<CallbackOutcome>((resolve) => {
      settle = resolve
    })
    let settleReady!: (handoff: AntasphereHandoff | null) => void
    const ready = new Promise<AntasphereHandoff | null>((resolve) => {
      settleReady = resolve
    })
    const pending: PendingLogin = {
      epoch,
      state: client.randomState(),
      nonce: client.randomNonce(),
      verifier: client.randomPKCECodeVerifier(),
      ready,
      settleReady,
      issued: null,
      server: listener.server,
      port: listener.port,
      startedAt: this.now(),
      consumed: false,
      timer: setTimeout(() => settle({ ok: false, failure: 'timeout' }), this.loginTimeoutMs),
      settle
    }
    pending.timer.unref?.()
    this.pending = pending
    this.lastFailure = null
    this.emit()
    this.log('antasphere.login.started', { reusedPort: listener.reused })
    void this.runLogin(pending, callback, stored && listener.reused ? stored.clientId : null)
    // The caller waits for the page: `runLogin` settles `ready` once the
    // client is configured and the URL built, and the outcome of the
    // browser's visit is pushed.
    return answer(pending)
  }

  private async runLogin(
    pending: PendingLogin,
    callback: Promise<CallbackOutcome>,
    clientId: string | null
  ): Promise<void> {
    const current = (): boolean =>
      this.pending === pending && this.epoch === pending.epoch && !this.closed
    try {
      const { config, registration } = await this.configure(clientId, pending.port)
      if (!current()) throw new LoginFailure('cancelled')
      if (registration) {
        this.writeClient(registration)
        this.log('antasphere.client.registered', { port: registration.redirectPort })
      }
      const redirectUri = `http://127.0.0.1:${pending.port}${CALLBACK_PATH}`
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: ANTASPHERE_SCOPE,
        code_challenge: await client.calculatePKCECodeChallenge(pending.verifier),
        code_challenge_method: 'S256',
        state: pending.state,
        nonce: pending.nonce
      })
      // The page is ready: whoever is waiting on this login's start gets
      // the handoff, bound to this generation; the URL goes nowhere else.
      pending.issued = { url: url.toString(), generation: pending.epoch }
      pending.settleReady(pending.issued)
      const landed = await callback
      if (!landed.ok) throw new LoginFailure(landed.failure)
      if (!current()) throw new LoginFailure('cancelled')
      const tokens = await client.authorizationCodeGrant(config, landed.url, {
        pkceCodeVerifier: pending.verifier,
        expectedState: pending.state,
        expectedNonce: pending.nonce,
        idTokenExpected: true
      })
      const claims = tokens.claims()
      if (!claims) throw new LoginFailure('invalid-response', 'no ID token')
      let info: client.UserInfoResponse | undefined
      if (typeof claims.email !== 'string' && config.serverMetadata().userinfo_endpoint) {
        info = await client.fetchUserInfo(config, tokens.access_token, claims.sub)
      }
      if (!current()) throw new LoginFailure('cancelled')
      const expiresAt = this.expiryOf(tokens)
      if (expiresAt === null) throw new LoginFailure('invalid-response', 'no lifetime')
      const session: SessionSecret = {
        v: 1,
        issuer: this.issuer!.issuer.origin,
        clientId: config.clientMetadata().client_id,
        account: accountFromClaims(claims, info),
        signedInAt: this.now(),
        expiresAt,
        refreshToken: tokens.refresh_token ?? null
      }
      // The library tolerates a token a little past its `exp` (clock
      // tolerance); a login must still have time left when it is kept.
      if (session.expiresAt <= this.now()) {
        throw new LoginFailure('invalid-response', 'the identity has already expired')
      }
      this.writeSession(session)
      this.closePending(pending)
      this.session = session
      this.lastFailure = null
      this.scheduleSessionTimer()
      this.log('antasphere.login.ok', { renewable: session.refreshToken !== null })
      this.emit()
    } catch (err) {
      const failure = classify(err)
      if (!current()) {
        // Cancelled, signed out, replaced or shut down meanwhile: the answer,
        // whatever it was, is dropped; the status was already told.
        this.log('antasphere.login.dropped', { reason: failure })
        return
      }
      this.closePending(pending)
      this.lastFailure = failure
      this.log('antasphere.login.failed', { reason: failure })
      this.emit()
    }
  }

  /** Stop the login in flight: the listener closes, the browser's answer,
   *  if it ever comes, lands on nothing. */
  cancel(): AntasphereAccountStatus {
    const pending = this.pending
    if (!pending) return this.status()
    this.epoch++
    this.closePending(pending)
    pending.settle({ ok: false, failure: 'cancelled' })
    this.lastFailure = 'cancelled'
    this.log('antasphere.login.cancelled')
    this.emit()
    return this.status()
  }

  /** Forget the login here. Local to Clave: the hub's own session is not
   *  touched. Everything pending is dropped, the files go, every window hears. */
  signOut(): AntasphereAccountStatus {
    this.epoch++
    const pending = this.pending
    if (pending) {
      this.closePending(pending)
      pending.settle({ ok: false, failure: 'cancelled' })
    }
    this.clearTimer()
    this.session = null
    // The login in memory is gone whatever the disk says; a record that
    // could neither be removed nor invalidated is a storage failure the
    // user sees, not a sign-out they were promised.
    this.lastFailure = this.clearSession() ? null : 'storage'
    this.log('antasphere.signed-out', { cleared: this.lastFailure === null })
    this.emit()
    return this.status()
  }

  /** Clear the failure the status shows, once read. */
  dismissFailure(): AntasphereAccountStatus {
    if (this.lastFailure && this.lastFailure !== 'configuration') {
      this.lastFailure = null
      this.emit()
    }
    return this.status()
  }

  /** The app is quitting: nothing stays listening, nothing fires later, and
   *  nothing still in flight writes. The session on disk is kept as it is. */
  shutdown(): void {
    this.closed = true
    this.epoch++
    const pending = this.pending
    if (pending) {
      this.closePending(pending)
      pending.settle({ ok: false, failure: 'cancelled' })
    }
    this.clearTimer()
  }
}
