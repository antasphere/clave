package com.clave.core.state

import com.clave.core.chat.DeliveryMark
import com.clave.core.chat.Reachability
import com.clave.core.chat.SendOutcome
import com.clave.core.contract.AgentState
import com.clave.core.contract.LaunchProfileView
import com.clave.core.contract.LauncherFamily
import com.clave.core.contract.RequestResponse
import com.clave.core.contract.RequestSnapshot
import com.clave.core.contract.ResolveOutcome
import com.clave.core.contract.SpawnOptions
import com.clave.core.contract.StartSessionInput
import com.clave.core.contract.WorkspaceView
import com.clave.core.contract.Encode
import com.clave.core.contract.Decode
import com.clave.core.devices.BuildKind
import com.clave.core.devices.Credential
import com.clave.core.devices.DeveloperMachineSource
import com.clave.core.devices.RelayMachineSource
import com.clave.core.devices.SecureCredentialStore
import com.clave.core.transport.OkHttpPort
import com.clave.core.transport.OkHttpWebSocketFactory
import com.clave.core.transport.PushStatus
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** store.test.ts, against a MockWebServer standing in for the machine, plus the store's
 *  actions the TypeScript suite drove only through the screens. */
class StoreTest {
    private fun harness(
        withDelivery: Boolean = true,
        sleep: (suspend (Long) -> Unit)? = null,
        welcome: Boolean = true,
        block: suspend Harness.() -> Unit,
    ) {
        val h = Harness(withDelivery = withDelivery, sleep = sleep)
        h.machine.welcome = welcome
        try {
            runBlocking { h.start().block() }
        } finally {
            h.close()
        }
    }

    // ── session workspace stamps from the allowed session list ──

    private fun sessionsServer(h: Harness, body: () -> String, status: () -> Int) {
        h.machine.handler = { call ->
            val allowed = call.method == "GET" && call.path == "/sessions"
            if (allowed) answer(status(), if (status() == 200) body() else """{"error":"down"}""")
            else answer(403, """{"error":"refused"}""")
        }
    }

    @Test
    fun `loads a nonempty stamped list without calling the denied records route`() = harness(welcome = false) {
        val list = "[${sessionJson("s1", "authoritative-workspace", "Stamped session")}]"
        sessionsServer(this, { list }, { 200 })
        store.loadSessions(machineId)
        assertEquals(listOf("GET /sessions"), machine.lines())
        assertEquals(Decode.sessions(json(list)), store.state.value.sessions[machineId])
        assertEquals(mapOf("s1" to "authoritative-workspace"), store.state.value.stamps[machineId])
        assertNull(store.state.value.sessionsError[machineId])
    }

    @Test
    fun `replaces moved, removed and cleared stamps with the list in one publication`() = harness(welcome = false) {
        var list = "[${sessionJson("s1", "before")},${sessionJson("removed", "old")},${sessionJson("cleared", "old")}]"
        var status = 200
        sessionsServer(this, { list }, { status })
        store.loadSessions(machineId)
        assertEquals(mapOf("s1" to "before", "removed" to "old", "cleared" to "old"), store.state.value.stamps[machineId])
        val firstList = Decode.sessions(json(list))

        status = 503
        store.loadSessions(machineId)
        assertTrue(store.state.value.sessionsError[machineId]!!.contains("503"))
        // A failed refresh retains the last complete list and its stamps.
        assertEquals(firstList, store.state.value.sessions[machineId])
        assertEquals("before", store.state.value.stamps[machineId]!!["s1"])

        val sibling = Decode.session(json(sessionJson("s1")))
        store.update {
            it.copy(
                sessions = it.sessions + ("sibling" to listOf(sibling)),
                stamps = it.stamps + ("sibling" to mapOf("s1" to "sibling-workspace")),
                sessionsError = it.sessionsError + ("sibling" to "sibling-error"),
            )
        }
        val seen = CopyOnWriteArrayList<StoreState>()
        val watch = CoroutineScope(Dispatchers.Unconfined).launch { store.state.collect { seen += it } }
        try {
            status = 200
            list = "[${sessionJson("s1", "after")},${sessionJson("cleared")}]"
            val next = Decode.sessions(json(list))
            store.loadSessions(machineId)
            val expectedStamps = mapOf("s1" to "after", "cleared" to null)
            assertEquals(expectedStamps, store.state.value.stamps[machineId])
            assertFalse(store.state.value.stamps[machineId]!!.containsKey("removed"))
            // No published state ever pairs the new list with the old stamps or the old error.
            val withNext = seen.filter { it.sessions[machineId] == next }
            assertTrue(withNext.isNotEmpty())
            for (s in withNext) {
                assertEquals(expectedStamps, s.stamps[machineId])
                assertNull(s.sessionsError[machineId])
            }
            assertEquals(listOf(sibling), store.state.value.sessions["sibling"])
            assertEquals(mapOf("s1" to "sibling-workspace"), store.state.value.stamps["sibling"])
            assertEquals("sibling-error", store.state.value.sessionsError["sibling"])

            list = "[]"
            store.loadSessions(machineId)
            assertEquals(emptyList<Any>(), store.state.value.sessions[machineId])
            assertEquals(emptyMap<String, String?>(), store.state.value.stamps[machineId])
            assertEquals(List(4) { "GET /sessions" }, machine.lines())
        } finally {
            watch.cancel()
        }
    }

