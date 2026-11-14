package com.clave.android

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.clave.android.fake.FakeMachineServer
import com.clave.core.state.LAST_MACHINE_KEY
import com.clave.ui.screens.QUICK_COMPOSER_FIELD
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith

/** The prefix of every machine this test adds, so a leftover of an interrupted run is recognised. */
private const val STAND_IN = "Stand-in "

/** How long a step waits for the app to show what it should. */
private const val WAIT_MS = 15_000L

/**
 * Before the activity starts: the current owner forgets the machine a cold launch would open
 * on, and every machine an interrupted run of this test left behind, so the app opens on
 * Machines and no earlier row can be mistaken for this run's.
 */
private class CleanStart : ExternalResource() {
    override fun before() = runBlocking {
        val app = services(InstrumentationRegistry.getInstrumentation().targetContext)
        val owner = withTimeout(WAIT_MS) { app.restoredOwner() }
        owner.kv.remove(LAST_MACHINE_KEY)
        owner.store.loadMachines()
        for (machine in owner.store.state.value.machines) {
            if (machine.id.startsWith("dev:") && machine.name.startsWith(STAND_IN)) owner.store.removeDeveloperMachine(machine.id)
        }
    }
}

/**
 * The composed debug app on the emulator, driven through its screens against a stand-in
 * machine server in this process ([FakeMachineServer], on the device's loopback): a
 * development machine added by address and token, its workspace, its chat with the past
 * read from the timeline, a message sent and its echo streamed back over the push socket,
 * the waiting permission answered from the Requests screen, and the machine forgotten.
 *
 * The rule it checks: what the person sees at each step is what the server said, every
 * request carried the token typed, a send is one write under an id of the phone's shape,
 * an answer is one resolve naming the request and the option, and the app asked the server
 * for nothing it does not serve.
 */
@RunWith(AndroidJUnit4::class)
class ClaveFlowTest {
    private val rule = createAndroidComposeRule<MainActivity>()

    @get:Rule
    val chain: RuleChain = RuleChain.outerRule(CleanStart()).around(rule)

    private lateinit var server: FakeMachineServer

    private val nonce = Integer.toHexString((System.nanoTime() and 0xffffff).toInt())
    private val machineName = "$STAND_IN$nonce"

    @Before
    fun startServer() {
        server = FakeMachineServer(TOKEN)
    }

    @After
    fun stopServer() {
        server.close()
    }

    private fun waitForText(text: String, substring: Boolean = false) = rule.waitUntil(WAIT_MS) {
        rule.onAllNodesWithText(text, substring = substring).fetchSemanticsNodes().isNotEmpty()
    }

    private fun waitForDescription(description: String) = rule.waitUntil(WAIT_MS) {
        rule.onAllNodesWithContentDescription(description).fetchSemanticsNodes().isNotEmpty()
    }

    private fun waitForRequests(route: String, count: Int) = rule.waitUntil(WAIT_MS) { requests(route).size >= count }

    private fun requests(route: String) = server.requests.filter { "${it.method} ${it.path}" == route }

    /** The header's Back once the screen behind it has finished leaving, so exactly one is on screen. */
    private fun tapBack() {
        rule.waitUntil(WAIT_MS) { rule.onAllNodesWithContentDescription("Back").fetchSemanticsNodes().size == 1 }
        rule.onNodeWithContentDescription("Back").performClick()
    }

    private fun SemanticsNodeInteraction.editableText(): String? =
        fetchSemanticsNode().config.getOrNull(SemanticsProperties.EditableText)?.text

