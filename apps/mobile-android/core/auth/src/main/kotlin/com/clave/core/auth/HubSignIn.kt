package com.clave.core.auth

import com.clave.core.ports.Clock
import com.clave.core.ports.CryptoPort
import com.clave.core.ports.HttpPort
import com.clave.core.ports.Log
import com.clave.core.ports.NoLog
import com.clave.core.ports.SecureStore
import com.clave.core.ports.SystemClock
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder
import java.util.concurrent.CopyOnWriteArraySet

/*
 * Signing in on the phone with the Antasphere account: Authorization Code with PKCE S256
 * in the platform's authentication session (a Custom Tab), as a state machine driven
 * through an injected [OpenAuthSession], so the whole flow runs under JUnit against a
 * local provider.
 *
 * The flow: the stored registration for this issuer, or a new one (the hub purges an
 * anonymous client unused for thirty days, so a refresh refused as invalid_client
 * registers again at once); a verifier, a state and a nonce; the authorization URL
 * handed to the browser, which comes back with the redirect; the state checked; the code
 * exchanged with the verifier; the ID token checked by shape; the tokens kept. The hub
 * rotates the refresh token on every use with no grace for a public client, so a refresh
 * runs one at a time (a second ask joins the first) and the rotated token is written
 * before the new access token, so a crash in between loses nothing the hub still honours.
 *
 * Renewal is lazy, on use: a phone's process is suspended for hours, and the token is
 * asked for when the app is in front, which is when it matters.
 */

enum class AuthPhase { SignedOut, SigningIn, SignedIn }

enum class AuthFailure(val wire: String) {
    Cancelled("cancelled"),
    Denied("denied"),
    Network("network"),
    Timeout("timeout"),
    InvalidResponse("invalid-response"),
    Registration("registration"),
    Storage("storage"),
    Configuration("configuration"),
    Expired("expired"),
    ClientPurged("client-purged"),
}

data class AuthStatus(
    val phase: AuthPhase,
    val account: StoredAccount?,
    val clientId: String?,
    /** When the verified identity lapses (the ID token's `exp`, in ms); null when signed out. */
    val expiresAt: Long?,
    val renewable: Boolean,
    val issuer: String,
    val lastFailure: AuthFailure?,
)

class AuthError(val failure: AuthFailure, message: String) : Exception(message)

/**
 * Opens the platform's authentication session on `url` and answers the redirect URL it
 * came back with, or null when the person dismissed it. A thrown error is the
 * platform's own failure.
 */
typealias OpenAuthSession = suspend (url: String, redirectUri: String) -> String?

const val RENEW_AHEAD_MS: Long = 60_000

data class SignInDeps(
    /** The raw override, resolved by the issuer rule; null or blank is the hub. */
    val issuer: String?,
    val http: HttpPort,
    val secureStore: SecureStore,
    val crypto: CryptoPort,
    val openAuthSession: OpenAuthSession,
    val clock: Clock = SystemClock,
    /** A renewal runs when a token is within this of its end. */
    val renewAheadMs: Long = RENEW_AHEAD_MS,
    /** One line per boundary event, codes only. */
    val log: Log = NoLog,
    val timeoutMs: Long = REQUEST_TIMEOUT_MS,
)

/**
 * One asynchronous run shared by every caller that arrives while it is in flight. The
 * check and the start happen under a lock, so two callers on two threads still share it.
 */
private class SingleFlight<T> {
    private var current: CompletableDeferred<T>? = null

    /** On success the result is kept for later callers when [keep] is set (a run-once). */
    suspend fun run(keep: Boolean = false, block: suspend () -> T): T {
        val (deferred, owner) = synchronized(this) {
            current?.let { it to false } ?: (CompletableDeferred<T>().also { current = it } to true)
        }
        if (!owner) return deferred.await()
        try {
            val value = block()
            if (!keep) clear(deferred)
            deferred.complete(value)
            return value
        } catch (e: Throwable) {
            clear(deferred)
            deferred.completeExceptionally(e)
            throw e
        }
    }

    private fun clear(deferred: CompletableDeferred<T>) = synchronized(this) {
        if (current === deferred) current = null
    }
}

private class Session(
    val clientId: String,
    val account: StoredAccount,
    val signedInAt: Long,
    @Volatile var access: StoredToken?,
    @Volatile var id: StoredToken?,
    @Volatile var refreshToken: String?,
)

