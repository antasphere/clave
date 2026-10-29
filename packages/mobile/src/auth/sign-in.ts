/**
 * Signing in on the phone with the Antasphere account (decision 2 of the
 * spec): Authorization Code with PKCE S256 in the platform's authentication
 * session, as a state machine driven through an injected `openAuthSession`.
 * The platform comes in at the wiring (expo-web-browser's
 * `openAuthSessionAsync`, expo-crypto, expo-secure-store), so the whole flow
 * runs under Node against the local provider.
 *
 * The flow: the stored registration for this issuer, or a new one (the hub
 * purges an anonymous client unused for thirty days, so a refresh refused
 * as `invalid_client` registers again at once and the person signs in
 * again; the family of tokens belonged to the purged client); a verifier, a
 * state and a nonce; the authorization URL handed to the authentication
 * session, which comes back with the redirect `clave://oauth/callback?code=
 * …&state=…`; the state checked, exactly one and the one sent; the code
 * exchanged with the verifier; the ID token decoded and checked by shape
 * (`jwt.ts`: issuer, audience, lifetime, nonce); the tokens kept. The hub
 * rotates the refresh token on every use with no grace for a public client,
 * so a refresh runs one at a time (a second ask joins the first) and the
 * rotated token is written before the new access token is, so a crash in
 * between loses nothing the hub still honours. A refresh refused as
 * `invalid_grant` drops the whole family: the person is signed out.
 *
 * Renewal is lazy, on use: `accessToken()` and `idToken()` refresh when
 * what they hold is within a minute of its end. The Mac arms timers; a
 * phone's process is suspended for hours at a time and the token is asked
 * for when the app is in front, which is when it matters.
 */
import type { FetchLike } from '../api/client'
import type { SecureStorePort } from '../machines/credentials'
import { HubClient, HubError } from './hub'
import { REDIRECT_URI, resolveIssuer, type IssuerConfig } from './issuer'
import { checkIdToken, decodeIdToken, IdTokenRefused, type IdTokenClaims } from './jwt'
import { challengeOf, makeVerifier, randomValue, type CryptoPort } from './pkce'
import { HubTokenStore, type StoredAccount, type StoredToken } from './store'

export type AuthPhase = 'signed-out' | 'signing-in' | 'signed-in'

export type AuthFailure =
  | 'cancelled'
  | 'denied'
  | 'network'
  | 'timeout'
  | 'invalid-response'
  | 'registration'
  | 'storage'
  | 'configuration'
  | 'expired'
  | 'client-purged'

export interface AuthStatus {
  readonly phase: AuthPhase
  readonly account: StoredAccount | null
  readonly clientId: string | null
  /** When the verified identity lapses (the ID token's `exp`); null when signed out. */
  readonly expiresAt: number | null
  readonly renewable: boolean
  readonly issuer: string
  readonly lastFailure: AuthFailure | null
}

export class AuthError extends Error {
  constructor(
    readonly failure: AuthFailure,
    message: string
  ) {
    super(message)
    this.name = 'AuthError'
  }
}

/**
 * Opens the platform's authentication session on `url` and answers the
 * redirect URL it came back with (`clave://oauth/callback?…`), or null when
 * the person dismissed it. expo-web-browser's `openAuthSessionAsync(url,
 * redirectUri)` answers `{type: 'success', url}` or `{type: 'cancel' |
 * 'dismiss' | 'locked'}`: the wiring maps the first to the URL and the rest
 * to null. A thrown error is the platform's own failure.
 */
export type OpenAuthSession = (url: string, redirectUri: string) => Promise<string | null>

export interface SignInDeps {
  /** The raw override (`CLAVE_ANTASPHERE_ISSUER`), resolved by the issuer rule; absent is the hub. */
  readonly issuer?: string | null
  readonly fetch?: FetchLike
  readonly secureStore: SecureStorePort
  readonly crypto: CryptoPort
  readonly openAuthSession: OpenAuthSession
  readonly now?: () => number
  /** A renewal runs when a token is within this of its end. */
  readonly renewAheadMs?: number
  /** One line per boundary event, codes only, never a token or a server's text. */
  readonly log?: (event: string, fields?: Record<string, string | number | boolean>) => void
}

