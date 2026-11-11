package com.clave.platform.store

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PreferencesKeyValueStoreTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val name = "clave.settings.platform-check"

    @After
    fun clear() = runBlocking {
        val store = PreferencesKeyValueStore(context, name)
        store.remove("relay-url")
        store.remove("draft")
    }

    @Test
    fun roundTrip() = runBlocking {
        val store = PreferencesKeyValueStore(context, name)
        store.set("relay-url", "https://relay.example")
        assertEquals("https://relay.example", store.get("relay-url"))
    }

    @Test
    fun removeAnswersNull() = runBlocking {
        val store = PreferencesKeyValueStore(context, name)
        store.set("draft", "hello")
        store.remove("draft")
        assertNull(store.get("draft"))
    }

    @Test
    fun aSecondInstanceOfTheNameReadsTheValue() = runBlocking {
        PreferencesKeyValueStore(context, name).set("relay-url", "https://second.example")
        assertEquals("https://second.example", PreferencesKeyValueStore(context, name).get("relay-url"))
    }
}
