package com.clave.core.state

import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * history-race.test.ts, on a real push socket. The original replaced the push client's
 * barrier and listener with stubs; here the hub acknowledges each subscription itself and
 * the frames travel the socket. A second listener on the same subscription, added after the
 * store's, counts the frames: it runs after the store's for each frame, under the push
 * client's lock, so once it has counted a frame the store has taken it.
 */
class HistoryRaceTest {
    private class Race(val h: Harness) {
        val timeline = AtomicInteger()
        private val seen = AtomicInteger()
        private var counting = false

        init {
            h.machine.handler = { call ->
                if (call.path == "/sessions/timeline") {
                    timeline.incrementAndGet()
                    h.machine.hold(call)
                } else answer(200, """{"revision":1,"pending":[]}""")
            }
        }

        /** Answers the latest timeline request still waiting. */
        fun reply(body: String) {
            val index = h.machine.held.indexOfLast { !it.future.isDone }
            h.machine.respond(index, answer(200, body))
        }

        suspend fun stream(delta: String, sequence: Long, generation: String = "g") {
            if (!counting) {
                counting = true
                h.store.connect("m").push.subscribe("s", { seen.incrementAndGet() })
            }
            val target = seen.get() + 1
            h.machine.broadcast(streamFrame("s", delta, sequence, generation))
            until { seen.get() >= target }
        }

        fun text(): String = h.store.text("m", "s")
    }

    private fun race(block: suspend Race.() -> Unit) {
        val h = Harness()
        try {
            runBlocking { Race(h.start()).block() }
        } finally {
            h.close()
        }
    }

    @Test
    fun `retains identical new deltas during snapshot and deduplicates replay by position`() = race {
        val open = h.scope.async { h.store.openChat("m", "s") }
        until { timeline.get() == 1 }
        stream("a", 1)
        stream("a", 2)
        stream("a", 2)
        reply(page("a"))
        open.await()
        assertEquals("aa", text())
        stream("a", 2)
        stream("a", 3)
        assertEquals("aaa", text())
    }

    @Test
    fun `reopens from a fresh snapshot and refreshes only open histories without sending`() = race {
        var open = h.scope.async { h.store.openChat("m", "s") }
        until { timeline.get() == 1 }
        reply(page("old"))
        val close = open.await()
        close()
        h.store.refreshOpenHistory("m")
        assertEquals(1, timeline.get())
        open = h.scope.async { h.store.openChat("m", "s") }
        until { timeline.get() == 2 }
        reply(page("new", 2))
        open.await()
        assertEquals("new", text())
        val refresh = h.scope.async { h.store.refreshOpenHistory("m") }
        until { timeline.get() == 3 }
        stream("new", 3)
        reply(page("new", 2))
        refresh.await()
        assertEquals("newnew", text())
        assertTrue(h.machine.calls.filter { it.method == "POST" }.isEmpty())
        assertTrue(h.machine.calls.filter { it.path != "/requests/pending" }.all { it.path == "/sessions/timeline" })
    }

    @Test
    fun `takes another snapshot when the generation changes while a response is delayed`() = race {
        val open = h.scope.async { h.store.openChat("m", "s") }
        until { timeline.get() == 1 }
        stream("fresh", 1, "new")
        reply(page("old"))
        until { timeline.get() == 2 }
        reply(page("fresh", 1, "new"))
        open.await()
        assertEquals("fresh", text())
        stream("second", 1, "third")
        until { timeline.get() == 3 }
        reply(page("second", 1, "third"))
        until { text() == "second" }
    }

    @Test
    fun `a missed sequence refreshes rather than silently omitting the missing event`() = race {
        val open = h.scope.async { h.store.openChat("m", "s") }
        until { timeline.get() == 1 }
        reply(page("a"))
        open.await()
        stream("c", 3)
        until { timeline.get() == 2 }
        reply(timelineJson(listOf(Triple("a", 1L, "g"), Triple("b", 2L, "g"), Triple("c", 3L, "g")), "g" to 3L))
        until { text() == "abc" }
    }

    @Test
    fun `openChat waits for the subscription ack before the snapshot and merges the frames buffered meanwhile`() {
        val h = Harness()
        h.machine.holdAcks = { true }
        try {
            runBlocking {
                val r = Race(h.start())
                val open = h.scope.async { h.store.openChat("m", "s") }
                until { h.machine.tags().contains("subscribe") }
                assertEquals(true, h.store.state.value.conversations[conversationKey("m", "s")]?.subscribed)
                r.stream("b", 2)
                // No snapshot while the server has not bound its listeners.
                Thread.sleep(100)
                assertEquals(0, r.timeline.get())
                h.machine.releaseAcks()
                until { r.timeline.get() == 1 }
                r.reply(page("a"))
                open.await()
                assertEquals("ab", r.text())
            }
        } finally {
            h.close()
        }
    }

    @Test
    fun `an exit code is applied and kept across a fresh snapshot`() = race {
        val open = h.scope.async { h.store.openChat("m", "s") }
        until { timeline.get() == 1 }
        reply(page("a"))
        open.await()
        h.machine.broadcast("""{"_tag":"exit","sessionId":"s","code":3}""")
        until { h.store.state.value.conversations[conversationKey("m", "s")]?.conversation?.exitCode == 3 }
        val refresh = h.scope.async { h.store.refreshOpenHistory("m") }
        until { timeline.get() == 2 }
        reply(page("a"))
        refresh.await()
        assertEquals(3, h.store.state.value.conversations[conversationKey("m", "s")]!!.conversation.exitCode)
    }

    @Test
    fun `loadOlder puts the page before in front, and a page of another generation takes a fresh snapshot`() = race {
        val open = h.scope.async { h.store.openChat("m", "s") }
        until { timeline.get() == 1 }
        reply(page("six", 6, before = 6))
        open.await()
        assertEquals(6L, h.store.state.value.conversations[conversationKey("m", "s")]!!.cursor.before)
        val older = h.scope.async { h.store.loadOlder("m", "s") }
        until { timeline.get() == 2 }
        assertEquals("6", h.machine.calls.last { it.path == "/sessions/timeline" }.query["before"])
        reply(timelineJson(listOf(Triple("five", 5L, "g")), "g" to 6L))
        older.await()
        assertEquals("fivesix", text())
        val cursor = h.store.state.value.conversations[conversationKey("m", "s")]!!.cursor
        assertEquals(null, cursor.before)
        assertEquals(false, cursor.loading)

        // The cursor says there is no page before: nothing is asked.
        h.store.loadOlder("m", "s")
        assertEquals(2, timeline.get())
    }

    @Test
    fun `an older page of another generation takes a fresh snapshot instead`() = race {
        val open = h.scope.async { h.store.openChat("m", "s") }
        until { timeline.get() == 1 }
        reply(page("six", 6, before = 6))
        open.await()
        val older = h.scope.async { h.store.loadOlder("m", "s") }
        until { timeline.get() == 2 }
        reply(timelineJson(listOf(Triple("old", 5L, "other")), "other" to 9L))
        until { timeline.get() == 3 }
        reply(page("rebuilt", 1, "other"))
        older.await()
        assertEquals("rebuilt", text())
    }
}