private fun classify(error: Throwable): AuthFailure = when (error) {
    is AuthError -> error.failure
    is HubError -> when (error.kind) {
        HubFailure.Network -> AuthFailure.Network
        HubFailure.Timeout -> AuthFailure.Timeout
        HubFailure.Registration -> AuthFailure.Registration
        HubFailure.InvalidResponse -> AuthFailure.InvalidResponse
        HubFailure.InvalidGrant -> AuthFailure.Expired
        HubFailure.InvalidClient -> AuthFailure.ClientPurged
    }
    else -> AuthFailure.InvalidResponse
}

private fun accountOf(claims: IdTokenClaims, previous: StoredAccount? = null) = StoredAccount(
    subject = claims.sub,
    name = claims.name ?: previous?.name,
    email = claims.email ?: previous?.email,
    emailVerified = if (!claims.email.isNullOrEmpty()) claims.emailVerified == true else previous?.emailVerified ?: false,
)

class HubSignIn(deps: SignInDeps) {
    private val issuer: IssuerConfig?
    private val hub: HubClient?
    private val store = HubTokenStore(deps.secureStore)
    private val crypto = deps.crypto
    private val openAuthSession = deps.openAuthSession
    private val clock = deps.clock
    private val renewAheadMs = deps.renewAheadMs
    private val log = deps.log
    private val lock = Any()
    private val listeners = CopyOnWriteArraySet<(AuthStatus) -> Unit>()

    @Volatile private var session: Session? = null
    @Volatile private var clientId: String? = null
    @Volatile private var lastFailure: AuthFailure? = null
    @Volatile private var signingIn: CompletableDeferred<AuthStatus>? = null

    /** Bumped by every sign-out and new sign-in: an answer from before writes nothing. */
    @Volatile private var epoch = 0
    private val refreshFlight = SingleFlight<Unit>()
    private val restoreFlight = SingleFlight<AuthStatus>()

    /** Every write and clear of the stored login runs one at a time, in order. */
    private val storage = Mutex()

    init {
        when (val resolved = resolveIssuer(deps.issuer)) {
            is IssuerResolution.Ok -> {
                issuer = resolved.config
                hub = HubClient(resolved.config, deps.http, deps.timeoutMs)
            }
            is IssuerResolution.Refused -> {
                issuer = null
                hub = null
                lastFailure = AuthFailure.Configuration
                log.event("hub.config.refused", mapOf("reason" to resolved.reason))
            }
        }
    }

    private val statusState = MutableStateFlow(status())

    /** The status as it changes; the same value [status] answers at each change. */
    val status: StateFlow<AuthStatus> = statusState.asStateFlow()

    fun status(): AuthStatus {
        val current = session
        return AuthStatus(
            phase = when {
                signingIn != null -> AuthPhase.SigningIn
                current != null -> AuthPhase.SignedIn
                else -> AuthPhase.SignedOut
            },
            account = current?.account,
            clientId = clientId,
            expiresAt = current?.id?.expiresAt ?: current?.access?.expiresAt,
            renewable = current?.refreshToken != null,
            issuer = issuer?.origin ?: "",
            lastFailure = lastFailure,
        )
    }

    /** A listener for every change; answers the function that removes it. */
    fun onChange(listener: (AuthStatus) -> Unit): () -> Unit {
        listeners.add(listener)
        return { listeners.remove(listener) }
    }

    private fun emit() {
        val snapshot = status()
        statusState.value = snapshot
        for (listener in listeners) listener(snapshot)
    }

    /**
     * Reads what the store holds at boot: the registration, and the session when it
     * belongs to this issuer and this client. Runs once; never throws.
     */
    suspend fun restore(): AuthStatus = restoreFlight.run(keep = true) { doRestore() }

    private suspend fun doRestore(): AuthStatus {
        val epoch = this.epoch
        val issuer = this.issuer ?: return status()
        try {
            val client = store.readClient()
            if (client != null && client.issuer == issuer.origin) clientId = client.clientId
            // A sign-in that ran before the restore already holds the session.
            if (session != null) return status()
            val stored = store.readSession() ?: return status()
            if (stored.issuer != issuer.origin || stored.clientId != clientId) {
                log.event("hub.session.discarded", mapOf("reason" to "binding"))
                storage.withLock { store.clearSession() }
                return status()
            }
            val restored = Session(
                clientId = stored.clientId,
                account = stored.account,
                signedInAt = stored.signedInAt,
                access = store.readAccessToken(),
                id = store.readIdToken(),
                refreshToken = store.readRefreshToken(),
            )
            if (epoch != this.epoch) return status()
            session = restored
            log.event("hub.session.restored", mapOf("renewable" to (restored.refreshToken != null)))
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            lastFailure = AuthFailure.Storage
            log.event("hub.restore.failed")
        }
        emit()
        return status()
    }

