package com.clave.android

import android.os.Bundle
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTextReplacement
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import com.clave.core.state.LAST_MACHINE_KEY
import java.io.ByteArrayOutputStream
import java.util.regex.Pattern
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assume
import org.junit.Rule
import org.junit.Test
import org.junit.internal.AssumptionViolatedException
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.junit.runners.model.Statement

/** How long an in-app step waits for the app to show what it should. */
private const val STEP_MS = 15_000L

/** How long a step that crosses the browser, the relay or a polling loop waits. */
private const val CROSSING_MS = 60_000L

/** How long the chat waits for the seeded message and for a send to settle. */
private const val CHAT_MS = 30_000L

/** The instrumentation argument prefix every fixture argument carries. */
private const val ARG = "clave.fixture."

/**
 * What the run was told about the fixture, read from the instrumentation's arguments. Only
 * the issuer decides whether the check runs at all; the others are required once it does,
 * except the workspace (the runner's scratch workspace is named "scratch") and the session
 * (by default the echo chat's row, "echo · <folder>").
 */
private class FixtureArguments(arguments: Bundle) {
    val issuer: String? = arguments.getString("${ARG}issuer")?.takeIf { it.isNotBlank() }
    val relay: String = arguments.required("relay")
    val machine: String = arguments.required("machine")
    val workspace: String = arguments.getString("${ARG}workspace")?.takeIf { it.isNotBlank() } ?: "scratch"
    val session: String? = arguments.getString("${ARG}session")?.takeIf { it.isNotBlank() }
    val nonce: String = arguments.required("nonce")

    private fun Bundle.required(key: String): String = getString("$ARG$key")?.takeIf { it.isNotBlank() }
        ?: if (issuer == null) "" else throw IllegalArgumentException("the fixture argument $ARG$key is missing")

    companion object {
        fun read() = FixtureArguments(InstrumentationRegistry.getArguments())
    }
}

/**
 * The outermost rule: without the fixture's issuer the check is skipped by assumption before
 * the activity starts, so a run with no fixture booted reports it skipped, never failed.
 */
private class FixtureBooted : org.junit.rules.TestRule {
    override fun apply(base: Statement, description: Description) = object : Statement() {
        override fun evaluate() {
            Assume.assumeTrue(
                "the fixture arguments are absent: the fixture check runs only with the fixture booted",
                InstrumentationRegistry.getArguments().getString("${ARG}issuer")?.isNotBlank() == true,
            )
            base.evaluate()
        }
    }
}

/**
 * Before the activity starts: the machine a cold launch would open on is forgotten, so the
 * app opens on Machines. Nothing else is touched: a login or a pairing an earlier run of
 * this check left is the device record the runner reads.
 */
private class OpenOnMachines : ExternalResource() {
    override fun before() = runBlocking {
        val app = services(InstrumentationRegistry.getInstrumentation().targetContext)
        val owner = withTimeout(STEP_MS) { app.restoredOwner() }
        owner.kv.remove(LAST_MACHINE_KEY)
    }
}

