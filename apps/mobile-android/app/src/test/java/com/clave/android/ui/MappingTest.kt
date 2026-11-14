package com.clave.android.ui

import com.clave.core.auth.AuthFailure
import com.clave.core.auth.AuthPhase
import com.clave.core.auth.AuthStatus
import com.clave.core.auth.StoredAccount
import com.clave.core.chat.Block
import com.clave.core.chat.Conversation
import com.clave.core.chat.DeliveryMark
import com.clave.core.chat.Entry
import com.clave.core.chat.HistoryCursor
import com.clave.core.chat.Reachability as CoreReachability
import com.clave.core.chat.UnknownSend
import com.clave.core.contract.AgentState
import com.clave.core.contract.LaunchProfilePreferencesView
import com.clave.core.contract.LaunchProfileView
import com.clave.core.contract.LauncherFamily
import com.clave.core.contract.MachinePlatform
import com.clave.core.contract.PendingRequest
import com.clave.core.contract.RequestKind
import com.clave.core.contract.RequestSnapshot
import com.clave.core.contract.Session
import com.clave.core.contract.Transport
import com.clave.core.contract.WorkspaceView
import com.clave.core.devices.BuildKind
import com.clave.core.devices.Machine
import com.clave.core.devices.assertCredentialMayTravelTo
import com.clave.core.notifications.DeepLink
import com.clave.core.notifications.initialLaunchState
import com.clave.core.notifications.toUri
import com.clave.core.state.ConversationState
import com.clave.core.state.RequestsState
import com.clave.core.state.StoreState
import com.clave.core.state.conversationKey
import com.clave.ui.theme.Reachability
import com.clave.ui.theme.SessionStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The mapping from the core's values to the screens' states, built from the core's own types. */
class MappingTest {
    private val now = 1_800_000_000_000L

    private fun machine(id: String, name: String = id, online: Boolean = true) = Machine(
        id = id,
        name = name,
        platform = MachinePlatform.Macos,
        version = "1.2.3",
        online = online,
        lastSeen = null,
        baseUrl = "https://relay.example/m/$id",
        pushUrl = "wss://relay.example/m/$id/push",
    )

    private fun session(
        id: String,
        state: AgentState = AgentState.Idle,
        transport: Transport = Transport.Events,
        createdAt: Long = 0,
        workspaceId: String? = null,
        title: String = id,
    ) = Session(
        id = id,
        provider = "claude",
        transport = transport,
        cwd = "/Users/me/code/$id",
        windowKey = "w",
        workspaceId = workspaceId,
        state = state,
        createdAt = createdAt,
        adapterId = "claude-chat",
        title = title,
    )

    private val workspaces = listOf(
        WorkspaceView("w1", "Parser", "/Users/me/code/parser", null, 0),
        WorkspaceView("w2", "Site", "/Users/me/code/site", null, 0),
    )

    private val signedOut = AuthStatus(
        phase = AuthPhase.SignedOut,
        account = null,
        clientId = null,
        expiresAt = null,
        renewable = false,
        issuer = "https://account.antasphere.com",
        lastFailure = null,
    )

    private fun request(id: String, sessionId: String, kind: RequestKind) =
        PendingRequest(id = id, sessionId = sessionId, kind = kind, description = "Run tests", createdAt = 0)

    private fun requests(vararg pending: PendingRequest) =
        RequestsState(snapshot = RequestSnapshot(1, pending.toList()), unavailable = false, error = null, loading = false)

    // ── sessions ──

