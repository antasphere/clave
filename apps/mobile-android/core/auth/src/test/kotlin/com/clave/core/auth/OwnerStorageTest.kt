package com.clave.core.auth

import com.clave.core.ports.JvmCrypto
import com.clave.core.ports.MemoryKeyValueStore
import com.clave.core.ports.MemorySecureStore
import com.clave.core.ports.NamespacedKeyValueStore
import com.clave.core.ports.NamespacedSecureStore
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OwnerStorageTest {
    @Test
    fun `the namespace hashes exactly the text the TypeScript hashes`() {
        // The digests of JSON.stringify(["https://a.example",null]) and
        // JSON.stringify(["https://a.example",{subject:"user-7f3a"}]), computed with Node.
        assertEquals(
            "clave.owner.e871511b583254e32d27ac63e939925e0412169a787ad98d43bb46e7818013f4",
            ownerNamespace("https://a.example", null, JvmCrypto),
        )
        assertEquals(
            "clave.owner.b6e53169636e6921be54e18f74ee69dfb7d6993715ec93432c62c472c187a652",
            ownerNamespace("https://a.example", "user-7f3a", JvmCrypto),
        )
    }

    @Test
    fun `namespaces bind both issuer and subject, including the signed-out case`() {
        val keys = listOf(
            ownerNamespace("https://a.example", "subject", JvmCrypto),
            ownerNamespace("https://b.example", "subject", JvmCrypto),
            ownerNamespace("https://a.example", "other", JvmCrypto),
            ownerNamespace("https://a.example", null, JvmCrypto),
            ownerNamespace("https://a.example", "signed-out", JvmCrypto),
        )
        assertEquals(5, keys.toSet().size)
        assertEquals(keys[0], ownerNamespace("https://a.example", "subject", JvmCrypto))
        assertTrue(keys.all { it.matches(Regex("^[A-Za-z0-9._-]+$")) })
    }

    @Test
    fun `two owners never see each other's records, and a late write stays with its owner`() = runBlocking {
        val kv = MemoryKeyValueStore()
        val secure = MemorySecureStore()
        val nsA = ownerNamespace("https://a.example", "subject-a", JvmCrypto)
        val nsB = ownerNamespace("https://a.example", "subject-b", JvmCrypto)
        val a = NamespacedKeyValueStore(kv, nsA)
        val b = NamespacedKeyValueStore(kv, nsB)
        val aSecure = NamespacedSecureStore(secure, nsA)
        val bSecure = NamespacedSecureStore(secure, nsB)
        a.set("machines", "[\"private-machine\"]")
        aSecure.set("bearer", "private-device-bearer")
        assertNull(b.get("machines"))
        assertNull(bSecure.get("bearer"))
        a.set("draft", "late A draft")
        assertNull(b.get("draft"))
        assertEquals("late A draft", NamespacedKeyValueStore(kv, nsA).get("draft"))
        assertEquals("private-device-bearer", aSecure.get("bearer"))
    }
}