/**
 * The composed debug app on the emulator against the real fixture on the Mac
 * (`scripts/fixture-env.mjs`: a test OpenID Connect provider, the relay and a Clave daemon
 * with the Echo adapter, reached from the emulator through `adb reverse`): the sign-in moved
 * to the test provider from the developer screen, a sign-in through the system browser, the
 * team relay connected, the machine paired (the runner approves it), the scratch workspace,
 * the echo chat with the seeded message, and an answer sent. It ends signed in and paired:
 * the runner's own check reads the device record this run leaves.
 *
 * The browser is Chrome in a Custom Tab. The provider's authorize endpoint shows no page: it
 * answers 302 to `clave-android://oauth/callback` at once, so what the test may meet in the
 * browser is Chrome's first-run screens on a fresh emulator, Chrome's "open in the app"
 * prompt, and an Android "Open with" chooser; each is pressed when it appears and skipped
 * when it does not. The notification permission the pairing asks for is allowed.
 *
 * To run it, with the fixture booted and approving (`--approve`) and the emulator's ports
 * reversed to the Mac's:
 *
 *     adb -s emulator-5562 reverse tcp:47201 tcp:47201
 *     adb -s emulator-5562 reverse tcp:47202 tcp:47202
 *     adb -s emulator-5562 reverse tcp:47203 tcp:47203
 *     ANDROID_SERIAL=emulator-5562 bash scripts/with-gradle-lock.sh ./gradlew :app:connectedDebugAndroidTest \
 *       -Pandroid.testInstrumentationRunnerArguments.class=com.clave.android.FixtureFlowTest \
 *       -Pandroid.testInstrumentationRunnerArguments.clave.fixture.issuer=http://127.0.0.1:47203 \
 *       -Pandroid.testInstrumentationRunnerArguments.clave.fixture.relay=http://127.0.0.1:47202 \
 *       -Pandroid.testInstrumentationRunnerArguments.clave.fixture.machine=<machineName from fixture.json> \
 *       -Pandroid.testInstrumentationRunnerArguments.clave.fixture.workspace=scratch \
 *       -Pandroid.testInstrumentationRunnerArguments.clave.fixture.nonce=<nonce from fixture.json>
 *
 * `clave.fixture.session` (the echo session's title, matched as a substring) is optional: by
 * default the row whose subtitle reads "echo · " is opened. Without `clave.fixture.issuer`
 * the test is skipped by assumption. An app already signed in (an earlier run) skips the
 * sign-in, and a machine already paired opens on its workspaces without a pairing.
 *
 * On a failure the message carries the screen's texts as UiAutomator reads them (the first
 * 2000 characters, query strings and long token-shaped runs cut out); nothing is written to
 * a file.
 */
@RunWith(AndroidJUnit4::class)
class FixtureFlowTest {
    private val rule = createAndroidComposeRule<MainActivity>()

    @get:Rule
    val chain: RuleChain = RuleChain.outerRule(FixtureBooted()).around(OpenOnMachines()).around(rule)

    private val fixture = FixtureArguments.read()
    private val device: UiDevice = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    private val appPackage: String = InstrumentationRegistry.getInstrumentation().targetContext.packageName
    private val reply = "pong from the phone ${Integer.toHexString((System.nanoTime() and 0xffffff).toInt())}"

    private fun shown(text: String, substring: Boolean = false): Boolean =
        runCatching { rule.onAllNodesWithText(text, substring = substring).fetchSemanticsNodes().isNotEmpty() }.getOrDefault(false)

    private fun waitForText(text: String, substring: Boolean = false, timeoutMs: Long = STEP_MS) =
        rule.waitUntil(timeoutMs) { shown(text, substring) }

    private fun waitForDescription(description: String, timeoutMs: Long = STEP_MS) = rule.waitUntil(timeoutMs) {
        rule.onAllNodesWithContentDescription(description).fetchSemanticsNodes().isNotEmpty()
    }

    /** The header's Back once the screen behind it has finished leaving, so exactly one is on screen. */
    private fun tapBack() {
        rule.waitUntil(STEP_MS) { rule.onAllNodesWithContentDescription("Back").fetchSemanticsNodes().size == 1 }
        rule.onNodeWithContentDescription("Back").performClick()
    }

    private fun SemanticsNodeInteraction.editableText(): String? =
        fetchSemanticsNode().config.getOrNull(SemanticsProperties.EditableText)?.text

    private fun appInFront(): Boolean = device.currentPackageName == appPackage

    /**
     * Presses the first of [buttons] another app (the browser, the chooser, the permission
     * controller) shows over this one; true when one was pressed. Never presses inside the app.
     */
    private fun pressForeign(buttons: List<Pattern>): Boolean {
        if (appInFront()) return false
        for (pattern in buttons) {
            val button = device.findObject(By.text(pattern).enabled(true)) ?: continue
            button.click()
            device.waitForIdle()
            return true
        }
        return false
    }