    @Test
    fun sessionsListChatsFirstWithTheFiveStatesAndTheFatalErrorFoldedIn() {
        val store = StoreState(
            machines = listOf(machine("m")),
            workspaces = mapOf("m" to workspaces),
            sessions = mapOf(
                "m" to listOf(
                    session("term", AgentState.Working, Transport.Pty, createdAt = 50, workspaceId = "w1"),
                    session("working", AgentState.Working, createdAt = 10, workspaceId = "w1"),
                    session("blocked", AgentState.Blocked, createdAt = 20, workspaceId = "w1"),
                    session("idle", AgentState.Idle, createdAt = 30, workspaceId = "w1"),
                    session("done", AgentState.Done, createdAt = 40, workspaceId = "w1"),
                    session("broken", AgentState.Working, createdAt = 5, workspaceId = "w1"),
                ),
            ),
            stamps = mapOf("m" to mapOf("term" to "w1", "working" to "w1", "blocked" to "w1", "idle" to "w1", "done" to "w1", "broken" to "w1")),
            fatal = mapOf(conversationKey("m", "broken") to "The adapter crashed."),
        )
        val state = sessionsState(store, null, "m", "w1")
        // Without the desktop's groups every session is in the last section, newest first.
        val rows = state.sections!!.single().rows
        assertEquals(listOf("term", "done", "idle", "blocked", "working", "broken"), rows.map { it.session.id })
        assertEquals(
            listOf(SessionStatus.Working, SessionStatus.Finished, SessionStatus.Idle, SessionStatus.Waiting, SessionStatus.Working, SessionStatus.Error),
            rows.map { it.status },
        )
        assertEquals("Parser", state.workspaceName)
        assertEquals(Reachability.Connecting, state.reachability)
    }

    @Test
    fun anUnstampedSessionIsInEveryWorkspaceAndOneStampedElsewhereIsLeftOut() {
        val store = StoreState(
            workspaces = mapOf("m" to workspaces),
            sessions = mapOf("m" to listOf(session("here", workspaceId = "w1"), session("elsewhere", workspaceId = "w2"), session("unstamped"))),
            stamps = mapOf("m" to mapOf("here" to "w1", "elsewhere" to "w2", "unstamped" to null)),
        )
        fun ids(workspaceId: String?) = sessionsState(store, null, "m", workspaceId).sections!!.flatMap { it.rows }.map { it.session.id }.toSet()
        assertEquals(setOf("here", "unstamped"), ids("w1"))
        assertEquals(setOf("elsewhere", "unstamped"), ids("w2"))
        assertEquals(setOf("here", "elsewhere", "unstamped"), ids(null))
    }

    @Test
    fun sessionsAreNullUntilTheFirstAnswer() {
        assertNull(sessionsState(StoreState(), null, "m", "w1").sections)
    }

    // ── machines ──

    @Test
    fun machineRowsSayPairedMainAndTheMeasuredReachabilityElseNone() {
        val store = StoreState(
            machines = listOf(machine("a"), machine("b", online = false), machine("c")),
            mainMachineId = "b",
            reachability = mapOf("a" to CoreReachability.Reachable, "c" to CoreReachability.Refused),
        )
        val account = StoredAccount("sub", "Ada", "ada@example.com", true)
        val auth = signedOut.copy(phase = AuthPhase.SignedIn, account = account)
        val state = machinesState(store, auth, paired = setOf("a", "b"), relayUrl = "https://relay.example", signingOut = false, now = now)
        assertEquals(listOf(true, true, false), state.machines.map { it.paired })
        assertEquals(listOf(false, true, false), state.machines.map { it.main })
        assertEquals(listOf(Reachability.Reachable, null, Reachability.Refused), state.machines.map { it.reachability })
        // Not tried yet: no reachability, so the screen reads the relay's flag off the machine.
        assertFalse(state.machines[1].machine.online)
        assertTrue(state.account.signedIn)
        assertEquals("Ada", state.account.name)
        assertEquals("https://relay.example", state.account.relayUrl)
    }

    @Test
    fun theAccountSaysSigningInAndItsLastFailureByItsWireWord() {
        val state = machinesState(
            StoreState(),
            signedOut.copy(phase = AuthPhase.SigningIn, lastFailure = AuthFailure.Network),
            emptySet(),
            "",
            signingOut = false,
            now = now,
        )
        assertFalse(state.account.signedIn)
        assertTrue(state.account.signingIn)
        assertEquals("network", state.account.lastFailure)
    }

