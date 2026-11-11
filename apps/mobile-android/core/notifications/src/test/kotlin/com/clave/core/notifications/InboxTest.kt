package com.clave.core.notifications

import com.clave.core.ports.MemoryKeyValueStore
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

private val tap = IncomingResponse(notificationId = "one", date = 1, actionIdentifier = "default", data = null)
private val link = DeepLink.Chat("machine", "session", "")

private class Setup(last: IncomingResponse? = null, respondWith: DeepLink? = link, kv: MemoryKeyValueStore = MemoryKeyValueStore()) {
    val kv = kv
    val navigated = mutableListOf<DeepLink>()
    var handled = 0
    var cleared = 0
    var lastResponse: IncomingResponse? = last
    var onRespond: () -> Unit = {}
    val inbox = NotificationInbox(
        kv = kv,
        lastResponse = { lastResponse },
        clearLastResponse = { cleared++; lastResponse = null },
        respond = { handled++; onRespond(); respondWith },
        navigate = { navigated += it },
    )
}

class InboxTest {
    @Test
    fun `opens the notification conversation on cold launch instead of the last machine`() = runTest {
        val s = Setup(last = tap)
        val state = s.inbox.initialState("old-machine", null)
        assertEquals("Chat", state.routes.last().name)
        assertEquals("session", state.routes.last().params["sessionId"])
        assertEquals(2, state.index)
        s.inbox.ready()
        assertEquals(emptyList<DeepLink>(), s.navigated)
        assertNull(s.kv.get(PENDING_NOTIFICATION_KEY))
        assertEquals(1, s.cleared)
    }

    @Test
    fun `keeps an explicit URL ahead of a stored notification`() = runTest {
        val s = Setup()
        s.kv.set(PENDING_NOTIFICATION_KEY, encodeLink(link))
        val state = s.inbox.initialState("old", "clave-android://chat/url-machine/url-session")
        assertEquals("url-session", state.routes.last().params["sessionId"])
        assertNull(s.kv.get(PENDING_NOTIFICATION_KEY))
    }

    @Test
    fun `an explicit URL of this app wins even when it names nothing this app knows`() = runTest {
        val s = Setup()
        s.kv.set(PENDING_NOTIFICATION_KEY, encodeLink(link))
        val state = s.inbox.initialState("old", "clave-android://party")
        assertEquals("Workspaces", state.routes.last().name)
        assertEquals("old", state.routes.last().params["machineId"])
    }

    @Test
    fun `the pending link survives a cold start, written by a background receiver`() = runTest {
        val kv = MemoryKeyValueStore()
        val first = Setup(kv = kv, respondWith = DeepLink.Requests("m", "r"))
        first.inbox.receive(tap)
        first.inbox.close()
        val second = Setup(kv = kv)
        val state = second.inbox.initialState("old", null)
        assertEquals(com.clave.core.notifications.Route("Requests", mapOf("machineId" to "m", "requestId" to "r")), state.routes.last())
        assertNull(kv.get(PENDING_NOTIFICATION_KEY))
        assertEquals(0, second.handled)
    }

    @Test
    fun `queues a warm response until navigation is ready and handles a duplicated delivery once`() = runTest {
        val s = Setup()
        s.inbox.initialState(null, null)
        listOf(async { s.inbox.receive(tap) }, async { s.inbox.receive(tap) }).awaitAll()
        assertEquals(emptyList<DeepLink>(), s.navigated)
        s.inbox.ready()
        s.inbox.idle()
        assertEquals(listOf<DeepLink>(link), s.navigated)
        assertEquals(1, s.handled)
        assertNull(s.kv.get(PENDING_NOTIFICATION_KEY))
    }

    @Test
    fun `a mounted navigator goes straight to a warm response, another action is a new one`() = runTest {
        val s = Setup()
        s.inbox.ready()
        s.inbox.receive(tap)
        s.inbox.receive(tap.copy(actionIdentifier = ActionIds.allow))
        assertEquals(listOf<DeepLink>(link, link), s.navigated)
        assertEquals(2, s.handled)
    }

    @Test
    fun `keeps at most 64 deliveries in mind`() = runTest {
        val s = Setup()
        s.inbox.ready()
        for (i in 0..64) s.inbox.receive(tap.copy(notificationId = "n-$i"))
        s.inbox.receive(tap.copy(notificationId = "n-64"))
        assertEquals(65, s.handled)
        s.inbox.receive(tap.copy(notificationId = "n-0"))
        assertEquals(66, s.handled)
    }

    @Test
    fun `does not navigate after its owner unmounts during a response`() = runTest {
        val s = Setup()
        s.inbox.ready()
        val pending = async { s.inbox.receive(tap) }
        s.inbox.close()
        pending.await()
        assertEquals(emptyList<DeepLink>(), s.navigated)
        val during = Setup()
        during.inbox.ready()
        during.onRespond = { during.inbox.close() }
        during.inbox.receive(tap)
        assertEquals(emptyList<DeepLink>(), during.navigated)
    }

    @Test
    fun `ignores malformed pending data and never reads another owner store`() = runTest {
        val s = Setup()
        s.kv.set(PENDING_NOTIFICATION_KEY, """{"kind":"chat","machineId":1}""")
        assertEquals("Workspaces", s.inbox.initialState("last", null).routes.last().name)
        val other = Setup()
        s.kv.set(PENDING_NOTIFICATION_KEY, encodeLink(link))
        assertEquals("Machines", other.inbox.initialState(null, null).routes.last().name)
    }

    @Test
    fun `a stored link reads back as itself`() {
        for (l in listOf(link, DeepLink.Requests("m", null), DeepLink.Requests("m", "r"), DeepLink.Workspaces("m"), DeepLink.Machines("Pair again."))) {
            assertEquals(l, pendingLink(encodeLink(l)))
        }
        assertNull(pendingLink("{nope"))
        assertNull(pendingLink(null))
        assertNull(pendingLink("""{"kind":"requests","machineId":"m","requestId":3}"""))
    }
}