    // ── the store and the requests ──

    private val pendingJson =
        """{"id":"req-1","sessionId":"s1","kind":"permission","description":"May I?","createdAt":1,"options":[{"id":"approve","label":"Approve"},{"id":"deny","label":"Deny"}]}"""

    /** The requests list and the resolve route, with one request another client may settle first. */
    private class RequestsServer(h: Harness, pendingJson: String) {
        @Volatile var settled = false
        init {
            h.machine.handler = { call ->
                when (call.path) {
                    "/requests/pending" -> answer(200, """{"revision":${if (settled) 2 else 1},"pending":[${if (settled) "" else pendingJson}]}""")
                    "/requests/resolve" -> {
                        // The server's first-valid-answer rule: a settled request answers accepted: false.
                        if (settled) answer(200, """{"accepted":false}""") else {
                            settled = true
                            answer(200, """{"accepted":true}""")
                        }
                    }
                    else -> answer(404, """{"error":"no such route"}""")
                }
            }
        }
    }

    @Test
    fun `a resolution the server refuses is answered accepted false and the request is gone on reload`() = harness(welcome = false) {
        val server = RequestsServer(this, pendingJson)
        store.loadRequests(machineId)
        assertEquals(listOf("req-1"), store.state.value.requests[machineId]!!.snapshot!!.pending.map { it.id })
        // Another client answers first.
        server.settled = true
        val outcome = store.resolveRequest(machineId, "req-1", RequestResponse.Permission("approve"))
        assertEquals(ResolveOutcome(accepted = false), outcome)
        // The resolve reloads the list: the settled request is no longer there.
        until { store.state.value.requests[machineId]?.let { !it.loading && it.snapshot?.pending?.isEmpty() == true } == true }
        assertEquals(1, machine.count("POST /requests/resolve"))
    }

    @Test
    fun `an accepted resolution is answered accepted true`() = harness(welcome = false) {
        RequestsServer(this, pendingJson)
        store.loadRequests(machineId)
        assertEquals(ResolveOutcome(accepted = true), store.resolveRequest(machineId, "req-1", RequestResponse.Permission("approve")))
    }

    @Test
    fun `ignores a stale requests query that arrives after a newer settled snapshot`() = harness(welcome = false) {
        machine.handler = { machine.hold(it) }
        val old = scope.async { store.loadRequests(machineId) }
        until { machine.held.size == 1 }
        val recent = scope.async { store.loadRequests(machineId) }
        until { machine.held.size == 2 }
        machine.respond(1, answer(200, """{"revision":2,"pending":[]}"""))
        recent.await()
        machine.respond(0, answer(200, """{"revision":1,"pending":[{"id":"old","sessionId":"s1","kind":"permission","description":"Settled","createdAt":1}]}"""))
        old.await()
        assertEquals(RequestSnapshot(2, emptyList()), store.state.value.requests[machineId]!!.snapshot)
    }

    @Test
    fun `a server without the requests port is unavailable, not an error`() = harness(welcome = false) {
        machine.handler = {
            answer(422, """{"_tag":"CapabilityUnavailable","message":"This server has no requests port.","capability":"requests"}""")
        }
        store.loadRequests(machineId)
        val requests = store.state.value.requests[machineId]!!
        assertTrue(requests.unavailable)
        assertNull(requests.error)
        assertEquals(RequestSnapshot(0, emptyList()), requests.snapshot)
        assertFalse(requests.loading)
    }