const RENEW_AHEAD_MS = 60_000

interface Session {
  readonly clientId: string
  readonly account: StoredAccount
  readonly signedInAt: number
  access: StoredToken | null
  id: StoredToken | null
  refreshToken: string | null
}

function classify(error: unknown): AuthFailure {
  if (error instanceof AuthError) return error.failure
  if (error instanceof HubError) {
    switch (error.kind) {
      case 'network':
      case 'timeout':
      case 'registration':
      case 'invalid-response':
        return error.kind
      case 'invalid_grant':
        return 'expired'
      case 'invalid_client':
        return 'client-purged'
    }
  }
  if (error instanceof IdTokenRefused) return 'invalid-response'
  return 'invalid-response'
}

const accountOf = (claims: IdTokenClaims, previous?: StoredAccount): StoredAccount => ({
  subject: claims.sub,
  name: claims.name ?? previous?.name ?? null,
  email: claims.email ?? previous?.email ?? null,
  emailVerified: claims.email ? claims.emailVerified === true : (previous?.emailVerified ?? false)
})

export class HubSignIn {
  private readonly issuer: IssuerConfig | null
  private readonly hub: HubClient | null
  private readonly store: HubTokenStore
  private readonly crypto: CryptoPort
  private readonly openAuthSession: OpenAuthSession
  private readonly now: () => number
  private readonly renewAheadMs: number
  private readonly log: NonNullable<SignInDeps['log']>
  private readonly listeners = new Set<(status: AuthStatus) => void>()
  private session: Session | null = null
  private clientId: string | null = null
  private lastFailure: AuthFailure | null = null
  private signingIn: Promise<AuthStatus> | null = null
  private refreshing: Promise<void> | null = null
  private restored: Promise<AuthStatus> | null = null
  /** Bumped by every sign-out and new sign-in: an answer from before writes nothing. */
  private epoch = 0
  private storageWrites: Promise<void> = Promise.resolve()

  private serializeStorage(change: () => Promise<void>): Promise<void> {
    const next = this.storageWrites.then(change)
    this.storageWrites = next.catch(() => {})
    return next
  }

  constructor(deps: SignInDeps) {
    const resolved = resolveIssuer(deps.issuer)
    if (resolved.ok) {
      this.issuer = resolved.config
      this.hub = new HubClient(resolved.config, { fetch: deps.fetch })
    } else {
      this.issuer = null
      this.hub = null
      this.lastFailure = 'configuration'
    }
    this.store = new HubTokenStore(deps.secureStore)
    this.crypto = deps.crypto
    this.openAuthSession = deps.openAuthSession
    this.now = deps.now ?? (() => Date.now())
    this.renewAheadMs = deps.renewAheadMs ?? RENEW_AHEAD_MS
    this.log = deps.log ?? ((): void => {})
    if (!resolved.ok) this.log('hub.config.refused', { reason: resolved.reason })
  }

  status(): AuthStatus {
    const session = this.session
    return {
      phase: this.signingIn ? 'signing-in' : session ? 'signed-in' : 'signed-out',
      account: session ? { ...session.account } : null,
      clientId: this.clientId,
      expiresAt: session?.id?.expiresAt ?? session?.access?.expiresAt ?? null,
      renewable: session?.refreshToken !== null && session?.refreshToken !== undefined,
      issuer: this.issuer?.origin ?? '',
      lastFailure: this.lastFailure
    }
  }

  onChange(listener: (status: AuthStatus) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    const snapshot = this.status()
    for (const listener of this.listeners) listener(snapshot)
  }

  /** Reads what the store holds at boot: the registration, and the session
   *  when it belongs to this issuer and this client. Never throws. */
  restore(): Promise<AuthStatus> {
    if (!this.restored) this.restored = this.doRestore()
    return this.restored
  }

