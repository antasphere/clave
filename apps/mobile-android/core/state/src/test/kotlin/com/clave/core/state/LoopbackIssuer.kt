package com.clave.core.state

import com.clave.core.auth.HubSignIn
import com.clave.core.auth.HubTokenStore
import com.clave.core.auth.SignInDeps
import com.clave.core.auth.StoredAccount
import com.clave.core.auth.StoredClient
import com.clave.core.auth.StoredSession
import com.clave.core.auth.StoredToken
import com.clave.core.ports.JvmCrypto
import com.clave.core.ports.MemorySecureStore
import com.clave.core.transport.OkHttpPort
import java.net.InetAddress
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.util.Base64
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest

/**
 * An OpenID provider on the loopback for the owner tests, so a second person can sign in on
 * the same hub login while the first one's work is held: the discovery document, the token
 * endpoint answering for [subject], and the browser step as [openAuthSession], which approves
 * on sight and keeps the request's nonce for the ID token. The phone leaves the signature to
 * the server, so any bytes stand for it.
 */
internal class LoopbackIssuer(private val clock: TestClock) : AutoCloseable {
    private val server = MockWebServer()
    private val http = OkHttpClient()

    /** Whose tokens the next code exchange answers with. */
    @Volatile var subject: String = "sub-a"
    @Volatile private var nonce: String? = null

    val origin: String get() = "http://127.0.0.1:${server.port}"

    init {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.requestUrl!!.encodedPath) {
                "/.well-known/openid-configuration" -> answer(
                    200,
                    """{"issuer":"$origin","authorization_endpoint":"$origin/authorize","token_endpoint":"$origin/token","jwks_uri":"$origin/jwks"}""",
                )
                "/token" -> answer(
                    200,
                    """{"access_token":"access-$subject","token_type":"Bearer","expires_in":3600,"id_token":"${idToken()}","refresh_token":"refresh-$subject"}""",
                )
                else -> answer(404, "{}")
            }
        }
        server.start(InetAddress.getByName("127.0.0.1"), 0)
    }

    val openAuthSession: suspend (String, String) -> String? = { url, redirect ->
        val query = URI(url).rawQuery.split('&').associate {
            it.substringBefore('=') to URLDecoder.decode(it.substringAfter('='), "UTF-8")
        }
        nonce = query["nonce"]
        "$redirect?code=code-$subject&state=${URLEncoder.encode(query.getValue("state"), "UTF-8")}"
    }

    private fun idToken(): String {
        val encoder = Base64.getUrlEncoder().withoutPadding()
        fun part(text: String) = encoder.encodeToString(text.toByteArray(Charsets.UTF_8))
        val now = clock.nowMs / 1000
        val claims = """{"iss":"$origin","sub":"$subject","aud":"$CLIENT_ID","exp":${now + 3600},"iat":$now,"nonce":"$nonce"}"""
        return part("""{"alg":"RS256","typ":"JWT"}""") + "." + part(claims) + "." + part("signature")
    }

    /** A hub login on this issuer restored from the store, as after a boot, for [who]. */
    suspend fun signedIn(who: String): HubSignIn {
        val secure = MemorySecureStore()
        val store = HubTokenStore(secure)
        store.writeClient(StoredClient(origin, CLIENT_ID, 0))
        store.writeSession(StoredSession(origin, CLIENT_ID, StoredAccount(who, null, null, true), 0))
        store.writeAccessToken(StoredToken("access-$who", clock.nowMs + 3_600_000))
        store.writeIdToken(StoredToken("id-$who", clock.nowMs + 3_600_000))
        store.writeRefreshToken("refresh-$who")
        val auth = HubSignIn(SignInDeps(origin, OkHttpPort(http), secure, JvmCrypto, openAuthSession, clock))
        auth.restore()
        check(auth.status().account?.subject == who) { "the restored login is not $who" }
        return auth
    }

    override fun close() {
        server.shutdown()
        http.dispatcher.executorService.shutdown()
        http.connectionPool.evictAll()
    }

    private companion object {
        const val CLIENT_ID = "client-loopback"
    }
}