    // ── the start payload and the profile order ──

    private val codexChat = LaunchProfileView(
        id = "codex-chat",
        name = "Codex (chat)",
        family = LauncherFamily.Codex,
        command = listOf("codex"),
        additionalArgs = listOf("--yolo"),
        builtIn = true,
        sourceProfileId = "codex",
    )
    private val scratch = WorkspaceView(id = "ws", name = "scratch", rootDir = "/tmp/scratch", profileFile = null, createdAt = 1)

    @Test
    fun `carries the family boolean, the id, the full definition and the workspace, never an account`() {
        val payload = startPayload(scratch, codexChat)
        assertEquals(
            StartSessionInput(
                cwd = "/tmp/scratch",
                options = SpawnOptions(
                    codexMode = true,
                    launchProfileId = "codex-chat",
                    launchProfile = LaunchProfileView(
                        id = "codex-chat",
                        name = "Codex (chat)",
                        family = LauncherFamily.Codex,
                        command = listOf("codex"),
                        additionalArgs = listOf("--yolo"),
                        sourceProfileId = "codex",
                    ),
                    workspaceId = "ws",
                ),
            ),
            payload,
        )
        assertEquals(
            json(
                """{"cwd":"/tmp/scratch","options":{"codexMode":true,"launchProfileId":"codex-chat","launchProfile":{"id":"codex-chat","name":"Codex (chat)","family":"codex","command":["codex"],"additionalArgs":["--yolo"],"sourceProfileId":"codex"},"workspaceId":"ws"}}""",
            ),
            Encode.startSession(payload),
        )
        assertFalse(Encode.startSession(payload).toString().contains(Regex("claudeProfileId|codexAccountId")))
    }

    @Test
    fun `startSession sends exactly the start payload, then reloads the sessions`() = harness(welcome = false) {
        machine.handler = { call ->
            when (call.path) {
                "/sessions/start" -> answer(200, """{"id":"s9","cwd":"/tmp/scratch","folderName":"scratch","alive":true,"claudeSessionId":null,"piSessionId":null}""")
                "/sessions" -> answer(200, "[${sessionJson("s9")}]")
                else -> answer(404, "{}")
            }
        }
        val info = store.startSession(machineId, scratch, codexChat)
        assertEquals("s9", info.id)
        val start = machine.calls.single { it.path == "/sessions/start" }
        assertEquals(
            json(
                """{"cwd":"/tmp/scratch","options":{"codexMode":true,"launchProfileId":"codex-chat","launchProfile":{"id":"codex-chat","name":"Codex (chat)","family":"codex","command":["codex"],"additionalArgs":["--yolo"],"sourceProfileId":"codex"},"workspaceId":"ws"}}""",
            ),
            json(start.body),
        )
        until { store.state.value.sessions[machineId]?.map { it.id } == listOf("s9") }
    }

    @Test
    fun `lists the chat profiles first, each group by name`() {
        fun p(id: String, name: String, command: String = "claude") =
            LaunchProfileView(id, name, LauncherFamily.Claude, listOf(command), emptyList())
        val ordered = orderProfiles(
            listOf(
                p("custom-b", "Zed terminal"),
                LaunchProfileView("codex-chat", "Codex (chat)", LauncherFamily.Codex, listOf("codex"), emptyList()),
                p("custom-a", "Alpha terminal"),
                p("dev-echo-adapter", "Echo (development)", "echo"),
                p("claude-chat", "Claude (chat)"),
            ),
        )
        assertEquals(listOf("claude-chat", "codex-chat", "dev-echo-adapter", "custom-a", "custom-b"), ordered.map { it.id })
    }

    @Test
    fun `mints an id of 8 to 64 characters`() {
        val id = mintMessageId()
        assertTrue(id.length in 8..64)
        assertTrue(Regex("^m-[0-9a-f]{24}$").matches(id))
        assertNotEquals(id, mintMessageId())
        assertEquals("m-" + "f".repeat(24), mintMessageId { 0.9999999 })
    }

    // ── HTTP write outcomes preserve drafts ──