    @Test
    fun theAppSignsInAtTheTestProviderPairsThroughTheRelayAndAnswersTheEchoChat() = onFailureSayWhatIsOnScreen {
        // 1. Machines; signed out, the sign-in is moved to the test provider from the developer screen.
        rule.waitUntil(STEP_MS) { shown("Sign in with Antasphere") || shown("Signed in with Antasphere") }
        if (!shown("Signed in with Antasphere")) {
            moveSignInToTheTestProvider(fixture.issuer!!)

            // 2. The sign-in through the system browser, back in the app signed in.
            signInThroughTheBrowser()
        }

        // 3. The team relay, and the fixture's machine listed through it.
        rule.waitUntil(STEP_MS) { rule.onAllNodes(hasSetTextAction()).fetchSemanticsNodes().isNotEmpty() }
        rule.onAllNodes(hasSetTextAction()).onFirst().performScrollTo().performTextReplacement(fixture.relay)
        rule.onNodeWithText("Connect to team relay").performScrollTo().performClick()
        waitForText(fixture.machine, timeoutMs = CROSSING_MS)

        // 4. The machine paired (the runner approves), or opened when an earlier run paired it.
        rule.onNodeWithText(fixture.machine).performScrollTo().performClick()
        pairUnlessPaired()

        // 5. The scratch workspace, then the echo chat.
        waitForText(fixture.workspace, timeoutMs = CHAT_MS)
        rule.onNodeWithText(fixture.workspace).performScrollTo().performClick()
        val sessionRow = fixture.session?.let { hasText(it, substring = true) } ?: hasText("echo · ", substring = true, ignoreCase = true)
        rule.waitUntil(CHAT_MS) { rule.onAllNodes(sessionRow).fetchSemanticsNodes().isNotEmpty() }
        rule.onAllNodes(sessionRow).onFirst().performScrollTo().performClick()

        // 6. The chat: the seeded message from the timeline, an answer sent and settled.
        waitForText(fixture.nonce, substring = true, timeoutMs = CHAT_MS)
        waitForDescription("Message")
        rule.onNodeWithContentDescription("Message").performTextInput(reply)
        rule.onNodeWithContentDescription("Send message").performClick()
        // The person's turn, then the echo repeating it: at least the first.
        rule.waitUntil(CHAT_MS) { rule.onAllNodesWithText(reply, substring = true).fetchSemanticsNodes().isNotEmpty() }
        rule.waitUntil(CHAT_MS) { rule.onNodeWithContentDescription("Message").editableText() == "" }

        // 7. Left signed in and paired: the runner reads the device record this run made.
    }