    @Test
    fun aRefusedRelayAddressIsTheMachinesErrorInTheCoresWords() {
        val refused = runCatching { assertCredentialMayTravelTo("http://relay.example", BuildKind.Release) }.exceptionOrNull()!!
        val sentence = relayErrorOf(refused)
        assertEquals("A credential never travels over plain http (relay.example); only https is used.", sentence)
        val store = StoreState(machinesError = "Enter the team relay address to see your machines.")
        assertEquals(sentence, machinesState(store, signedOut, emptySet(), "http://relay.example", false, now, relayError = sentence).error)
        assertEquals(store.machinesError, machinesState(store, signedOut, emptySet(), "", false, now).error)
    }

    // ── launch ──

    private fun profile(id: String, name: String) = LaunchProfileView(id, name, LauncherFamily.Claude, listOf("claude"), emptyList())

    private val prefs = LaunchProfilePreferencesView(
        customProfiles = listOf(profile("t-zed", "Zed terminal"), profile("claude-chat", "Claude chat"), profile("t-alpha", "Alpha terminal"), profile("chat:x", "Beta chat")),
        globalDefaults = emptyMap(),
        workspaceOverrides = emptyMap(),
    )

    @Test
    fun launchReadsTheMainMachinesProfilesWhenListedChatsFirst() {
        val store = StoreState(
            machines = listOf(machine("target", "Laptop"), machine("main", "Studio")),
            mainMachineId = "main",
            workspaces = mapOf("target" to workspaces),
            profiles = mapOf("main" to prefs),
        )
        val state = launchState(store, "target", "w1", starting = "claude-chat", refusal = "No such profile.")
        assertEquals("Studio", state.sourceName)
        assertEquals("Laptop", state.targetName)
        assertEquals("Parser", state.workspaceName)
        // The built-in chats, each saved profile's chat twin, the saved chats, then the terminals by name.
        assertEquals(
            listOf("claude-chat", "codex-chat", "chat:claude:t-zed", "chat:claude:t-alpha", "chat:x", "t-alpha", "t-zed"),
            state.profiles!!.map { it.id },
        )
        assertEquals("claude-chat", state.starting)
        assertEquals("No such profile.", state.refusal)
    }

    @Test
    fun launchReadsTheTargetsOwnProfilesWhenTheMainIsNotListed() {
        val store = StoreState(machines = listOf(machine("target")), mainMachineId = "gone", profiles = mapOf("target" to prefs))
        assertEquals("target", launchSourceOf(store, "target"))
        assertEquals(7, launchState(store, "target", "w1", null, null).profiles!!.size)
    }

    // ── requests ──

    @Test
    fun requestsCountTheMachinesPendingAndTheChatLabelsByKind() {
        val store = StoreState(
            machines = listOf(machine("m")),
            requests = mapOf(
                "m" to requests(
                    request("r1", "s1", RequestKind.Permission),
                    request("r2", "s2", RequestKind.Clarification),
                    request("r3", "s2", RequestKind.Secret),
                ),
            ),
        )
        assertEquals(3, pendingOf(store, "m").size)
        val listed = requestsState(store, "m", busy = setOf("r1"), notices = mapOf("r9" to SETTLED_ELSEWHERE))
        assertEquals(listOf("r1", "r2", "r3"), listed.pending.map { it.id })
        assertFalse(listed.loading)
        assertEquals(setOf("r1"), listed.busy)
        assertEquals(SETTLED_ELSEWHERE, listed.notices["r9"])
        val s1 = chatState(store, "m", "s1", ChatSessionState(), now)
        assertEquals(1, s1.pendingRequests)
        assertEquals("Waiting for your approval", s1.pendingLabel)
        val s2 = chatState(store, "m", "s2", ChatSessionState(), now)
        assertEquals(2, s2.pendingRequests)
        assertEquals("Waiting for your answer", s2.pendingLabel)
        assertNull(chatState(store, "m", "s3", ChatSessionState(), now).pendingLabel)
    }