    @Test
    fun `a pending write retains the draft until the status is accepted, without another write`() {
        var accepted = false
        var sleeps = 0
        lateinit var h: Harness
        val sleep: suspend (Long) -> Unit = { ms ->
            h.clock.nowMs += ms
            sleeps++
            // Asked again while pending: the draft is still the person's, nothing cleared it.
            assertEquals("keep me", h.drafts.get(h.machineId, "s1"))
            if (sleeps == 2) accepted = true
        }
        h = Harness(sleep = sleep)
        h.machine.welcome = false
        try {
            runBlocking {
                h.start()
                var writes = 0
                h.machine.handler = { call ->
                    if (call.path == "/sessions/write") writes++
                    answer(200, """{"status":"${if (call.path == "/sessions/write" || !accepted) "pending" else "accepted"}"}""")
                }
                h.drafts.set(h.machineId, "s1", "keep me")
                val outcome = h.store.send(h.machineId, "s1", "keep me", "message-pending")
                assertTrue(outcome is SendOutcome.Sent)
                assertEquals(1, writes)
                assertEquals(2, sleeps)
                assertEquals("", h.drafts.get(h.machineId, "s1"))
            }
        } finally {
            h.close()
        }
    }

    @Test
    fun `pending for a minute ends unknown and malformed 2xx never clears the draft`() {
        for (body in listOf("""{"status":"pending"}""", "{}")) harness {
            var writes = 0
            machine.handler = { call ->
                if (call.path == "/sessions/write") writes++
                answer(200, if (call.path == "/sessions/write") body else """{"status":"pending"}""")
            }
            drafts.set(machineId, "s1", "keep me")
            val started = clock.nowMs
            val outcome = store.send(machineId, "s1", "keep me", "message-pending")
            assertTrue(outcome is SendOutcome.Unknown)
            assertTrue(clock.nowMs - started >= 60_000)
            assertEquals("keep me", drafts.get(machineId, "s1"))
            assertEquals(1, writes)
        }
    }

    @Test
    fun `an accepted send keeps a draft edited after dispatch`() = harness {
        machine.handler = { call -> if (call.path == "/sessions/write") machine.hold(call) else answer(200, """{"revision":1,"pending":[]}""") }
        drafts.set(machineId, "s1", "first")
        val send = scope.async { store.send(machineId, "s1", "first", "message-first") }
        until { machine.held.size == 1 }
        drafts.set(machineId, "s1", "second")
        machine.respond(0, answer(200, """{"status":"accepted"}"""))
        assertTrue(send.await() is SendOutcome.Sent)
        assertEquals("second", drafts.get(machineId, "s1"))
    }

    @Test
    fun `rejected and unknown writes keep the stored draft`() {
        for (tag in listOf("SessionWriteRefused", "SessionWriteUnknown")) harness {
            machine.handler = { answer(422, """{"_tag":"$tag","message":"Not accepted."}""") }
            drafts.set(machineId, "s1", "keep me")
            val outcome = store.send(machineId, "s1", "keep me", "message-test")
            if (tag == "SessionWriteRefused") assertTrue(outcome is SendOutcome.Rejected) else assertTrue(outcome is SendOutcome.Unknown)
            assertEquals("Not accepted.", (outcome as? SendOutcome.Rejected)?.reason ?: (outcome as SendOutcome.Unknown).reason)
            assertEquals("keep me", drafts.get(machineId, "s1"))
        }
    }

    @Test
    fun `queries authoritative status after gateway and malformed 2xx responses without another send`() {
        val responses = listOf(504 to """{"error":"gateway timeout"}""", 502 to "\"\"", 500 to "{}", 200 to "{}")
        for ((code, body) in responses) for (status in listOf("accepted", "unknown")) harness {
            var writes = 0
            var asks = 0
            machine.handler = { call ->
                when (call.path) {
                    "/sessions/write" -> {
                        writes++
                        answer(code, body)
                    }
                    "/sessions/writes" -> {
                        asks++
                        answer(200, """{"status":"$status"}""")
                    }
                    else -> answer(200, """{"revision":1,"pending":[]}""")
                }
            }
            drafts.set(machineId, "s1", "possibly delivered")
            val outcome = store.send(machineId, "s1", "possibly delivered", "message-gateway")
            if (status == "accepted") assertTrue("$code", outcome is SendOutcome.Sent) else assertTrue("$code", outcome is SendOutcome.Unknown)
            assertEquals(1, writes)
            assertEquals(1, asks)
            assertEquals(if (status == "accepted") "" else "possibly delivered", drafts.get(machineId, "s1"))
        }
    }

