package com.clave.core.state

import com.clave.core.contract.AgentState
import com.clave.core.contract.ServerEvent
import com.clave.core.contract.ServerEventEnvelope
import com.clave.core.devices.BuildKind
import com.clave.core.transport.ClaveServerClient
import com.clave.core.transport.Credential
import com.clave.core.transport.OkHttpPort
import java.net.InetAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** The shell's reads against a stub server: their answers, an older Mac's refusals, and the events that read again. */
class ShellStoreTest {
    private val paths = CopyOnWriteArrayList<String>()
    private lateinit var server: MockWebServer
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val events = MutableSharedFlow<MachineEvent>(extraBufferCapacity = 64)

    @Volatile private var older = false
    @Volatile private var failing = false
    @Volatile private var overviewGate: CountDownLatch? = null
    @Volatile private var groupName = "Auth"

    private fun handle(request: RecordedRequest): MockResponse {
        val path = request.path.orEmpty()
        paths += path
        if (older) return answer(if (path == "/sidebar/overview") 403 else 404, """{"error":"no"}""")
        if (failing) return answer(500, """{"error":"boom"}""")
        return when (path) {
            "/sidebar/overview" -> {
                overviewGate?.await(5, TimeUnit.SECONDS)
                answer(200, """{"windows":[{"windowKey":"main","displayOrder":["g1"],"groups":[{"id":"g1","name":"$groupName","collapsed":false,"sessionIds":["s1"]}]}]}""")
            }
            "/accounts/claude" -> answer(200, """[{"id":"a1","label":"Work","hasToken":true,"tokenSetAt":1,"tokenExpiresAt":null,"tokenInvalid":false}]""")
            "/accounts/codex" -> answer(200, "[]")
            "/usage/claude/snapshot" -> answer(200, """{"a1":{"windows":[{"key":"k","label":"5-hour","kind":"session","scope":null,"usedPercentage":50,"resetsAt":null,"severity":"normal"}],"fetchedAt":3}}""")
            "/usage/codex/snapshot" -> answer(200, "{}")
            "/server/info" -> answer(200, """{"version":"1.42.0","installRef":null,"upgrade":{"state":"idle"}}""")
            else -> answer(404, "{}")
        }
    }

    private lateinit var shell: ShellStore
    private val reloaded = CopyOnWriteArrayList<String>()

    @Before
    fun start() {
        server = MockWebServer().apply { start(InetAddress.getByName("127.0.0.1"), 0) }
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = handle(request)
        }
        val client = ClaveServerClient(Credential("http://127.0.0.1:${server.port}/", TOKEN), OkHttpPort(OkHttpClient()), BuildKind.Development)
        shell = ShellStore(scope, { client }, events) { reloaded += it }
    }

    @After
    fun stop() {
        scope.cancel()
        server.shutdown()
    }

    private fun m(): MachineShell = shell.state.value["m1"] ?: MachineShell()

    private fun emit(event: ServerEvent, at: Long = 5) {
        events.tryEmit(MachineEvent("m1", ServerEventEnvelope("e", 1, at, event)))
    }

    @Test
    fun aRefreshReadsEveryPart() = runBlocking {
        shell.refresh("m1")
        until { m().serverInfo is ShellRead.Loaded && m().codexUsage is ShellRead.Loaded && m().codexAccounts is ShellRead.Loaded && m().overview is ShellRead.Loaded }
        assertEquals("Auth", m().overview.valueOrNull()!!.windows.single().groups.single().name)
        assertEquals("Work", m().claudeAccounts.valueOrNull()!!.single().label)
        assertEquals("1.42.0", m().serverInfo.valueOrNull()!!.version)
    }

    @Test
    fun anOlderMacIsUnsupportedAndItsEventsAskNothing() = runBlocking {
        older = true
        shell.refresh("m1")
        until { m().overview is ShellRead.Unsupported && m().claudeUsage is ShellRead.Unsupported && m().serverInfo is ShellRead.Unsupported }
        val asked = paths.size
        emit(ServerEvent.Unknown("usage.claude_read"))
        emit(ServerEvent.Unknown("sidebar.layout_changed"))
        delay(200)
        assertEquals(asked, paths.size)
    }

    @Test
    fun aFailedRefreshKeepsWhatWasShown() = runBlocking {
        shell.refreshOverview("m1")
        until { m().overview is ShellRead.Loaded }
        failing = true
        shell.refreshOverview("m1")
        delay(200)
        assertTrue(m().overview is ShellRead.Loaded)
        // Another machine's first read fails visibly.
        shell.refreshLimits("m2")
        until { shell.state.value["m2"]?.claudeUsage is ShellRead.Failed }
    }

    @Test
    fun aLayoutChangeReadsTheGroupsAgainAndABurstIsOneMoreRead() = runBlocking {
        shell.refreshOverview("m1")
        until { m().overview is ShellRead.Loaded }
        val gate = CountDownLatch(1)
        overviewGate = gate
        groupName = "Renamed"
        repeat(5) { emit(ServerEvent.Unknown("sidebar.layout_changed")) }
        delay(200)
        gate.countDown()
        until { m().overview.valueOrNull()?.windows?.single()?.groups?.single()?.name == "Renamed" }
        delay(200)
        // The first read, the one under way when the burst came, and one more after it.
        assertTrue(paths.count { it == "/sidebar/overview" } in 2..3)
    }

    @Test
    fun usageEventsReadTheirProvidersSnapshot() = runBlocking {
        emit(ServerEvent.Unknown("usage.codex_read"))
        until { m().codexUsage is ShellRead.Loaded }
        assertEquals(listOf("/usage/codex/snapshot"), paths.toList())
    }

    @Test
    fun aNewSessionReadsTheSessionsAndTheGroups() = runBlocking {
        emit(ServerEvent.Unknown("session.registered"))
        until { reloaded.isNotEmpty() && m().overview is ShellRead.Loaded }
        assertEquals(listOf("m1"), reloaded.toList())
    }

    @Test
    fun sessionEventsAreTheirActivity() = runBlocking {
        emit(ServerEvent.SessionStateChanged("s1", AgentState.Working), at = 40)
        emit(ServerEvent.SessionTitleChanged("s1", "t"), at = 30)
        emit(ServerEvent.SessionRenamed("s2", "n"), at = 50)
        until { m().activity.size == 2 }
        assertEquals(mapOf("s1" to 40L, "s2" to 50L), m().activity)
    }
}
