package com.clave.android

import com.clave.core.auth.AuthStatus
import com.clave.core.auth.HubSignIn
import com.clave.core.contract.PermissionResponse
import com.clave.core.contract.RequestResponse
import com.clave.core.devices.BuildKind
import com.clave.core.devices.Credential
import com.clave.core.devices.DeveloperMachineSource
import com.clave.core.notifications.CapabilityUnavailableException
import com.clave.core.notifications.HandleResult
import com.clave.core.notifications.IncomingResponse
import com.clave.core.notifications.NotificationInbox
import com.clave.core.notifications.RefusedException
import com.clave.core.notifications.SettleClient
import com.clave.core.notifications.TokenRegistration
import com.clave.core.ports.HttpPort
import com.clave.core.ports.KeyValueStore
import com.clave.core.ports.Log
import com.clave.core.state.ClaveStore
import com.clave.core.state.OwnerServices
import com.clave.core.state.OwnerStores
import com.clave.core.state.Services
import com.clave.core.state.ownerStores
import com.clave.core.transport.ClaveServerClient
import com.clave.core.transport.ServerError
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import com.clave.core.transport.Credential as TransportCredential

/**
 * One account's session on this phone: its namespaced stores, its owner services (relay,
 * pairing, push, sign-out), its store of machines and conversations, and its notification
 * inbox. Everything here is the account's alone: [close] disconnects every machine, stops the
 * inbox and cancels the session's work, and the next account gets a session of its own. A
 * notification is answered only with the credential of the machine its own server resolves
 * to through this account's pairing records.
 */
class OwnerSession private constructor(
    val auth: HubSignIn,
    val key: OwnerKey,
    val stores: OwnerStores,
    val services: OwnerServices,
    val store: ClaveStore,
    /** Where the session's background work runs; cancelled by [close]. */
    val scope: CoroutineScope,
    private val http: HttpPort,
    private val build: BuildKind,
    private val log: Log,
) {
    /** The account's own key-value store (drafts, attachment drafts, the last machine). */
    val kv: KeyValueStore get() = stores.kv

    /** What the core made of each response the inbox handled, read back once by [receive]. */
    private val results = ConcurrentHashMap<IncomingResponse, HandleResult>()

    val inbox: NotificationInbox = NotificationInbox(
        kv = stores.kv,
        lastResponse = { null },
        clearLastResponse = {},
        respond = { response ->
            val result = respond(response)
            results[response] = result
            (result as? HandleResult.Open)?.link
        },
    )

    /**
     * Hands a notification response to the inbox and answers what the core made of it:
     * [HandleResult.Settled] when it was answered in the background, [HandleResult.Open]
     * with the link the inbox now keeps, null when the inbox dropped it as a second delivery.
     */
    suspend fun receive(response: IncomingResponse): HandleResult? {
        inbox.receive(response)
        return results.remove(response)
    }

    private suspend fun respond(response: IncomingResponse): HandleResult = try {
        // The machine and its credential are chosen by the owner's services, from the payload's
        // server id through this account's pairing records (OwnerServices.respond, tested there).
        services.respond(response, ::settleClientOf)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        log.event("notification.respond_failed", mapOf("error" to e::class.simpleName))
        HandleResult.Ignored
    }

    /**
     * The server client as the core's [SettleClient]: the server's `CapabilityUnavailable`
     * refusal becomes [CapabilityUnavailableException] (the in-process server, answered through
     * the write route) and any other declared refusal [RefusedException].
     */
    private fun settleClientOf(credential: Credential): SettleClient {
        val client = ClaveServerClient(TransportCredential(credential.serverUrl, credential.bearer), http, build)
        return object : SettleClient {
            override suspend fun listRequests() = settling { client.requests.list() }

            override suspend fun resolve(requestId: String, response: RequestResponse) =
                settling { client.requests.resolve(requestId, response) }

            override suspend fun writePermissionResponse(sessionId: String, requestId: String, optionId: String) =
                settling { client.sessions.write(sessionId, PermissionResponse(requestId, optionId)) }
        }
    }

    private suspend fun <T> settling(block: suspend () -> T): T = try {
        block()
    } catch (e: ServerError) {
        when {
            e.capabilityUnavailable -> throw CapabilityUnavailableException(e.message ?: "")
            e.kind == ServerError.Kind.Refused -> throw RefusedException(e.message ?: "")
            else -> throw e
        }
    }

    /** Keeps every paired server's push token current, once per signed-in session; outcomes by code. */
    private fun syncPushTokens() {
        scope.launch {
            try {
                val outcomes = services.syncPushTokens()
                log.event(
                    "push.sync",
                    mapOf(
                        "registered" to outcomes.count { it is TokenRegistration.Registered },
                        "unchanged" to outcomes.count { it == TokenRegistration.Unchanged },
                        "unsupported" to outcomes.count { it is TokenRegistration.Unsupported },
                        "failed" to outcomes.count { it is TokenRegistration.Failed },
                    ),
                )
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                log.event("push.sync_failed", mapOf("error" to e::class.simpleName))
            }
        }
    }

    /** The account left: every machine disconnected, the inbox stopped, the work cancelled. */
    fun close() {
        store.disconnectAll()
        inbox.close()
        scope.cancel()
    }

    companion object {
        /** The session of the account [status] names, on the sign-in [auth]. */
        suspend fun open(app: AppServices, auth: HubSignIn, status: AuthStatus): OwnerSession {
            val stores = ownerStores(status, app.kv, app.secure, app.crypto)
            val services = OwnerServices(
                auth = auth,
                stores = stores,
                http = app.http,
                build = app.build,
                device = app.device,
                defaultRelayUrl = "",
                pushTokens = app.tokens,
                permission = app.permission,
            )
            val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
            val store = ClaveStore(
                Services(
                    build = app.build,
                    credentials = services.credentials,
                    relaySource = services.source,
                    developerSource = if (app.build == BuildKind.Development) {
                        DeveloperMachineSource(stores.kv, services.credentials, app.http)
                    } else {
                        null
                    },
                    kv = stores.kv,
                    drafts = services.drafts,
                    http = app.http,
                    sockets = app.sockets,
                    scope = scope,
                    log = app.log,
                    delivery = services.delivery,
                ),
            )
            // What a previous process recorded of its sends' ends and did not finish is finished first,
            // with no server, so no screen reads a stale notice or a delivered draft. A store that fails
            // here leaves the records for the first pass, which finishes them under the machine's lock.
            try {
                services.delivery.finishRecordedEnds()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                app.log.event("delivery.finish_failed", mapOf("error" to e::class.simpleName))
            }
            val session = OwnerSession(auth, ownerKeyOf(status), stores, services, store, scope, app.http, app.build, app.log)
            if (status.account != null) session.syncPushTokens()
            return session
        }
    }
}