    @Test
    fun aDevelopmentMachineIsAddedChattedWithAnsweredAndForgotten() {
        // 1. Machines, signed out, with the debug build's developer card.
        waitForText("Sign in with Antasphere")
        waitForText("Developer connection")
        rule.onNodeWithText("Developer connection").performScrollTo().performClick()

        // 2. The developer connection: the stand-in's address, its token, this run's name.
        waitForDescription("Server address")
        rule.onNodeWithContentDescription("Server address").performTextInput(server.url)
        rule.onNodeWithContentDescription("Server token").performTextInput(TOKEN)
        rule.onNodeWithContentDescription("Name").performTextReplacement(machineName)
        rule.onNodeWithText("Connect").performClick()
        waitForText(machineName)
        waitForText("Sign in with Antasphere")
        val tried = requests("GET /launch-profiles")
        assertTrue("adding the machine tries the token on GET /launch-profiles; the stand-in saw ${server.requests}", tried.isNotEmpty())
        assertEquals("Bearer $TOKEN", tried.first().authorization)

        // 3. The machine's Home: the request waiting, the echo chat among the recent, in its desktop group.
        rule.onNodeWithText(machineName).performClick()
        waitForText("1 request waiting")
        waitForText("Scratch · Tests")
        waitForText("Work")

        // 4. All sessions, grouped as on the desktop: the echo chat under Tests, by provider, workspace and folder, idle.
        rule.onNodeWithText("All sessions").performClick()
        waitForDescription("Tests, 1")
        waitForText("echo · Scratch · scratch")
        waitForText("Idle")
        rule.onNodeWithText("Echo chat").performClick()

        // 5. The chat: the past from the timeline, the machine in the subtitle, the request waiting.
        waitForText("Hello from the test")
        waitForText("Hello back.")
        waitForText("$machineName · ", substring = true)
        waitForDescription("Requests, 1 pending")
        waitForText("1")
        assertTrue("the chat reads the timeline of s-echo", requests("GET /sessions/timeline").any { it.query?.contains("id=s-echo") == true })
        waitForRequests("GET /sessions/models", 1)
        waitForRequests("GET /sessions/commands", 1)
        assertTrue("the chat reads the models of s-echo", requests("GET /sessions/models").any { it.query?.contains("id=s-echo") == true })
        assertTrue("the chat reads the commands of s-echo", requests("GET /sessions/commands").any { it.query?.contains("id=s-echo") == true })

        // 6. A message sent: one write under the phone's id, its echo and the answer streamed back.
        waitForDescription("Message")
        rule.onNodeWithContentDescription("Message").performTextInput("ping")
        rule.tapSendAtRest(WAIT_MS)
        waitForText("pong")
        rule.waitUntil(WAIT_MS) { rule.onNodeWithContentDescription("Message").editableText() == "" }
        val writes = requests("POST /sessions/write")
        assertEquals("one send is one write: ${writes.map { it.body }}", 1, writes.size)
        val write = JSONObject(writes.single().body)
        assertEquals(FakeMachineServer.SESSION_ID, write.getString("id"))
        val input = write.getJSONObject("input")
        assertEquals("user_message", input.getString("type"))
        assertEquals("ping", input.getString("text"))
        val clientMessageId = input.getString("clientMessageId")
        assertTrue("the phone's id shape, m- and 24 hex: $clientMessageId", Regex("^m-[0-9a-f]{24}$").matches(clientMessageId))
        rule.onAllNodesWithText("ping").assertCountEquals(1)
        rule.onAllNodesWithText("pong").assertCountEquals(1)

        // 7. The requests from the chat's header: the permission, answered Allow.
        rule.onNodeWithContentDescription("Requests, 1 pending").performClick()
        waitForText("Run ./gradlew test")
        waitForText("Allow")
        waitForText("Deny")
        rule.onNodeWithText("Allow").performClick()
        waitForText("Nothing is waiting for you")
        val resolves = requests("POST /requests/resolve")
        assertEquals("one answer is one resolve: ${resolves.map { it.body }}", 1, resolves.size)
        val resolve = JSONObject(resolves.single().body)
        assertEquals(FakeMachineServer.REQUEST_ID, resolve.getString("requestId"))
        assertEquals("permission", resolve.getJSONObject("response").getString("type"))
        assertEquals("allow", resolve.getJSONObject("response").getString("optionId"))

        // 8. Back to Home, then Machines from Settings, and the stand-in forgotten so the next run starts clean.
        tapBack()
        waitForText("Echo chat")
        tapBack()
        waitForText("echo · Scratch · scratch")
        tapBack()
        rule.waitUntil(WAIT_MS) { rule.onAllNodesWithContentDescription("Back").fetchSemanticsNodes().isEmpty() }
        waitForText("All sessions")
        rule.onNodeWithContentDescription("Settings").performClick()
        waitForText("0.0.0-stand-in")
        rule.onNodeWithText("Machines").performClick()
        waitForText("Sign in with Antasphere")
        rule.onNodeWithContentDescription("More about $machineName").performScrollTo().performClick()
        waitForText("Forget this machine")
        rule.onNodeWithText("Forget this machine").performClick()
        rule.waitUntil(WAIT_MS) { rule.onAllNodesWithText(machineName).fetchSemanticsNodes().isEmpty() }

        // The whole run: the token typed on every request and every hello, nothing unknown asked.
        assertTrue("the stand-in saw no request it does not serve: ${server.unknownPaths}", server.unknownPaths.isEmpty())
        val wrongBearer = server.requests.filter { it.authorization != "Bearer $TOKEN" }
        assertTrue("every request carried the token typed: ${wrongBearer.map { "${it.method} ${it.path}" }}", wrongBearer.isEmpty())
        assertTrue("the push socket said hello", server.helloTokens.isNotEmpty())
        assertTrue("every hello carried the token typed", server.helloTokens.all { it == TOKEN })
        assertTrue("the push socket heard no frame it does not know: ${server.unknownFrames}", server.unknownFrames.isEmpty())
    }