    @Test
    fun `a lost answer is reconciled under the minted id, and the draft, the ledger and the mark go`() {
        val h = Harness(mint = { "m-0123456789abcdef01234567" })
        try {
            runBlocking {
                h.start()
                h.machine.handler = { call ->
                    when (call.path) {
                        "/sessions/write" -> answer(504, """{"error":"gateway timeout"}""")
                        "/sessions/writes" -> answer(200, """{"status":"accepted"}""")
                        else -> answer(200, """{"revision":1,"pending":[]}""")
                    }
                }
                h.drafts.set(h.machineId, "s1", "hello")
                val outcome = h.store.send(h.machineId, "s1", "hello")
                assertEquals(SendOutcome.Sent("m-0123456789abcdef01234567", reconciled = true), outcome)
                val write = h.machine.calls.single { it.path == "/sessions/write" }
                assertEquals(
                    json("""{"id":"s1","input":{"type":"user_message","text":"hello","clientMessageId":"m-0123456789abcdef01234567"}}"""),
                    json(write.body),
                )
                assertEquals("m-0123456789abcdef01234567", h.machine.calls.single { it.path == "/sessions/writes" }.query["clientMessageId"])
                assertEquals("", h.drafts.get(h.machineId, "s1"))
                assertEquals(emptyList<Any>(), h.sends.list())
                assertNull(h.marks.get(h.machineId, "s1"))
            }
        } finally {
            h.close()
        }
    }

    @Test
    fun `unknown leaves the draft and the mark and sends nothing by itself`() = harness {
        machine.handler = { call ->
            when (call.path) {
                "/sessions/write" -> answer(504, "{}")
                "/sessions/writes" -> answer(200, """{"status":"unknown","reason":"The server lost track."}""")
                else -> answer(200, """{"revision":1,"pending":[]}""")
            }
        }
        drafts.set(machineId, "s1", "maybe")
        val outcome = store.send(machineId, "s1", "maybe")
        assertTrue(outcome is SendOutcome.Unknown)
        assertEquals("maybe", drafts.get(machineId, "s1"))
        assertEquals(DeliveryMark.Kind.Unknown, marks.get(machineId, "s1")!!.kind)
        assertEquals(listOf(outcome.clientMessageId), sends.list().map { it.clientMessageId })
        // Reloading the open history afterwards writes nothing either.
        store.refreshOpenHistory(machineId)
        assertEquals(1, machine.count("POST /sessions/write"))
        assertEquals(1, machine.calls.count { it.method == "POST" })
    }

    @Test
    fun `nothing to send is refused before any request`() = harness(welcome = false) {
        val outcome = store.send(machineId, "s1", "   ")
        assertTrue(outcome is SendOutcome.Failed)
        assertEquals(emptyList<String>(), machine.lines())
    }

    // ── answers and interrupts ──

    @Test
    fun `answerInChat writes the permission response into the session`() = harness(welcome = false) {
        machine.handler = { answer(200, """{"status":"accepted"}""") }
        val outcome = store.answerInChat(machineId, "s1", "req-1", "approve", mapOf("Which?" to "This one"))
        assertEquals(ActionOutcome(ok = true), outcome)
        assertEquals(
            json("""{"id":"s1","input":{"type":"permission_response","id":"req-1","optionId":"approve","answers":{"Which?":"This one"}}}"""),
            json(machine.calls.single().body),
        )
    }

    @Test
    fun `interrupt writes the interrupt into the session`() = harness(welcome = false) {
        machine.handler = { answer(200, """{"status":"accepted"}""") }
        assertEquals(ActionOutcome(ok = true), store.interrupt(machineId, "s1"))
        assertEquals(json("""{"id":"s1","input":{"type":"interrupt"}}"""), json(machine.calls.single().body))
        machine.handler = { answer(422, """{"_tag":"SessionNotFound","message":"No such session."}""") }
        assertEquals(ActionOutcome(ok = false, error = "No such session."), store.interrupt(machineId, "s1"))
    }

    // ── machines, connections and lists ──

    @Test
    fun `parallel machine reads share one socket and disconnect closes it`() = harness {
        val (a, b) = listOf(scope.async { store.connect(machineId) }, scope.async { store.connect(machineId) }).awaitAll()
        assertSame(a, b)
        until { store.state.value.reachability[machineId] == Reachability.Reachable }
        store.disconnectAll()
        assertEquals(PushStatus.Closed, a.push.status.value.status)
        assertEquals(1, machine.upgrades.get())
    }