    /** The client id the app registered, registering when there is none. */
    suspend fun ensureClient(): String {
        val hub = this.hub
        val issuer = this.issuer
        if (hub == null || issuer == null) throw AuthError(AuthFailure.Configuration, "The issuer is refused.")
        clientId?.let { return it }
        val stored = store.readClient()
        if (stored != null && stored.issuer == issuer.origin) {
            clientId = stored.clientId
            return stored.clientId
        }
        val registered = hub.register()
        store.writeClient(StoredClient(issuer.origin, registered, clock.now()))
        clientId = registered
        log.event("hub.client.registered")
        return registered
    }

    /** One sign-in at a time: a second ask while one waits on the browser joins it. */
    suspend fun signIn(): AuthStatus {
        val (deferred, owner) = synchronized(lock) {
            signingIn?.let { it to false } ?: (CompletableDeferred<AuthStatus>().also { signingIn = it } to true)
        }
        if (!owner) return deferred.await()
        emit()
        try {
            doSignIn()
        } catch (e: Throwable) {
            synchronized(lock) { if (signingIn === deferred) signingIn = null }
            emit()
            deferred.completeExceptionally(e)
            throw e
        }
        // The flag is cleared before the status is read, so the answer says where the
        // sign-in ended, never that it is still running.
        synchronized(lock) { if (signingIn === deferred) signingIn = null }
        emit()
        val result = status()
        deferred.complete(result)
        return result
    }

    private suspend fun doSignIn() {
        val epoch = synchronized(lock) { ++this.epoch }
        lastFailure = null
        try {
            val hub = this.hub
            val issuer = this.issuer
            if (hub == null || issuer == null) throw AuthError(AuthFailure.Configuration, "The issuer is refused.")
            val clientId = ensureClient()
            val verifier = makeVerifier(crypto)
            val state = randomValue(crypto)
            val nonce = randomValue(crypto)
            val url = hub.authorizationUrl(clientId, challengeOf(verifier, crypto), state, nonce)
            val redirect = openAuthSession(url, REDIRECT_URI)
            if (this.epoch != epoch) throw AuthError(AuthFailure.Cancelled, "The sign-in was replaced.")
            if (redirect == null) throw AuthError(AuthFailure.Cancelled, "The sign-in was dismissed.")
            val code = readCallback(redirect, state, issuer)
            val tokens = hub.exchangeCode(clientId, code, verifier)
            val idToken = tokens.idToken ?: throw AuthError(AuthFailure.InvalidResponse, "No ID token came back.")
            val claims = decodeIdToken(idToken)
            checkIdToken(claims, ExpectedIdToken(issuer.origin, clientId, nonce, clock.now()))
            if (this.epoch != epoch) throw AuthError(AuthFailure.Cancelled, "The sign-in was replaced.")
            val next = Session(
                clientId = clientId,
                account = accountOf(claims),
                signedInAt = clock.now(),
                access = StoredToken(tokens.accessToken, accessExpiry(tokens.expiresIn, claims)),
                id = StoredToken(idToken, claims.exp * 1000),
                refreshToken = tokens.refreshToken,
            )
            storage.withLock { if (this.epoch == epoch) persist(next, issuer) }
            if (this.epoch != epoch) return
            session = next
            lastFailure = null
            log.event("hub.sign-in.ok", mapOf("renewable" to (next.refreshToken != null)))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val failure = classify(e)
            if (this.epoch == epoch) {
                lastFailure = failure
                log.event("hub.sign-in.failed", mapOf("reason" to failure.wire))
            } else {
                log.event("hub.sign-in.dropped", mapOf("reason" to failure.wire))
            }
        }
    }

