package com.clave.core.state

import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.coroutines.runBlocking

/** reconnect-history.test.ts: the hub drops the socket, the client reconnects, and the open
 *  history is refreshed only after the new socket's acknowledgement, without a write. */
class ReconnectHistoryTest {
    @Test
    fun `welcome refreshes open history only after the new subscription ack, without sending a draft`() {
        val h = Harness()
        // The first socket's subscription is acknowledged at once; the second one's waits.
        h.machine.holdAcks = { connection -> connection > 1 }
        val snapshots = AtomicInteger()
        val writes = AtomicInteger()
        h.machine.handler = { call ->
            if (call.method == "POST") writes.incrementAndGet()
            if (call.path == "/sessions/timeline") {
                val n = snapshots.incrementAndGet()
                answer(200, page(if (n == 1) "before" else "after reconnect", n.toLong()))
            } else answer(200, """{"revision":1,"pending":[]}""")
        }
        try {
            runBlocking {
                h.start()
                h.drafts.set("m", "s", "ordinary unsent offline draft")
                h.store.openChat("m", "s")
                assertEquals(1, snapshots.get())
                h.machine.closePeers()
                until { h.machine.heldAcks.isNotEmpty() }
                Thread.sleep(100)
                assertEquals(1, snapshots.get())
                h.machine.releaseAcks()
                until { snapshots.get() == 2 }
                until { h.store.text("m", "s") == "after reconnect" }
                assertEquals("ordinary unsent offline draft", h.drafts.get("m", "s"))
                assertEquals(0, writes.get())
                assertEquals(2, h.machine.upgrades.get())
                assertTrue(h.machine.count("GET /requests/pending") >= 2)
            }
        } finally {
            h.close()
        }
    }
}
