package com.clave.core.notifications

import com.clave.core.contract.DevicePlatform
import com.clave.core.devices.BuildKind
import com.clave.core.devices.Credential
import com.clave.core.ports.HttpFailure
import com.clave.core.ports.MemoryKeyValueStore
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

private class MemoryCleanupStore : CleanupCredentialStore {
    val map = linkedMapOf<String, Credential>()
    override suspend fun get(ref: String): Credential? = map[ref]
    override suspend fun set(ref: String, credential: Credential) { map[ref] = credential }
    override suspend fun remove(ref: String) { map.remove(ref) }
}

private class Clears(var mode: String = "ok") : PushTokenClient {
    val bearers = mutableListOf<String>()
    var onClear: suspend () -> Unit = {}
    override suspend fun setPushToken(bearer: String, token: String, platform: DevicePlatform) = error("not used")
    override suspend fun clearPushToken(bearer: String) {
        onClear()
        when (mode) {
            "offline" -> throw HttpFailure.Network()
            "hang" -> awaitCancellation()
        }
        bearers += bearer
    }
}

class CleanupTest {
    private val kv = MemoryKeyValueStore()
    private val active = linkedMapOf(
        "m-1" to Credential("https://relay.example/m/m-1", "ds-1"),
        "m-2" to Credential("https://relay.example/m/m-2", "ds-2"),
    )
    private val cleanup = MemoryCleanupStore()
    private val clears = Clears()

    private fun owner(build: BuildKind = BuildKind.Release, created: MutableList<Credential> = mutableListOf()) =
        CleanupOwner(kv, { active[it] }, cleanup, build) { created += it; clears }

    @Test
    fun `captures the credentials before the clear, then forgets them once acknowledged`() = runTest {
        kv.set(pushTokenKey("m-1"), "fcm-1")
        clears.onClear = {
            // At the moment a clear is sent, its credential is already captured and referenced.
            val refs = pendingPushCleanup(kv)
            assertEquals(2, refs.size)
            assertEquals(2, cleanup.map.size)
            assertTrue(refs.all { Regex("^push-cleanup-[a-z0-9-]+$").matches(it) })
        }
        val result = clearPushRegistrations(listOf("m-1", "m-2"), owner())
        assertEquals(PushCleanupResult(pending = 0, retryRecorded = true), result)
        assertEquals(setOf("ds-1", "ds-2"), clears.bearers.toSet())
        assertEquals(null, kv.get(PUSH_CLEANUP_KEY))
        assertEquals(null, kv.get(pushTokenKey("m-1")))
        assertTrue(cleanup.map.isEmpty())
    }

    @Test
    fun `only opaque references enter the key-value store`() = runTest {
        clears.mode = "offline"
        clearPushRegistrations(listOf("m-1"), owner())
        for (value in kv.map.values) {
            assertFalse(value.contains("ds-1"))
            assertFalse(value.contains("relay.example"))
        }
    }

    @Test
    fun `an offline machine keeps its reference, retried later with the old credential`() = runTest {
        clears.mode = "offline"
        val first = clearPushRegistrations(listOf("m-1"), owner())
        assertEquals(1, first.pending)
        val refs = pendingPushCleanup(kv)
        assertEquals(1, refs.size)
        assertEquals(Credential("https://relay.example/m/m-1", "ds-1"), cleanup.map[refs[0]])
        // The pairing is gone, and a new one under the same machine id has another bearer.
        active["m-1"] = Credential("https://relay.example/m/m-1", "ds-new")
        clears.mode = "ok"
        val second = clearPushRegistrations(emptyList(), owner())
        assertEquals(0, second.pending)
        assertEquals(listOf("ds-1"), clears.bearers)
        assertTrue(pendingPushCleanup(kv).isEmpty())
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test
    fun `a clear that never answers is left pending after three seconds`() = runTest {
        clears.mode = "hang"
        val start = testScheduler.currentTime
        val result = clearPushRegistrations(listOf("m-1"), owner())
        assertEquals(1, result.pending)
        assertEquals(PUSH_CLEAR_TIMEOUT_MS, testScheduler.currentTime - start)
    }

    @Test
    fun `a credential captured twice is kept once`() = runTest {
        clears.mode = "offline"
        clearPushRegistrations(listOf("m-1"), owner())
        clearPushRegistrations(listOf("m-1"), owner())
        assertEquals(1, pendingPushCleanup(kv).size)
        assertEquals(1, cleanup.map.size)
    }

    @Test
    fun `a release build sends no clear over plain http, and keeps the reference`() = runTest {
        active["m-3"] = Credential("http://192.168.1.5:43201", "ds-3")
        val created = mutableListOf<Credential>()
        val result = clearPushRegistrations(listOf("m-3"), owner(BuildKind.Release, created))
        assertEquals(1, result.pending)
        assertTrue(created.isEmpty())
        assertNotNull(cleanup.map.values.singleOrNull { it.bearer == "ds-3" })
    }

    @Test
    fun `the earlier pending-machine list is migrated`() = runTest {
        kv.set(PUSH_CLEANUP_KEY, """["m-2"]""")
        assertEquals(listOf("m-2"), pendingPushCleanup(kv))
        val result = clearPushRegistrations(emptyList(), owner())
        assertEquals(0, result.pending)
        assertEquals(listOf("ds-2"), clears.bearers)
    }

    @Test
    fun `an unreadable record or a missing credential refuses before anything is forgotten`() = runTest {
        kv.set(PUSH_CLEANUP_KEY, """{"v":2,"refs":["../etc"]}""")
        try {
            pendingPushCleanup(kv)
            fail("expected a refusal")
        } catch (e: IllegalStateException) {
            assertEquals("Notification cleanup could not be read.", e.message)
        }
        kv.remove(PUSH_CLEANUP_KEY)
        kv.set(pushTokenKey("m-9"), "fcm-9")
        try {
            clearPushRegistrations(listOf("m-9"), owner())
            fail("expected a refusal")
        } catch (e: IllegalStateException) {
            assertEquals("Notification cleanup credentials are unavailable.", e.message)
        }
        assertEquals("fcm-9", kv.get(pushTokenKey("m-9")))
    }
}
