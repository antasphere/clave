package com.clave.core.transport

import com.clave.core.contract.Decode
import com.clave.core.contract.DecodeError
import com.clave.core.contract.Encode
import com.clave.core.contract.FileAttachment
import com.clave.core.contract.FileDelivery
import com.clave.core.contract.FileText
import com.clave.core.contract.HistoryPage
import com.clave.core.contract.LaunchProfilePreferencesView
import com.clave.core.contract.RequestResponse
import com.clave.core.contract.RequestSnapshot
import com.clave.core.contract.ResolveOutcome
import com.clave.core.contract.ResolveRequestInput
import com.clave.core.contract.ServerFailure
import com.clave.core.contract.Session
import com.clave.core.contract.SessionCapabilities
import com.clave.core.contract.SessionInfo
import com.clave.core.contract.SessionWriteInput
import com.clave.core.contract.StartSessionInput
import com.clave.core.contract.TimelinePage
import com.clave.core.contract.WorkspaceStateView
import com.clave.core.contract.WriteAnswer
import com.clave.core.contract.WriteStatus
import com.clave.core.contract.toText
import com.clave.core.devices.BuildKind
import com.clave.core.devices.TransportVerdict
import com.clave.core.devices.credentialMayTravelTo
import com.clave.core.ports.HttpFailure
import com.clave.core.ports.HttpPort
import com.clave.core.ports.HttpRequest
import com.clave.core.ports.HttpResponse
import java.math.BigDecimal
import java.net.URLEncoder
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * The phone's client of one Clave server over HTTP, ported from `apps/mobile/src/api/client.ts`
 * and the upload of `apps/mobile/src/attachments/client.ts`. Queries are GETs with the payload
 * in the query string, commands POSTs with a JSON body, every call under `Authorization:
 * Bearer`. The routes are grouped as nested objects, as client.ts groups them:
 * [sessions], [launchProfiles], [workspaces], [requests], [files], [attachments].
 *
 * The answer is read in one order: 401 is [ServerError.Kind.Unauthenticated]; 403 is
 * [ServerError.Kind.Forbidden], the device-session boundary, in the server's own words and
 * never retried; a 422 carries a declared failure; any other non-2xx is a protocol answer;
 * then the body is decoded. There is no retry anywhere in this client: a caller that wants
 * one decides it, and never on a 401 or a 403.
 *
 * The client is given its credential and never stores it; the constructor refuses an address
 * this build does not send a credential to, before any request exists.
 */