    /**
     * The code of the redirect the browser came back with: the redirect URI itself,
     * exactly one `state` and the one sent, an `iss` naming this issuer when present,
     * and no error.
     */
    private fun readCallback(redirect: String, state: String, issuer: IssuerConfig): String {
        val url = try {
            URI(redirect)
        } catch (_: URISyntaxException) {
            throw AuthError(AuthFailure.InvalidResponse, "The sign-in came back with no readable address.")
        }
        val back = URI(REDIRECT_URI)
        if (!url.scheme.equals(back.scheme, ignoreCase = true) || url.rawAuthority != back.rawAuthority ||
            url.rawPath != back.rawPath
        ) throw AuthError(AuthFailure.InvalidResponse, "The sign-in came back somewhere else.")
        val params = queryParams(url.rawQuery)
        val states = params.filter { it.first == "state" }
        if (states.size != 1 || states[0].second != state) {
            throw AuthError(AuthFailure.InvalidResponse, "The sign-in came back with another state.")
        }
        val iss = params.firstOrNull { it.first == "iss" }?.second
        if (iss != null && iss != issuer.origin) {
            throw AuthError(AuthFailure.InvalidResponse, "The sign-in came back from another issuer.")
        }
        val error = params.firstOrNull { it.first == "error" }?.second
        if (error != null) {
            if (error == "access_denied") throw AuthError(AuthFailure.Denied, "The sign-in was refused.")
            throw AuthError(AuthFailure.InvalidResponse, "The issuer answered an error.")
        }
        val code = params.firstOrNull { it.first == "code" }?.second
        if (code.isNullOrEmpty()) throw AuthError(AuthFailure.InvalidResponse, "The sign-in came back without a code.")
        return code
    }

    private fun accessExpiry(expiresIn: Long?, claims: IdTokenClaims?): Long {
        val ends = buildList {
            if (expiresIn != null) add(clock.now() + expiresIn * 1000)
            if (claims != null) add(claims.exp * 1000)
        }
        return ends.minOrNull() ?: clock.now()
    }

    /** The refresh token first, so a crash after it loses nothing the hub still honours; then the rest. */
    private suspend fun persist(next: Session, issuer: IssuerConfig) {
        try {
            next.refreshToken?.let { store.writeRefreshToken(it) }
            next.access?.let { store.writeAccessToken(it) }
            next.id?.let { store.writeIdToken(it) }
            store.writeSession(StoredSession(issuer.origin, next.clientId, next.account, next.signedInAt))
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            throw AuthError(AuthFailure.Storage, "The sign-in could not be stored.")
        }
    }

    /** Forgets the login here; the hub's own session is not touched. */
    suspend fun signOut(): AuthStatus {
        synchronized(lock) { epoch++ }
        session = null
        lastFailure = null
        try {
            storage.withLock { store.clearSession() }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            lastFailure = AuthFailure.Storage
        }
        log.event("hub.signed-out")
        emit()
        return status()
    }

    /** A valid access token for the relay, renewed when within [RENEW_AHEAD_MS] of its end. */
    suspend fun accessToken(): String {
        val epoch = this.epoch
        restore()
        assertEpoch(epoch)
        val current = requireSession()
        current.access?.let { if (!lapsing(it)) return it.token }
        refresh()
        assertEpoch(epoch)
        return requireSession().access?.token ?: throw AuthError(AuthFailure.Expired, "Sign in again.")
    }

    /** A valid ID token for the pairing; a refresh that brings no ID token means a new sign-in. */
    suspend fun idToken(): String {
        val epoch = this.epoch
        restore()
        assertEpoch(epoch)
        val current = requireSession()
        current.id?.let { if (!lapsing(it)) return it.token }
        refresh()
        assertEpoch(epoch)
        val renewed = requireSession().id
        if (renewed == null || lapsing(renewed)) throw AuthError(AuthFailure.Expired, "Sign in again to pair a machine.")
        return renewed.token
    }

    /**
     * Captured with an owner's stores: the returned check throws once another account
     * has signed in, so old work cannot start a credential read for the wrong person.
     */
    fun guardAccount(): () -> Unit {
        val epoch = this.epoch
        val subject = session?.account?.subject
        return {
            assertEpoch(epoch)
            if (session?.account?.subject != subject) throw AuthError(AuthFailure.Cancelled, "The account changed.")
        }
    }

    private fun assertEpoch(epoch: Int) {
        if (epoch != this.epoch) throw AuthError(AuthFailure.Cancelled, "The account changed.")
    }

    private fun requireSession(): Session =
        session ?: throw AuthError(lastFailure ?: AuthFailure.Expired, "Sign in with your Antasphere account.")

