package com.clave.core.notifications

import com.clave.core.contract.IdLabel
import com.clave.core.contract.PendingRequest
import com.clave.core.contract.RequestKind
import com.clave.core.contract.RequestResponse
import com.clave.core.contract.RequestSnapshot
import com.clave.core.devices.Credential
import com.clave.core.devices.EnrollmentRecord
import com.clave.core.devices.EnrollmentRecords
import com.clave.core.devices.SecureCredentialStore
import com.clave.core.ports.MemoryKeyValueStore
import com.clave.core.ports.MemorySecureStore
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HandlerTest {
    private fun data(
        actions: List<String> = listOf("allow", "deny"),
        category: String = "permission",
        serverId: String = "server",
        serverName: String = "Fixture",
    ) = buildJsonObject {
        put("category", category)
        put("serverId", serverId)
        put("serverName", serverName)
        put("sessionId", "session")
        put("sessionTitle", "Chat")
        put("requestId", "request")
        put("text", "Run?")
        put("actions", JsonArray(actions.map { JsonPrimitive(it) }))
    }

    private fun incoming(action: String, payload: kotlinx.serialization.json.JsonElement = data()) =
        IncomingResponse(notificationId = "notification-1", date = 1, actionIdentifier = action, data = payload)

    /** The pairing records as the app reads them: "machine" paired with the server "server". */
    private suspend fun paired(): MachineResolver = EnrollmentRecords(MemoryKeyValueStore()).apply {
        set(EnrollmentRecord("machine", "device", "server", "Fixture", 1))
    }.asMachineResolver()

    private suspend fun credentials(): SecureCredentialStore =
        SecureCredentialStore(MemorySecureStore()).apply {
            set("machine", Credential("https://relay.example/m/machine", "fixture-device-session"))
        }

    private fun request(options: List<IdLabel>) =
        PendingRequest(id = "request", sessionId = "session", kind = RequestKind.Permission, description = "Run?", createdAt = 1, options = options)

    @Test
    fun `an unpaired server cannot use another machine credential to answer`() = runTest {
        var called = false
        val store = credentials()
        val result = handleResponse(
            incoming(ActionIds.allow),
            machines = { null },
            credentials = { store.get(it) },
            client = { called = true; error("Must not create a client") },
        )
        assertFalse(called)
        assertTrue(result is HandleResult.Open && result.link is DeepLink.Machines)
    }

    @Test
    fun `answers the paired server through its own device credential`() = runTest {
        val store = credentials()
        val client = FakeSettleClient(list = { RequestSnapshot(1, listOf(request(listOf(IdLabel("allow-once", "Allow"), IdLabel("deny", "Deny"))))) })
        val result = handleResponse(incoming(ActionIds.allow), paired(), { store.get(it) }) { credential ->
            assertEquals("fixture-device-session", credential.bearer)
            client
        }
        assertEquals(HandleResult.Settled, result)
        assertEquals(listOf("request" to RequestResponse.Permission("allow-once")), client.resolved)
    }

    @Test
    fun `the credential is the one of the machine the payload's server id resolves to, never the one its server name would`() = runTest {
        val records = EnrollmentRecords(MemoryKeyValueStore()).apply {
            set(EnrollmentRecord("studio", "device-1", "srv-1", "Studio", 1))
            set(EnrollmentRecord("laptop", "device-2", "srv-2", "Laptop", 2))
        }
        val store = SecureCredentialStore(MemorySecureStore()).apply {
            set("studio", Credential("https://relay.example/m/studio", "studio-session"))
            set("laptop", Credential("https://relay.example/m/laptop", "laptop-session"))
        }
        // The payload's server name happens to be the other server's id; only the id decides.
        val payload = data(serverId = "srv-2", serverName = "srv-1")
        val bearers = mutableListOf<String>()
        val client = FakeSettleClient(list = { RequestSnapshot(1, listOf(request(listOf(IdLabel("allow-once", "Allow"))))) })
        val result = handleResponse(incoming(ActionIds.allow, payload), records.asMachineResolver(), { store.get(it) }) { credential ->
            bearers += credential.bearer
            client
        }
        assertEquals(HandleResult.Settled, result)
        assertEquals(listOf("laptop-session"), bearers)
        assertEquals(listOf("request" to RequestResponse.Permission("allow-once")), client.resolved)
    }

    @Test
    fun `a permanent-only permission opens the app instead of granting it from a notification`() = runTest {
        val store = credentials()
        val client = FakeSettleClient(list = { RequestSnapshot(1, listOf(request(listOf(IdLabel("allow-always", "Always"))))) })
        val result = handleResponse(incoming(ActionIds.allow), paired(), { store.get(it) }) { client }
        assertEquals(emptyList<Any>(), client.resolved)
        assertEquals(HandleResult.Open(DeepLink.Requests("machine", "request")), result)
    }

    @Test
    fun `an offered button that cannot settle a complex question opens its specific request`() = runTest {
        val store = credentials()
        val result = handleResponse(
            incoming(ActionIds.reply, data(actions = listOf("open"), category = "question")),
            paired(),
            { store.get(it) },
        ) { error("An unsupported action must not dispatch") }
        assertEquals(HandleResult.Open(DeepLink.Requests("machine", "request")), result)
    }

    @Test
    fun `a paired machine without its credential asks to pair again`() = runTest {
        val result = handleResponse(incoming(ActionIds.allow), paired(), { null }) { error("no client without a credential") }
        assertEquals(HandleResult.Open(DeepLink.Machines("Pair this phone again.")), result)
    }

    @Test
    fun `a plain tap opens the conversation, a push that is not Clave's is ignored`() = runTest {
        val store = credentials()
        assertEquals(
            HandleResult.Open(DeepLink.Chat("machine", "session", "Chat")),
            handleResponse(incoming(DEFAULT_ACTION_IDENTIFIER), paired(), { store.get(it) }) { error("a tap dispatches nothing") },
        )
        assertEquals(
            HandleResult.Ignored,
            handleResponse(incoming(DEFAULT_ACTION_IDENTIFIER, buildJsonObject { put("foo", 1) }), paired(), { store.get(it) }) { error("nothing") },
        )
    }
}