public class ClaveServerClient(
    private val credential: Credential,
    private val http: HttpPort,
    build: BuildKind,
    /** The ordinary deadline. */
    private val timeoutMs: Long = DEFAULT_TIMEOUT_MS,
    /** The deadline of a page of history or timeline. */
    private val historyTimeoutMs: Long = HISTORY_TIMEOUT_MS,
    /** The deadline of an upload: five mebibytes over mobile data. */
    private val uploadTimeoutMs: Long = UPLOAD_TIMEOUT_MS,
) {
    public val baseUrl: String = credential.serverUrl.trimEnd('/')

    init {
        val verdict = credentialMayTravelTo(baseUrl, build)
        if (verdict is TransportVerdict.Refused) throw ServerError(ServerError.Kind.Policy, verdict.reason)
    }

    public val sessions: Sessions = Sessions()
    public val launchProfiles: LaunchProfiles = LaunchProfiles()
    public val workspaces: Workspaces = Workspaces()
    public val requests: Requests = Requests()
    public val files: Files = Files()
    public val attachments: Attachments = Attachments()

    public inner class Sessions internal constructor() {
        public suspend fun list(): List<Session> = query("/sessions", emptyList()) { Decode.sessions(it) }

        public suspend fun get(id: String): Session = query("/sessions/by-id", listOf("id" to id)) { Decode.session(it) }

        public suspend fun start(input: StartSessionInput): SessionInfo =
            command("/sessions/start", Encode.startSession(input)) { Decode.sessionInfo(it) }

        public suspend fun stop(id: String) {
            command("/sessions/stop", buildJsonObject { put("id", id) }) { }
        }

        /** A 2xx without a readable acknowledgement is a protocol answer, not a success: the
         *  delivery state must not be guessed. */
        public suspend fun write(id: String, input: SessionWriteInput): WriteAnswer =
            command("/sessions/write", Encode.writeSession(id, input)) { Decode.writeAnswer(it) }

        public suspend fun restart(id: String): SessionInfo =
            command(
                "/sessions/restart",
                buildJsonObject {
                    put("id", id)
                    put("account", JsonObject(emptyMap()))
                },
            ) { Decode.sessionInfo(it) }

        public suspend fun capabilities(id: String): SessionCapabilities =
            query("/sessions/capabilities", listOf("id" to id)) { Decode.sessionCapabilities(it) }

        /** A page of the past ending at [before] (the end when absent); `before: null` in the
         *  answer says there is no page before it. Under the long deadline. */
        public suspend fun history(id: String, before: Long? = null, limit: Int? = null): HistoryPage =
            query(
                "/sessions/history",
                listOf("id" to id, "before" to before?.toString(), "limit" to limit?.toString()),
                historyTimeoutMs,
            ) { Decode.historyPage(it) }

        /** The ordered timeline (docs/mobile-timeline.md): [before] is an exclusive sequence
         *  boundary within the page's generation. Under the long deadline. */
        public suspend fun timeline(id: String, before: Long? = null, limit: Int? = null): TimelinePage =
            query(
                "/sessions/timeline",
                listOf("id" to id, "before" to before?.toString(), "limit" to limit?.toString()),
                historyTimeoutMs,
            ) { Decode.timelinePage(it) }

        /** What the server knows of a write by the id the phone minted. A server without the
         *  route answers 404, a [ServerError.Kind.Protocol] with status 404 the caller reads
         *  as `unknown`. */
        public suspend fun writeStatus(id: String, clientMessageId: String): WriteStatus =
            query("/sessions/writes", listOf("id" to id, "clientMessageId" to clientMessageId)) { Decode.writeStatus(it) }
    }

    public inner class LaunchProfiles internal constructor() {
        public suspend fun list(): LaunchProfilePreferencesView =
            query("/launch-profiles", emptyList()) { Decode.launchProfiles(it) }
    }

    public inner class Workspaces internal constructor() {
        public suspend fun load(): WorkspaceStateView = query("/workspaces", emptyList()) { Decode.workspaceState(it) }
    }

    public inner class Requests internal constructor() {
        public suspend fun list(): RequestSnapshot = query("/requests/pending", emptyList()) { Decode.requestSnapshot(it) }

        public suspend fun resolve(requestId: String, response: RequestResponse): ResolveOutcome =
            command("/requests/resolve", Encode.resolveRequest(ResolveRequestInput(requestId, response))) {
                Decode.resolveOutcome(it)
            }
    }

    public inner class Files internal constructor() {
        /** The text of a file on the server's disk, bounded by [root]. */
        public suspend fun read(root: String, path: String): FileText =
            query("/files/read", listOf("root" to root, "path" to path)) { Decode.fileText(it) }
    }

    public inner class Attachments internal constructor() {
        /**
         * Writes the bytes on the server under the session and answers the record the message
         * then carries. The server keeps the file under the session's folder and checks a
         * picture by its first bytes. A 413 is the server's size bound, read as a refusal.
         */
        public suspend fun prepareUpload(sessionId: String, name: String, base64: String, image: Boolean): FileAttachment {
            val body = buildJsonObject {
                put("sessionId", sessionId)
                put(
                    "source",
                    buildJsonObject {
                        put("kind", "upload")
                        put("name", name)
                        put("base64", base64)
                        put("image", image)
                    },
                )
            }
            return send(
                method = "POST",
                route = PREPARE_PATH,
                pathAndQuery = PREPARE_PATH,
                body = body.toText(),
                timeoutMs = uploadTimeoutMs,
                timeoutMessage = "The upload did not finish within ${secondsOf(uploadTimeoutMs)} s.",
                tooLarge = "The file is larger than the server takes in one upload.",
                decode = ::decodeFileAttachment,
            )
        }
    }

    // ── the wire ──

    private suspend fun <T> query(
        path: String,
        params: List<Pair<String, String?>>,
        timeoutMs: Long = this.timeoutMs,
        decode: (JsonElement) -> T,
    ): T {
        val qs = params
            .filter { it.second != null }
            .joinToString("&") { (key, value) -> "${encode(key)}=${encode(value!!)}" }
        val pathAndQuery = if (qs.isEmpty()) path else "$path?$qs"
        return send("GET", path, pathAndQuery, null, timeoutMs, decode = decode)
    }

    private suspend fun <T> command(path: String, body: JsonElement, decode: (JsonElement) -> T): T =
        send("POST", path, path, body.toText(), timeoutMs, decode = decode)

    private suspend fun <T> send(
        method: String,
        route: String,
        pathAndQuery: String,
        body: String?,
        timeoutMs: Long,
        timeoutMessage: String = "The server did not answer within ${secondsOf(timeoutMs)} s.",
        tooLarge: String? = null,
        decode: (JsonElement) -> T,
    ): T {
        val headers = buildMap {
            put("Authorization", "Bearer ${credential.bearer}")
            put("Accept", "application/json")
            if (body != null) put("Content-Type", "application/json")
        }
        val request = HttpRequest(method, "$baseUrl$pathAndQuery", headers, body, timeoutMs)
        // The port carries the deadline; the coroutine deadline is the same bound for a port
        // that ignores it. Either way the answer is a timeout.
        val response: HttpResponse = try {
            withTimeoutOrNull(timeoutMs) { http.send(request) }
                ?: throw ServerError(ServerError.Kind.Timeout, timeoutMessage)
        } catch (e: ServerError) {
            throw e
        } catch (e: HttpFailure.Timeout) {
            throw ServerError(ServerError.Kind.Timeout, timeoutMessage, cause = e)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw ServerError(ServerError.Kind.Network, "The server could not be reached.", cause = e)
        }
        return read(response, route, tooLarge, decode)
    }

    private fun <T> read(response: HttpResponse, route: String, tooLarge: String?, decode: (JsonElement) -> T): T {
        val status = response.status
        val ok = status in 200..299
        if (status == 401) throw ServerError(ServerError.Kind.Unauthenticated, "The server refused the token.", status)
        if (status == 403) {
            // The scope boundary: the server's sentence when it gave one. Thrown once, here,
            // and nothing in this client sends the request again.
            val message = (parse(response.body) as? JsonObject)?.get("message")
                ?.let { it as? JsonPrimitive }
                ?.takeIf { it.isString && it.content.isNotBlank() }
                ?.content
            throw ServerError(ServerError.Kind.Forbidden, message ?: ServerError.FORBIDDEN_FALLBACK, status)
        }
        var json: JsonElement = JsonNull
        if (response.body.isNotEmpty()) {
            val parsed = parse(response.body)
            if (parsed == null && ok) {
                throw ServerError(ServerError.Kind.Protocol, "The server answered something unreadable.", status)
            }
            json = parsed ?: JsonNull
        }
        if (status == 422) {
            val failure: ServerFailure = try {
                Decode.serverFailure(json)
            } catch (e: DecodeError) {
                throw ServerError(ServerError.Kind.Protocol, "The server refused (422) without a readable reason.", status, cause = e)
            }
            throw ServerError(ServerError.Kind.Refused, failure.message, status, failure)
        }
        if (status == 413 && tooLarge != null) throw ServerError(ServerError.Kind.Refused, tooLarge, status)
        if (!ok) throw ServerError(ServerError.Kind.Protocol, "The server answered $status.", status)
        return try {
            decode(json)
        } catch (e: DecodeError) {
            throw ServerError(
                ServerError.Kind.Protocol,
                "The server's answer to $route does not have the expected shape: ${e.message}",
                status,
                cause = e,
            )
        }
    }

    public companion object {
        public const val DEFAULT_TIMEOUT_MS: Long = 10_000
        public const val HISTORY_TIMEOUT_MS: Long = 60_000
        public const val UPLOAD_TIMEOUT_MS: Long = 60_000
        public const val PREPARE_PATH: String = "/files/attachments/prepare"

        private fun parse(text: String): JsonElement? = try {
            Json.parseToJsonElement(text)
        } catch (_: IllegalArgumentException) {
            null
        }

        /** The query string as URLSearchParams writes it (form encoding). */
        private fun encode(value: String): String = URLEncoder.encode(value, Charsets.UTF_8)

        /** Milliseconds as the TypeScript sentence printed them: 10 s, 0.1 s. */
        internal fun secondsOf(ms: Long): String =
            BigDecimal(ms).divide(BigDecimal(1000)).stripTrailingZeros().toPlainString()

        /** The upload's answer by shape (attachments/client.ts `decodeFileAttachment`): the
         *  contract's Decode keeps its attachment reader private, so the route reads its own. */
        internal fun decodeFileAttachment(value: JsonElement): FileAttachment {
            val o = value as? JsonObject ?: throw DecodeError("attachment", "an object")
            fun str(key: String): String =
                (o[key] as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString && it.content.isNotEmpty() }?.content
                    ?: throw DecodeError("attachment.$key", "a non-empty string")
            fun number(key: String): Long? {
                val p = o[key] as? JsonPrimitive ?: return null
                if (p is JsonNull || p.isString) return null
                val d = p.content.toDoubleOrNull()?.takeIf { it.isFinite() } ?: return null
                return p.content.toLongOrNull() ?: d.toLong()
            }
            val deliveryWire = (o["delivery"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            val delivery = FileDelivery.of(deliveryWire ?: "")
                ?: throw DecodeError("attachment.delivery", "image, reference or folder")
            return FileAttachment(
                id = str("id"),
                path = str("path"),
                name = str("name"),
                mimeType = str("mimeType"),
                size = number("size") ?: throw DecodeError("attachment.size", "a number"),
                delivery = delivery,
                entries = number("entries"),
            )
        }
    }
}