    @Test
    fun `a refused token reads as refused, apart from any session`() {
        val h = Harness(machine = FakeMachine(token = "another-token"))
        try {
            runBlocking {
                h.start()
                h.store.connect(h.machineId)
                until { h.store.state.value.reachability[h.machineId] == Reachability.Refused }
            }
        } finally {
            h.close()
        }
    }

    @Test
    fun `lists the relay's machines and the developer's, and reaches a relay machine through its road`() {
        val relay = FakeMachine()
        val http = OkHttpClient()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
        val kv = SyncKv()
        val credentials = SecureCredentialStore(SyncSecure())
        try {
            runBlocking {
                var relayDown = false
                relay.handler = { call ->
                    when (call.rawPath) {
                        "/machines" ->
                            if (relayDown) answer(500, "{}")
                            else answer(200, """{"machines":[{"id":"r1","name":"Relay Mac","platform":"macos","version":"2.4.0","online":true,"lastSeen":5,"direct":[]}]}""")
                        "/launch-profiles" -> answer(200, """{"version":1,"customProfiles":[],"globalDefaults":{},"workspaceOverrides":{}}""")
                        "/m/r1/workspaces" -> answer(
                            200,
                            """{"version":1,"workspaces":[{"id":"w1","name":"Scratch","rootDir":"/tmp/scratch","profileFile":null,"createdAt":1}],"lastActiveWorkspaceId":null,"activeWorkspaceId":null,"pins":[],"pinsMigrated":true,"revision":1,"instance":"i"}""",
                        )
                        else -> answer(404, "{}")
                    }
                }
                val developer = DeveloperMachineSource(kv, credentials, OkHttpPort(http))
                val store = ClaveStore(
                    Services(
                        build = BuildKind.Development,
                        credentials = credentials,
                        relaySource = RelayMachineSource(relay.base, { "hub-access" }, OkHttpPort(http), BuildKind.Development),
                        developerSource = developer,
                        kv = kv,
                        drafts = com.clave.core.chat.Drafts(kv),
                        http = OkHttpPort(http),
                        sockets = OkHttpWebSocketFactory(http),
                        scope = scope,
                    ),
                )
                store.loadMachines()
                assertEquals(listOf("r1"), store.state.value.machines.map { it.id })
                val dev = store.addDeveloperMachine(relay.base, TOKEN, "Dev")
                assertEquals(listOf("r1", dev.id), store.state.value.machines.map { it.id })
                assertEquals(dev.id, store.state.value.mainMachineId)
                assertEquals("Bearer hub-access", relay.server.takeRequest().getHeader("Authorization"))

                credentials.set("r1", Credential("${relay.base}/m/r1", TOKEN))
                store.loadWorkspaces("r1")
                assertEquals(listOf("w1"), store.state.value.workspaces["r1"]!!.map { it.id })
                assertNull(store.state.value.workspacesError["r1"])
                until { relay.upgrades.get() == 1 }

                relayDown = true
                store.loadMachines()
                assertEquals("The relay answered 500.", store.state.value.machinesError)
                assertEquals(listOf(dev.id), store.state.value.machines.map { it.id })

                store.removeDeveloperMachine(dev.id)
                assertEquals(emptyList<String>(), store.state.value.machines.map { it.id })
                assertNull(credentials.get(dev.id))
                store.disconnectAll()
            }
        } finally {
            scope.cancel()
            relay.close()
        }
    }

    @Test
    fun `server events update the sessions, the workspaces and the requests`() = harness {
        machine.handler = { call ->
            when (call.path) {
                "/sessions" -> answer(200, "[${sessionJson("s1")}]")
                "/requests/pending" -> answer(200, """{"revision":1,"pending":[]}""")
                else -> answer(404, "{}")
            }
        }
        store.loadSessions(machineId)
        until { store.state.value.reachability[machineId] == Reachability.Reachable }
        machine.broadcast("""{"_tag":"event","id":"e1","seq":1,"at":1,"event":{"_tag":"session.state_changed","id":"s1","state":"working"}}""")
        until { store.state.value.sessions[machineId]!!.single().state == AgentState.Working }
        machine.broadcast("""{"_tag":"event","id":"e2","seq":2,"at":2,"event":{"_tag":"session.renamed","id":"s1","name":"Renamed"}}""")
        until { store.state.value.sessions[machineId]!!.single().title == "Renamed" }
        machine.broadcast(
            """{"_tag":"event","id":"e3","seq":3,"at":3,"event":{"_tag":"workspaces.state_changed","workspaces":[{"id":"w2","name":"Other","rootDir":"/tmp/o","profileFile":null,"createdAt":2}],"revision":2,"instance":"i"}}""",
        )
        until { store.state.value.workspaces[machineId]?.map { it.id } == listOf("w2") }
        val before = machine.count("GET /requests/pending")
        machine.broadcast("""{"_tag":"event","id":"e4","seq":4,"at":4,"event":{"_tag":"requests.changed","revision":2}}""")
        until { machine.count("GET /requests/pending") > before }
    }

