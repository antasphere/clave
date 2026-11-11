package com.clave.core.ports

import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class StoresTest {
    @Test
    fun `two owner namespaces over one store never see each other`() = runTest {
        val raw = MemorySecureStore()
        val a = NamespacedSecureStore(raw, "clave.owner.a")
        val b = NamespacedSecureStore(raw, "clave.owner.b")
        a.set("clave.hub.refresh-token", "rt-a")
        assertNull(b.get("clave.hub.refresh-token"))
        assertEquals("rt-a", a.get("clave.hub.refresh-token"))
        b.remove("clave.hub.refresh-token")
        assertEquals("rt-a", a.get("clave.hub.refresh-token"))
    }

    @Test
    fun `sha256Hex is the well-known digest`() {
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            JvmCrypto.sha256Hex("abc"),
        )
    }
}
