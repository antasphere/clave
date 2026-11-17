package com.clave.android

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.clave.android.developer.DevelopmentIssuer
import com.clave.android.fake.FakeMachineServer
import com.clave.core.auth.HubTokenStore
import com.clave.core.auth.StoredAccount
import com.clave.core.auth.StoredClient
import com.clave.core.auth.StoredSession
import com.clave.core.auth.StoredToken
import com.clave.core.devices.Credential
import com.clave.core.devices.EnrollmentRecord
import com.clave.core.devices.machineBaseUrl
import com.clave.core.state.LAST_MACHINE_KEY
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith

private const val WAIT_MS = 15_000L

/** The hub's access token the stand-ins accept on `GET /machines`. */
private const val HUB_TOKEN = "hub-access-multi"

/** Nothing listens there: the sign-in is restored from the store, never asked again. */
private const val ISSUER = "http://127.0.0.1:9"
private const val CLIENT_ID = "client-multi"

/**
 * Before the activity starts: two stand-in machines, each at an address of its own (a Mac's
 * own road and a server's), and an account signed in on a development issuer, restored from
 * the store the way a phone that signed in earlier is. The first address is in the phone's
 * list and both machines are paired (a credential each, on the road of the address that
 * lists it); the second address is added from the Machines screen by the test.
 */
private class TwoAddresses : ExternalResource() {
    val mac = FakeMachineServer("device-a", machineId = "stand-in-a", hubToken = HUB_TOKEN, machineName = "Stand-in Mac")
    val server = FakeMachineServer("device-b", machineId = "stand-in-b", hubToken = HUB_TOKEN, machineName = "Stand-in server")
    private val subject = "multi-${System.nanoTime()}"

    override fun before() = runBlocking {
        val app = services(InstrumentationRegistry.getInstrumentation().targetContext)
        val now = System.currentTimeMillis()
        val tokens = HubTokenStore(app.secure)
        tokens.writeClient(StoredClient(ISSUER, CLIENT_ID, now))
        tokens.writeSession(StoredSession(ISSUER, CLIENT_ID, StoredAccount(subject, "Multi Address", "multi@example.test", true), now))
        tokens.writeAccessToken(StoredToken(HUB_TOKEN, now + 3_600_000))
        DevelopmentIssuer.write(app.kv, ISSUER)
        app.rebuildAuth()
        val owner = withTimeout(WAIT_MS) { app.restoredOwner() }
        check(owner.services.auth.status().account?.subject == subject) { "the stored sign-in was not restored" }
        owner.kv.remove(LAST_MACHINE_KEY)
        owner.services.addAddress(mac.url, "Mac")
        for ((machine, token, name) in listOf(Triple(mac, "device-a", "Stand-in Mac"), Triple(server, "device-b", "Stand-in server"))) {
            val id = if (machine === mac) "stand-in-a" else "stand-in-b"
            owner.services.credentials.set(id, Credential(machineBaseUrl(machine.url, id), token))
            owner.services.records.set(EnrollmentRecord(id, "device-$id", "server-$id", name, now))
        }
    }

    override fun after() = runBlocking {
        val app = services(InstrumentationRegistry.getInstrumentation().targetContext)
        try {
            val owner = withTimeout(WAIT_MS) { app.restoredOwner() }
            for (address in owner.services.addresses()) owner.services.removeAddress(address.url)
            for (id in listOf("stand-in-a", "stand-in-b")) {
                owner.store.disconnect(id)
                owner.services.credentials.remove(id)
                owner.services.records.remove(id)
            }
        } finally {
            val tokens = HubTokenStore(app.secure)
            tokens.clearSession()
            tokens.clearClient()
            DevelopmentIssuer.write(app.kv, "")
            app.rebuildAuth()
            mac.close()
            server.close()
        }
    }
}

/**
 * The phone keeps several machine addresses: with the Mac's address in the list and the
 * Mac then out of reach, a server's address added from Machines lists the server beside the
 * Mac, the Mac's row says its own failure, and the server's chat works on its own
 * credential, at its own address.
 */
@RunWith(AndroidJUnit4::class)
class MultiAddressFlowTest {
    private val addresses = TwoAddresses()
    private val compose = createAndroidComposeRule<MainActivity>()

    @get:Rule
    val chain: RuleChain = RuleChain.outerRule(addresses).around(compose)

    private val rule get() = compose

    private fun waitForText(text: String, substring: Boolean = false) = rule.waitUntil(WAIT_MS) {
        rule.onAllNodesWithText(text, substring = substring).fetchSemanticsNodes().isNotEmpty()
    }

    private fun waitForDescription(description: String) = rule.waitUntil(WAIT_MS) {
        rule.onAllNodesWithContentDescription(description).fetchSemanticsNodes().isNotEmpty()
    }

    @Test
    fun bothAddressesAreListedAndTheSecondChatsWhileTheFirstIsDown() {
        val mac = addresses.mac
        val server = addresses.server

        // 1. Machines: the Mac's address, and the Mac listed through it.
        waitForText("Addresses")
        waitForText("Stand-in Mac")
        assertTrue("the Mac's address was asked with the hub token", mac.requests.any { it.path == "/machines" && it.authorization == "Bearer $HUB_TOKEN" })

        // 2. The Mac goes out of reach; the server's address is added from the form.
        mac.close()
        rule.onNodeWithContentDescription("Machine address").performScrollTo().performTextInput(server.url)
        rule.onNodeWithContentDescription("Address name").performScrollTo().performTextInput("Server")
        rule.onNodeWithText("Add address").performScrollTo().performClick()

        // 3. Both machines are listed together; the Mac's address says its own failure on its row.
        waitForText("Stand-in server")
        waitForText("Showing its last list.", substring = true)
        rule.onAllNodesWithText("Stand-in Mac").assertCountEquals(1)
        rule.onAllNodesWithText("Showing its last list.", substring = true).assertCountEquals(1)

        // 4. The server opens on a tap, its chat reads its past and a send goes through.
        rule.onNodeWithText("Stand-in server").performScrollTo().performClick()
        waitForText("All sessions")
        rule.onNodeWithText("All sessions").performClick()
        waitForText("echo · Scratch · scratch")
        rule.onNodeWithText("Echo chat").performClick()
        waitForText("Hello from the test")
        waitForDescription("Message")
        rule.onNodeWithContentDescription("Message").performTextInput("ping")
        rule.tapSendAtRest(WAIT_MS)
        waitForText("pong")

        // The server was reached at its own road with its own credential, never the Mac's.
        val writes = server.requests.filter { it.method == "POST" && it.path == "/sessions/write" }
        assertEquals("one send is one write on the server: ${writes.map { it.body }}", 1, writes.size)
        assertEquals("ping", JSONObject(writes.single().body).getJSONObject("input").getString("text"))
        assertTrue("every server request went through /m/stand-in-b: ${server.roads}", server.roads.filter { it != "/machines" }.all { it.startsWith("/m/stand-in-b/") })
        val wrong = server.requests.filter { it.path != "/machines" && it.authorization != "Bearer device-b" }
        assertTrue("every server request carried the server's own credential: ${wrong.map { "${it.method} ${it.path}" }}", wrong.isEmpty())
        assertTrue("the server's push said hello with its own credential", server.helloTokens.isNotEmpty() && server.helloTokens.all { it == "device-b" })
        assertTrue("the Mac never received the server's credential", mac.requests.none { it.authorization == "Bearer device-b" })
        assertTrue("the server saw no request it does not serve: ${server.unknownPaths}", server.unknownPaths.isEmpty())
    }
}