    /**
     * The quick composer: from the machine's Home, type and one tap on Send starts a chat in the
     * workspace on the default agent and opens it with the text sent once, through the chat's
     * own send path (one write, the phone's id), its answer streamed back.
     */
    @Test
    fun aNewChatIsOneTapFromHome() {
        waitForText("Developer connection")
        rule.onNodeWithText("Developer connection").performScrollTo().performClick()
        waitForDescription("Server address")
        rule.onNodeWithContentDescription("Server address").performTextInput(server.url)
        rule.onNodeWithContentDescription("Server token").performTextInput(TOKEN)
        rule.onNodeWithContentDescription("Name").performTextReplacement(machineName)
        rule.onNodeWithText("Connect").performClick()
        waitForText(machineName)
        // Back on Machines: the developer form, which also shows the name, has gone.
        waitForText("Sign in with Antasphere")
        rule.onNodeWithText(machineName).performClick()

        // Home: the workspace chip names the stand-in's one workspace, the agent chip the built-in Claude chat.
        waitForDescription("Workspace: Scratch")
        waitForDescription("Agent: Claude (chat)")
        rule.onNodeWithTag(QUICK_COMPOSER_FIELD).performTextInput("ping")
        rule.onNodeWithContentDescription("Send").performClick()

        waitForText("pong")
        // The chat's own composer let go of the text once it was sent.
        rule.waitUntil(WAIT_MS) { rule.onNodeWithContentDescription("Message").editableText() == "" }
        rule.onAllNodesWithText("ping").assertCountEquals(1)
        val starts = requests("POST /sessions/start")
        assertEquals("one tap is one start: ${starts.map { it.body }}", 1, starts.size)
        val start = JSONObject(starts.single().body)
        assertEquals("/tmp/scratch", start.getString("cwd"))
        assertEquals(FakeMachineServer.WORKSPACE_ID, start.getJSONObject("options").getString("workspaceId"))
        assertEquals("claude-chat", start.getJSONObject("options").getString("launchProfileId"))
        val writes = requests("POST /sessions/write")
        assertEquals("the text is sent once: ${writes.map { it.body }}", 1, writes.size)
        assertEquals("ping", JSONObject(writes.single().body).getJSONObject("input").getString("text"))

        // Back from the new chat is Home, its composer empty again.
        tapBack()
        waitForDescription("Workspace: Scratch")
        rule.waitUntil(WAIT_MS) { rule.onNodeWithTag(QUICK_COMPOSER_FIELD).editableText() == "" }
        assertEquals(1, requests("POST /sessions/write").size)

        rule.onNodeWithContentDescription("Settings").performClick()
        rule.onNodeWithText("Machines").performClick()
        waitForText("Sign in with Antasphere")
        rule.onNodeWithContentDescription("More about $machineName").performScrollTo().performClick()
        waitForText("Forget this machine")
        rule.onNodeWithText("Forget this machine").performClick()
        rule.waitUntil(WAIT_MS) { rule.onAllNodesWithText(machineName).fetchSemanticsNodes().isEmpty() }
        assertTrue("the stand-in saw no request it does not serve: ${server.unknownPaths}", server.unknownPaths.isEmpty())
    }

    private companion object {
        const val TOKEN = "test-token"
    }
}