    @Test
    fun requestsLoadUntilTheFirstAnswer() {
        assertTrue(requestsState(StoreState(), "m", emptySet(), emptyMap()).loading)
        assertEquals(0, pendingOf(StoreState(), "m").size)
    }

    // ── chat ──

    private val transcript = Conversation(
        entries = listOf(
            Entry.User("Fix the parser", final = true, at = 1),
            Entry.Assistant("Looking at it.", final = true, at = 2),
            Entry.Tool(id = "t1", name = "Read", complete = true, at = 3),
            Entry.Tool(id = "t2", name = "Edit", complete = false, at = 4),
            Entry.Assistant("   ", final = true, at = 5),
        ),
        state = AgentState.Working,
    )

    private fun chatStore(conversation: Conversation, cursor: HistoryCursor) = StoreState(
        machines = listOf(machine("m", "Studio")),
        sessions = mapOf("m" to listOf(session("s", AgentState.Idle, title = "Parser fix"))),
        conversations = mapOf(conversationKey("m", "s") to ConversationState(conversation, cursor)),
    )

    @Test
    fun chatGroupsTheTranscriptAndReadsTheCursor() {
        val state = chatState(chatStore(transcript, HistoryCursor(before = 42, loaded = true, loading = true)), "m", "s", ChatSessionState(), now)
        assertEquals(3, state.blocks.size)
        assertTrue(state.blocks[0] is Entry.User)
        assertTrue(state.blocks[1] is Entry.Assistant)
        val tools = state.blocks[2] as Block.ToolGroup
        assertEquals(listOf("t1", "t2"), tools.tools.map { it.id })
        assertTrue(state.working)
        assertEquals(SessionStatus.Working, state.status)
        assertFalse(state.ended)
        assertTrue(state.loaded)
        assertTrue(state.hasOlder)
        assertTrue(state.loadingOlder)
        assertEquals("Parser fix", state.title)
        assertEquals("Studio", state.machineName)
    }

    @Test
    fun chatHasNoOlderPageWhenThePastIsAllHere() {
        val state = chatState(chatStore(transcript, HistoryCursor(before = null, loaded = true, loading = false)), "m", "s", ChatSessionState(), now)
        assertFalse(state.hasOlder)
        assertFalse(state.loadingOlder)
    }

    @Test
    fun chatEndsOnAnExitCodeAndNotOnATurnDone() {
        val loaded = HistoryCursor(before = null, loaded = true, loading = false)
        val exited = chatState(chatStore(transcript.copy(state = AgentState.Ended, exitCode = 1), loaded), "m", "s", ChatSessionState(), now)
        assertTrue(exited.ended)
        assertEquals(1, exited.exitCode)
        assertFalse(exited.working)
        assertEquals(SessionStatus.Finished, exited.status)
        val done = chatState(chatStore(transcript.copy(state = AgentState.Done), loaded), "m", "s", ChatSessionState(), now)
        assertFalse(done.ended)
    }

    @Test
    fun chatShowsTheSessionListsStateUntilTheFirstPage() {
        val state = chatState(chatStore(Conversation(), HistoryCursor(null, loaded = false, loading = false)), "m", "s", ChatSessionState(), now)
        assertFalse(state.loaded)
        assertEquals(SessionStatus.Idle, state.status)
        assertEquals("Chat", chatState(StoreState(), "m", "x", ChatSessionState(), now).title)
        assertEquals("From the link", chatState(StoreState(), "m", "x", ChatSessionState(), now, title = "From the link").title)
    }