    private fun lapsing(token: StoredToken): Boolean = token.expiresAt - renewAheadMs <= clock.now()

    /** One refresh at a time; a second ask joins the first. */
    private suspend fun refresh() = refreshFlight.run { doRefresh() }

    private suspend fun doRefresh() {
        val current = session
        val epoch = this.epoch
        val hub = this.hub
        val issuer = this.issuer
        if (current == null || hub == null || issuer == null) return
        val presented = current.refreshToken
        if (presented == null) {
            endSession(AuthFailure.Expired)
            throw AuthError(AuthFailure.Expired, "Your sign-in expired.")
        }
        try {
            val tokens = hub.refresh(current.clientId, presented)
            if (this.epoch != epoch || session !== current) {
                log.event("hub.refresh.dropped", mapOf("reason" to "epoch"))
                return
            }
            var claims: IdTokenClaims? = null
            if (tokens.idToken != null) {
                claims = decodeIdToken(tokens.idToken)
                checkIdToken(claims, ExpectedIdToken(issuer.origin, current.clientId, nonce = null, nowMs = clock.now()))
                if (claims.sub != current.account.subject) {
                    throw AuthError(AuthFailure.InvalidResponse, "The renewed token names another person.")
                }
            }
            storage.withLock {
                if (this.epoch != epoch || session !== current) return@withLock
                // The rotated token is kept before anything else is touched: the hub has
                // already retired the one this refresh presented.
                tokens.refreshToken?.let {
                    store.writeRefreshToken(it)
                    current.refreshToken = it
                }
                val access = StoredToken(tokens.accessToken, accessExpiry(tokens.expiresIn, claims))
                current.access = access
                store.writeAccessToken(access)
                if (tokens.idToken != null && claims != null) {
                    val id = StoredToken(tokens.idToken, claims.exp * 1000)
                    current.id = id
                    store.writeIdToken(id)
                }
            }
            if (this.epoch != epoch || session !== current) return
            lastFailure = null
            log.event("hub.refresh.ok", mapOf("idToken" to (tokens.idToken != null)))
            emit()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val failure = classify(e)
            if (this.epoch != epoch) {
                log.event("hub.refresh.dropped", mapOf("reason" to failure.wire))
                return
            }
            log.event("hub.refresh.failed", mapOf("reason" to failure.wire))
            when (failure) {
                AuthFailure.Expired -> {
                    // invalid_grant: the family is gone on the hub's side; drop it here too.
                    endSession(AuthFailure.Expired)
                    throw AuthError(AuthFailure.Expired, "Your sign-in expired. Sign in again.")
                }
                AuthFailure.ClientPurged -> {
                    // invalid_client: the hub purged the registration. Register again so the
                    // next sign-in has a client, and sign the person out: the tokens
                    // belonged to the purged client.
                    endSession(AuthFailure.ClientPurged)
                    clientId = null
                    store.clearClient()
                    try {
                        ensureClient()
                    } catch (again: CancellationException) {
                        throw again
                    } catch (again: Exception) {
                        log.event("hub.client.re-register.failed", mapOf("reason" to classify(again).wire))
                    }
                    emit()
                    throw AuthError(AuthFailure.ClientPurged, "The hub forgot this app. Sign in again.")
                }
                else -> {
                    // The network's failures keep the session: the tokens may still be good
                    // once the hub is reachable again.
                    lastFailure = failure
                    emit()
                    throw AuthError(failure, "The sign-in could not be renewed.")
                }
            }
        }
    }

    private suspend fun endSession(failure: AuthFailure) {
        session = null
        lastFailure = failure
        try {
            storage.withLock { store.clearSession() }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            lastFailure = AuthFailure.Storage
        }
        emit()
    }
}

/** The decoded name/value pairs of a raw query, in order, repeats kept. */
private fun queryParams(rawQuery: String?): List<Pair<String, String>> {
    if (rawQuery.isNullOrEmpty()) return emptyList()
    return rawQuery.split('&').filter { it.isNotEmpty() }.map { part ->
        val eq = part.indexOf('=')
        val name = if (eq < 0) part else part.substring(0, eq)
        val value = if (eq < 0) "" else part.substring(eq + 1)
        URLDecoder.decode(name, Charsets.UTF_8.name()) to URLDecoder.decode(value, Charsets.UTF_8.name())
    }
}