  private async doRestore(): Promise<AuthStatus> {
    const epoch = this.epoch
    if (!this.issuer) return this.status()
    try {
      const client = await this.store.readClient()
      if (client && client.issuer === this.issuer.origin) this.clientId = client.clientId
      // A sign-in that ran before the restore already holds the session.
      if (this.session) return this.status()
      const stored = await this.store.readSession()
      if (!stored) return this.status()
      if (stored.issuer !== this.issuer.origin || stored.clientId !== this.clientId) {
        this.log('hub.session.discarded', { reason: 'binding' })
        await this.serializeStorage(() => this.store.clearSession())
        return this.status()
      }
      const restored: Session = {
        clientId: stored.clientId,
        account: stored.account,
        signedInAt: stored.signedInAt,
        access: await this.store.readAccessToken(),
        id: await this.store.readIdToken(),
        refreshToken: await this.store.readRefreshToken()
      }
      if (epoch !== this.epoch) return this.status()
      this.session = restored
      this.log('hub.session.restored', { renewable: restored.refreshToken !== null })
    } catch {
      this.lastFailure = 'storage'
      this.log('hub.restore.failed')
    }
    this.emit()
    return this.status()
  }

  /** The client id the app registered, registering when there is none. */
  async ensureClient(): Promise<string> {
    if (!this.hub || !this.issuer) throw new AuthError('configuration', 'The issuer is refused.')
    if (this.clientId) return this.clientId
    const stored = await this.store.readClient()
    if (stored && stored.issuer === this.issuer.origin) {
      this.clientId = stored.clientId
      return stored.clientId
    }
    const clientId = await this.hub.register()
    await this.store.writeClient({ issuer: this.issuer.origin, clientId, registeredAt: this.now() })
    this.clientId = clientId
    this.log('hub.client.registered')
    return clientId
  }

  /** One sign-in at a time: a second ask while one waits on the browser joins it. */
  signIn(): Promise<AuthStatus> {
    if (this.signingIn) return this.signingIn
    // The flag is cleared before the status is read, so the answer says
    // where the sign-in ended, never that it is still running.
    const run = this.doSignIn().then(() => {
      this.signingIn = null
      this.emit()
      return this.status()
    })
    this.signingIn = run
    this.emit()
    return run
  }

  private async doSignIn(): Promise<void> {
    const epoch = ++this.epoch
    this.lastFailure = null
    try {
      if (!this.hub || !this.issuer) throw new AuthError('configuration', 'The issuer is refused.')
      const clientId = await this.ensureClient()
      const verifier = makeVerifier(this.crypto)
      const state = randomValue(this.crypto)
      const nonce = randomValue(this.crypto)
      const url = await this.hub.authorizationUrl({
        clientId,
        codeChallenge: await challengeOf(verifier, this.crypto),
        state,
        nonce
      })
      const redirect = await this.openAuthSession(url, REDIRECT_URI)
      if (this.epoch !== epoch) throw new AuthError('cancelled', 'The sign-in was replaced.')
      if (redirect === null) throw new AuthError('cancelled', 'The sign-in was dismissed.')
      const code = this.readCallback(redirect, state)
      const tokens = await this.hub.exchangeCode({ clientId, code, verifier })
      if (!tokens.idToken) throw new AuthError('invalid-response', 'No ID token came back.')
      const claims = decodeIdToken(tokens.idToken)
      checkIdToken(claims, { issuer: this.issuer.origin, clientId, nonce, now: this.now() })
      if (this.epoch !== epoch) throw new AuthError('cancelled', 'The sign-in was replaced.')
      const session: Session = {
        clientId,
        account: accountOf(claims),
        signedInAt: this.now(),
        access: {
          token: tokens.accessToken,
          expiresAt: this.accessExpiry(tokens.expiresIn, claims)
        },
        id: { token: tokens.idToken, expiresAt: claims.exp * 1000 },
        refreshToken: tokens.refreshToken
      }
      await this.serializeStorage(async () => {
        if (this.epoch === epoch) await this.persist(session)
      })
      if (this.epoch !== epoch) return
      this.session = session
      this.lastFailure = null
      this.log('hub.sign-in.ok', { renewable: session.refreshToken !== null })
    } catch (error) {
      const failure = classify(error)
      if (this.epoch === epoch) {
        this.lastFailure = failure
        this.log('hub.sign-in.failed', { reason: failure })
      } else this.log('hub.sign-in.dropped', { reason: failure })
    }
  }

