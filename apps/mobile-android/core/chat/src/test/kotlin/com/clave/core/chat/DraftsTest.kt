package com.clave.core.chat

import com.clave.core.ports.MemoryKeyValueStore
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DraftsTest {
    @Test
    fun `survive a new instance over the same store, per machine and session`() = runTest {
        val store = MemoryKeyValueStore()
        val drafts = Drafts(store)
        drafts.set("m1", "s1", "half a thought")
        drafts.set("m1", "s2", "another")
        val again = Drafts(store)
        assertEquals("half a thought", again.get("m1", "s1"))
        assertEquals("another", again.get("m1", "s2"))
        assertEquals("", again.get("m2", "s1"))
    }

    @Test
    fun `an empty text removes the draft from the store`() = runTest {
        val store = MemoryKeyValueStore()
        val drafts = Drafts(store)
        drafts.set("m1", "s1", "x")
        assertTrue(store.map.containsKey(draftKey("m1", "s1")))
        drafts.clear("m1", "s1")
        assertFalse(store.map.containsKey(draftKey("m1", "s1")))
        assertEquals("", drafts.get("m1", "s1"))
    }
}