    /** The developer screen's issuer field (the one field there without a description) saved, and back. */
    private fun moveSignInToTheTestProvider(issuer: String) {
        waitForText("Developer connection")
        rule.onNodeWithText("Developer connection").performScrollTo().performClick()
        waitForDescription("Server address")
        val issuerField = hasSetTextAction() and SemanticsMatcher.keyNotDefined(SemanticsProperties.ContentDescription)
        // The screen reads the saved issuer into the field once at start; type after that read.
        rule.waitForIdle()
        rule.waitUntil(STEP_MS) {
            val field = rule.onNode(issuerField)
            if (field.editableText() != issuer) field.performTextReplacement(issuer)
            rule.waitForIdle()
            field.editableText() == issuer
        }
        rule.onNodeWithText("Save").performScrollTo().performClick()
        // "Saving…" while the sign-in is rebuilt on the issuer, "Save" again once it is.
        rule.waitUntil(STEP_MS) { shown("Save") && !shown("Saving…") }
        tapBack()
        rule.waitUntil(STEP_MS) { rule.onAllNodesWithContentDescription("Back").fetchSemanticsNodes().isEmpty() }
        rule.waitUntil(STEP_MS) {
            rule.onAllNodes(hasText("Sign in with Antasphere") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
        }
    }

    /**
     * Taps "Sign in with Antasphere" and drives what the browser shows until the app is in
     * front again saying "Signed in with Antasphere". A tap that never left the app (the
     * sign-in still being rebuilt) is tried once more after ten seconds.
     */
    private fun signInThroughTheBrowser() {
        rule.onNodeWithText("Sign in with Antasphere").performScrollTo().performClick()
        val start = System.currentTimeMillis()
        var left = false
        var retried = false
        while (System.currentTimeMillis() - start < CROSSING_MS) {
            if (appInFront()) {
                if (shown("Signed in with Antasphere")) return
                if (shown("Sign-in could not complete.", substring = true)) {
                    throw AssertionError("the sign-in at the test provider failed")
                }
                if (!left && !retried && System.currentTimeMillis() - start > 10_000 &&
                    rule.onAllNodes(hasText("Sign in with Antasphere") and isEnabled()).fetchSemanticsNodes().isNotEmpty()
                ) {
                    retried = true
                    rule.onNodeWithText("Sign in with Antasphere").performScrollTo().performClick()
                }
            } else {
                left = true
                if (pressForeign(BROWSER_BUTTONS)) continue
            }
            Thread.sleep(500)
        }
        throw AssertionError("not back in the app signed in within ${CROSSING_MS / 1000} s (the browser was ${if (left) "" else "never "}opened)")
    }

    /**
     * The pairing screen until "Paired with", the notification permission allowed when it is
     * asked, then "Open workspaces"; a machine already paired opens on its workspaces instead.
     */
    private fun pairUnlessPaired() {
        val start = System.currentTimeMillis()
        while (System.currentTimeMillis() - start < CROSSING_MS) {
            if (pressForeign(PERMISSION_BUTTONS)) continue
            if (appInFront()) {
                if (shown("Paired with ", substring = true)) break
                if (shown(fixture.workspace) && !shown("Pair with ", substring = true)) return
                if (shown("refused this phone", substring = true) || shown("The request expired", substring = true)) {
                    throw AssertionError("the pairing with ${fixture.machine} ended unapproved (is the runner on --approve?)")
                }
            }
            Thread.sleep(500)
        }
        waitForText("Paired with ", substring = true, timeoutMs = 1_000)
        // The permission is asked as the pairing lands: give it a moment, then open.
        val settle = System.currentTimeMillis()
        while (System.currentTimeMillis() - settle < 3_000) {
            if (!pressForeign(PERMISSION_BUTTONS)) Thread.sleep(300)
        }
        rule.onNodeWithText("Open workspaces").performClick()
    }

    /** Runs [body]; a failure is rethrown with what UiAutomator reads on screen. */
    private fun onFailureSayWhatIsOnScreen(body: () -> Unit) {
        try {
            body()
        } catch (e: AssumptionViolatedException) {
            throw e
        } catch (e: Throwable) {
            throw AssertionError("${e.message ?: e.javaClass.simpleName}\nOn screen (${device.currentPackageName}): ${screenTexts()}", e)
        }
    }

    /** The texts and descriptions of the window hierarchy, in order, kept in memory only. */
    private fun screenTexts(): String = runCatching {
        val out = ByteArrayOutputStream()
        device.dumpWindowHierarchy(out)
        val xml = out.toString(Charsets.UTF_8.name())
        ATTRIBUTE.findAll(xml)
            .map { it.groupValues[1] }
            .filter { it.isNotBlank() }
            .map { it.replace(QUERY, "?…").replace(TOKEN_SHAPED, "…") }
            .joinToString(" | ")
            .take(2000)
    }.getOrElse { "(the hierarchy could not be read: ${it.javaClass.simpleName})" }

    private companion object {
        fun button(vararg words: String): List<Pattern> =
            words.map { Pattern.compile("^\\s*${Pattern.quote(it)}\\s*$", Pattern.CASE_INSENSITIVE) }

        /** Chrome's first-run screens, its prompt to leave for the app, and the system chooser. */
        val BROWSER_BUTTONS = button(
            "Use without an account",
            "Accept & continue",
            "No thanks",
            "No, thanks",
            "Don't allow",
            "Don’t allow",
            "Got it",
            "Continue",
            "Open",
            // The chooser: "Just once" is enabled only once the app is chosen, so it is tried first.
            "Just once",
        ) + Pattern.compile("^\\s*Clave( Debug)?\\s*$")

        /** The notification permission the pairing asks for. */
        val PERMISSION_BUTTONS = button("Allow")

        val ATTRIBUTE = Regex("""(?:text|content-desc)="([^"]*)"""")
        val QUERY = Regex("""\?[^\s|"]*""")
        val TOKEN_SHAPED = Regex("""[A-Za-z0-9_\-.]{32,}""")
    }
}
