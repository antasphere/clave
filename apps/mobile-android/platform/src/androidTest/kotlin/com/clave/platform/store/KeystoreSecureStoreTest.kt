package com.clave.platform.store

import android.content.Context
import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.clave.core.ports.Log
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class KeystoreSecureStoreTest {
    private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
    private val file = "clave.secure.platform-check"
    private val alias = "clave.secure.platform-check.v1"
    private val events = mutableListOf<Pair<String, Map<String, Any?>>>()
    private val log = object : Log {
        override fun event(name: String, fields: Map<String, Any?>) {
            events += name to fields
        }
    }

    private fun prefs() = context.getSharedPreferences(file, Context.MODE_PRIVATE)

    private fun store() = KeystoreSecureStore(context, log, file, alias)

    @Before
    fun clear() {
        prefs().edit().clear().commit()
    }

    @After
    fun clearAfter() {
        prefs().edit().clear().commit()
    }

    @Test
    fun roundTrip() = runBlocking {
        store().set("hub.refresh", "value-one")
        assertEquals("value-one", store().get("hub.refresh"))
    }

    @Test
    fun removeAnswersNull() = runBlocking {
        val store = store()
        store.set("hub.refresh", "value-one")
        store.remove("hub.refresh")
        assertNull(store.get("hub.refresh"))
        assertNull(store.get("never-written"))
    }

    @Test
    fun keysAreIndependent() = runBlocking {
        val store = store()
        store.set("a", "first")
        store.set("b", "second")
        store.remove("a")
        assertNull(store.get("a"))
        assertEquals("second", store.get("b"))
    }

    @Test
    fun aSecondInstanceReadsTheFirstsValue() = runBlocking {
        store().set("device", "shared-value")
        assertEquals("shared-value", KeystoreSecureStore(context, log, file, alias).get("device"))
    }

    @Test
    fun theFileNeverHoldsThePlaintext() = runBlocking {
        store().set("device", "plain-words-here")
        val raw = prefs().getString("device", null)!!
        assertNotEquals("plain-words-here", raw)
        assertTrue(":" in raw)
        assertTrue("plain-words-here" !in raw)
    }

    @Test
    fun aTamperedEntryReadsAsAbsentAndIsRemoved() = runBlocking {
        val store = store()
        store.set("device", "will-be-tampered")
        val raw = prefs().getString("device", null)!!
        val iv = raw.substringBefore(':')
        val sealed = Base64.decode(raw.substringAfter(':'), Base64.NO_WRAP)
        sealed[0] = (sealed[0].toInt() xor 0x01).toByte()
        prefs().edit().putString("device", iv + ":" + Base64.encodeToString(sealed, Base64.NO_WRAP)).commit()

        assertNull(store.get("device"))
        assertNull(prefs().getString("device", null))
        assertEquals(listOf("secure-store.unreadable"), events.map { it.first })
        assertEquals("device".hashCode(), events.single().second["key"])
    }

    @Test
    fun aMalformedEntryReadsAsAbsent() = runBlocking {
        prefs().edit().putString("device", "not-an-entry").commit()
        assertNull(store().get("device"))
        assertNull(prefs().getString("device", null))
    }
}