  /** The code of the redirect the authentication session came back with:
   *  the redirect URI itself, exactly one `state` and the one sent, an
   *  `iss` naming this issuer when present, and no error. */
  private readCallback(redirect: string, state: string): string {
    let url: URL
    try {
      url = new URL(redirect)
    } catch {
      throw new AuthError('invalid-response', 'The sign-in came back with no readable address.')
    }
    const back = new URL(REDIRECT_URI)
    if (url.protocol !== back.protocol || url.host !== back.host || url.pathname !== back.pathname)
      throw new AuthError('invalid-response', 'The sign-in came back somewhere else.')
    const states = url.searchParams.getAll('state')
    if (states.length !== 1 || states[0] !== state)
      throw new AuthError('invalid-response', 'The sign-in came back with another state.')
    const iss = url.searchParams.get('iss')
    if (iss !== null && this.issuer && iss !== this.issuer.origin)
      throw new AuthError('invalid-response', 'The sign-in came back from another issuer.')
    const error = url.searchParams.get('error')
    if (error !== null)
      throw new AuthError(
        error === 'access_denied' ? 'denied' : 'invalid-response',
        error === 'access_denied' ? 'The sign-in was refused.' : `The issuer answered ${error}.`
      )
    const code = url.searchParams.get('code')
    if (!code) throw new AuthError('invalid-response', 'The sign-in came back without a code.')
    return code
  }

  private accessExpiry(expiresIn: number | null, claims: IdTokenClaims | null): number {
    const ends: number[] = []
    if (expiresIn !== null) ends.push(this.now() + expiresIn * 1000)
    if (claims) ends.push(claims.exp * 1000)
    return ends.length ? Math.min(...ends) : this.now()
  }

  /** The refresh token first, so a crash after it loses nothing the hub
   *  still honours; then the rest. */
  private async persist(session: Session): Promise<void> {
    try {
      if (session.refreshToken) await this.store.writeRefreshToken(session.refreshToken)
      if (session.access) await this.store.writeAccessToken(session.access)
      if (session.id) await this.store.writeIdToken(session.id)
      await this.store.writeSession({
        issuer: this.issuer!.origin,
        clientId: session.clientId,
        account: session.account,
        signedInAt: session.signedInAt
      })
    } catch (error) {
      throw new AuthError('storage', error instanceof Error ? error.message : String(error))
    }
  }

  /** Forgets the login here; the hub's own session is not touched. */
  async signOut(): Promise<AuthStatus> {
    this.epoch++
    this.session = null
    this.lastFailure = null
    try {
      await this.serializeStorage(() => this.store.clearSession())
    } catch {
      this.lastFailure = 'storage'
    }
    this.log('hub.signed-out')
    this.emit()
    return this.status()
  }

  /** A valid access token for the relay, renewed when within a minute of its end. */
  async accessToken(): Promise<string> {
    await this.restore()
    const session = this.requireSession()
    if (session.access && !this.lapsing(session.access)) return session.access.token
    await this.refresh()
    const renewed = this.requireSession()
    if (!renewed.access) throw new AuthError('expired', 'Sign in again.')
    return renewed.access.token
  }

  /** A valid ID token for the enrollment, renewed when within a minute of
   *  its end; a refresh that brings no ID token means a new sign-in. */
  async idToken(): Promise<string> {
    await this.restore()
    const session = this.requireSession()
    if (session.id && !this.lapsing(session.id)) return session.id.token
    await this.refresh()
    const renewed = this.requireSession()
    if (!renewed.id || this.lapsing(renewed.id))
      throw new AuthError('expired', 'Sign in again to pair a machine.')
    return renewed.id.token
  }