    @Test
    fun `loads the workspaces and the launch profiles of a machine`() = harness(welcome = false) {
        machine.handler = { call ->
            when (call.path) {
                "/workspaces" -> answer(
                    200,
                    """{"version":1,"workspaces":[{"id":"w1","name":"Scratch","rootDir":"/tmp/scratch","profileFile":null,"createdAt":1}],"lastActiveWorkspaceId":null,"activeWorkspaceId":null,"pins":[],"pinsMigrated":true,"revision":1,"instance":"i"}""",
                )
                "/launch-profiles" -> answer(200, """{"version":1,"customProfiles":[],"globalDefaults":{},"workspaceOverrides":{}}""")
                "/files/read" -> answer(200, """{"content":"hello","truncated":false,"size":5,"binary":false}""")
                else -> answer(404, "{}")
            }
        }
        store.loadWorkspaces(machineId)
        store.loadProfiles(machineId)
        assertEquals(listOf("w1"), store.state.value.workspaces[machineId]!!.map { it.id })
        assertEquals(emptyList<Any>(), store.state.value.profiles[machineId]!!.customProfiles)
        assertNull(store.state.value.profilesError[machineId])
        assertEquals("hello", store.readFile(machineId, "/tmp/scratch", "README.md").content)
        assertEquals(mapOf("root" to "/tmp/scratch", "path" to "README.md"), machine.calls.last().query)
    }

    // ── the device-session boundary ──

    @Test
    fun `device session boundary a 403 surfaces the server's sentence once and is never retried`() = harness {
        val sentence = "A phone may not do this."
        machine.handler = { answer(403, """{"_tag":"DeviceScopeForbidden","message":"$sentence"}""") }
        store.connect(machineId)
        until { store.state.value.reachability[machineId] == Reachability.Reachable }
        // The Open status already asked for the requests once.
        until { store.state.value.requests[machineId]?.loading == false }
        assertEquals(sentence, store.state.value.requests[machineId]!!.error)
        assertFalse(store.state.value.requests[machineId]!!.unavailable)

        store.loadWorkspaces(machineId)
        store.loadSessions(machineId)
        store.loadProfiles(machineId)
        drafts.set(machineId, "s1", "hello")
        val sent = store.send(machineId, "s1", "hello")
        val interrupted = store.interrupt(machineId, "s1")

        assertEquals(sentence, store.state.value.workspacesError[machineId])
        assertEquals(sentence, store.state.value.sessionsError[machineId])
        assertEquals(sentence, store.state.value.profilesError[machineId])
        assertEquals(SendOutcome.Failed(sent.clientMessageId, sentence), sent)
        assertEquals(ActionOutcome(ok = false, error = sentence), interrupted)
        // The server saw exactly one request for each route, and never the status route.
        assertEquals(1, machine.count("GET /workspaces"))
        assertEquals(1, machine.count("GET /sessions"))
        assertEquals(1, machine.count("GET /launch-profiles"))
        assertEquals(1, machine.count("GET /requests/pending"))
        assertEquals(2, machine.count("POST /sessions/write"))
        assertEquals(0, machine.count("GET /sessions/writes"))
        // Nothing is in doubt: the ledger and the mark are clear, the draft stays.
        assertEquals(emptyList<Any>(), sends.list())
        assertNull(marks.get(machineId, "s1"))
        assertEquals("hello", drafts.get(machineId, "s1"))
        // No reconnection, no other credential: one socket, still open.
        assertEquals(1, machine.upgrades.get())
        assertEquals(Reachability.Reachable, store.state.value.reachability[machineId])
        for (call in machine.calls) assertTrue(call.body.isEmpty() || !call.body.contains("Bearer"))
    }
}