    @Test
    fun theUnknownSendIsAChoiceShownOnlyWhileNoSendIsInFlight() {
        val send = UnknownSend("m", "s", "m-0123456789abcdef01234567", "Bump the version", at = 1)
        val mark = DeliveryMark(DeliveryMark.Kind.Unknown, send.clientMessageId, "Delivery has not been confirmed.", 1)
        val chat = ChatSessionState(draft = "Bump the version", unknownSend = send, deliveryMark = mark)
        val idle = chatState(StoreState(), "m", "s", chat, now)
        assertEquals("Bump the version", idle.unknownSend?.text)
        assertEquals("Delivery has not been confirmed.", idle.composer.deliveryMark)
        assertEquals("Bump the version", idle.composer.text)
        val sending = chatState(StoreState(), "m", "s", chat.copy(sending = true), now)
        assertNull(sending.unknownSend)
        assertNull(sending.composer.deliveryMark)
        assertTrue(sending.composer.sending)
        val rejected = chatState(StoreState(), "m", "s", ChatSessionState(deliveryMark = mark.copy(kind = DeliveryMark.Kind.Rejected, reason = "Too long.")), now)
        assertEquals("Not delivered: Too long.", rejected.composer.deliveryMark)
    }

    @Test
    fun theChatsOwnSentenceWinsOverTheConversationsError() {
        val store = StoreState(conversations = mapOf(conversationKey("m", "s") to ConversationState(error = "Snapshot failed.")))
        assertEquals("Snapshot failed.", chatState(store, "m", "s", ChatSessionState(), now).error)
        assertEquals(ATTACH_FAILED, chatState(store, "m", "s", ChatSessionState(error = ATTACH_FAILED), now).error)
    }

    // ── routes ──

    @Test
    fun eachLinkOpensItsRoute() {
        assertEquals("chat/dev%3A127.0.0.1%3A47201/s%201?title=Fix%20it", routeFor(DeepLink.Chat("dev:127.0.0.1:47201", "s 1", "Fix it")))
        assertEquals("chat/m/s", routeFor(DeepLink.Chat("m", "s", "")))
        assertEquals("requests/m?requestId=r1", routeFor(DeepLink.Requests("m", "r1")))
        assertEquals("requests/m", routeFor(DeepLink.Requests("m", null)))
        assertEquals("home/m", routeFor(DeepLink.Workspaces("m")))
        assertEquals(Routes.MACHINES, routeFor(DeepLink.Machines("Studio is not paired with this phone.")))
    }

    @Test
    fun aColdLaunchOpensMachinesThenTheLastMachinesHome() {
        assertEquals(listOf("machines"), routesFor(initialLaunchState(null, null)))
        assertEquals(listOf("machines", "home/m"), routesFor(initialLaunchState("m", null)))
    }

    @Test
    fun aChatRouteCarriesTheMessageToSendOnce() {
        assertEquals("chat/m/s?title=clave&message=Fix%20it%20%26%20ship", Routes.chat("m", "s", "clave", "Fix it & ship"))
        assertEquals("chat/m/s?message=hi", Routes.chat("m", "s", null, "hi"))
        assertEquals("sessions/m", Routes.sessions("m"))
        assertEquals("sessions/m?workspaceId=w%201", Routes.sessions("m", "w 1"))
        assertEquals("settings/dev%3A1", Routes.settings("dev:1"))
        assertEquals("accounts/m", Routes.accounts("m"))
    }

    @Test
    fun aChatLinkOpensOverItsMachinesHome() {
        val link = DeepLink.Chat("m2", "s", "Fix it")
        assertEquals(
            listOf("machines", "home/m2", "chat/m2/s?title=Fix%20it"),
            routesFor(initialLaunchState("m", link.toUri())),
        )
        assertEquals(
            listOf("machines", "home/m", "requests/m?requestId=r1"),
            routesFor(initialLaunchState(null, DeepLink.Requests("m", "r1").toUri())),
        )
    }
}