  private requireSession(): Session {
    if (!this.session)
      throw new AuthError(this.lastFailure ?? 'expired', 'Sign in with your Antasphere account.')
    return this.session
  }

  private lapsing(token: StoredToken): boolean {
    return token.expiresAt - this.renewAheadMs <= this.now()
  }

  /** One refresh at a time; a second ask joins the first. */
  private refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = this.doRefresh().finally(() => {
        this.refreshing = null
      })
    }
    return this.refreshing
  }

  private async doRefresh(): Promise<void> {
    const session = this.session
    const epoch = this.epoch
    if (!session || !this.hub || !this.issuer) return
    if (!session.refreshToken) {
      await this.endSession('expired')
      throw new AuthError('expired', 'Your sign-in expired.')
    }
    try {
      const tokens = await this.hub.refresh({
        clientId: session.clientId,
        refreshToken: session.refreshToken
      })
      if (this.epoch !== epoch || this.session !== session) {
        this.log('hub.refresh.dropped', { reason: 'epoch' })
        return
      }
      let claims: IdTokenClaims | null = null
      if (tokens.idToken) {
        claims = decodeIdToken(tokens.idToken)
        checkIdToken(claims, {
          issuer: this.issuer.origin,
          clientId: session.clientId,
          now: this.now()
        })
        if (claims.sub !== session.account.subject)
          throw new AuthError('invalid-response', 'The renewed token names another person.')
      }
      await this.serializeStorage(async () => {
        if (this.epoch !== epoch || this.session !== session) return
        // The rotated token is kept before anything else is touched: the hub
        // has already retired the one this refresh presented.
        if (tokens.refreshToken) {
          await this.store.writeRefreshToken(tokens.refreshToken)
          session.refreshToken = tokens.refreshToken
        }
        session.access = {
          token: tokens.accessToken,
          expiresAt: this.accessExpiry(tokens.expiresIn, claims)
        }
        await this.store.writeAccessToken(session.access)
        if (tokens.idToken && claims) {
          session.id = { token: tokens.idToken, expiresAt: claims.exp * 1000 }
          await this.store.writeIdToken(session.id)
        }
      })
      if (this.epoch !== epoch || this.session !== session) return
      this.lastFailure = null
      this.log('hub.refresh.ok', { idToken: tokens.idToken !== null })
      this.emit()
    } catch (error) {
      if (this.epoch !== epoch) {
        this.log('hub.refresh.dropped', { reason: classify(error) })
        return
      }
      const failure = classify(error)
      this.log('hub.refresh.failed', { reason: failure })
      if (failure === 'expired') {
        // invalid_grant: the family is gone on the hub's side; drop it here too.
        await this.endSession('expired')
        throw new AuthError('expired', 'Your sign-in expired. Sign in again.')
      }
      if (failure === 'client-purged') {
        // invalid_client: the hub purged the registration; register again so
        // the next sign-in has a client, and sign the person out, since the
        // tokens belonged to the purged client.
        await this.endSession('client-purged')
        this.clientId = null
        await this.store.clearClient()
        try {
          await this.ensureClient()
        } catch (again) {
          this.log('hub.client.re-register.failed', { reason: classify(again) })
        }
        this.emit()
        throw new AuthError('client-purged', 'The hub forgot this app. Sign in again.')
      }
      // The network's failures keep the session: the tokens may still be good
      // once the hub is reachable again.
      this.lastFailure = failure
      this.emit()
      throw new AuthError(failure, 'The sign-in could not be renewed.')
    }
  }

  private async endSession(failure: AuthFailure): Promise<void> {
    this.session = null
    this.lastFailure = failure
    try {
      await this.serializeStorage(() => this.store.clearSession())
    } catch {
      this.lastFailure = 'storage'
    }
    this.emit()
  }
}
