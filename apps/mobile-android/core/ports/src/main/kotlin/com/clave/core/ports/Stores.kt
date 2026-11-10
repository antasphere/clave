package com.clave.core.ports

/**
 * Two stores, deliberately apart: [KeyValueStore] for settings, drafts, records and
 * caches (plain storage), [SecureStore] for credentials (the Android Keystore behind it
 * in the app). Nothing stored through one is ever read through the other, and a value
 * written through [SecureStore] never appears in a log.
 */
interface KeyValueStore {
    suspend fun get(key: String): String?
    suspend fun set(key: String, value: String)
    suspend fun remove(key: String)
}

interface SecureStore {
    suspend fun get(key: String): String?
    suspend fun set(key: String, value: String)
    suspend fun remove(key: String)
}

/** An in-memory store, for the tests and for a platform without storage. */
class MemoryKeyValueStore : KeyValueStore {
    val map = linkedMapOf<String, String>()
    override suspend fun get(key: String): String? = map[key]
    override suspend fun set(key: String, value: String) { map[key] = value }
    override suspend fun remove(key: String) { map.remove(key) }
}

class MemorySecureStore : SecureStore {
    val map = linkedMapOf<String, String>()
    override suspend fun get(key: String): String? = map[key]
    override suspend fun set(key: String, value: String) { map[key] = value }
    override suspend fun remove(key: String) { map.remove(key) }
}

/**
 * An owner's namespace over a store: every key is prefixed with the namespace, so an
 * old asynchronous operation keeps its own owner's store after a sign-out and can never
 * write into the next account's records.
 */
class NamespacedKeyValueStore(private val store: KeyValueStore, private val namespace: String) : KeyValueStore {
    private fun key(name: String) = "$namespace:$name"
    override suspend fun get(key: String): String? = store.get(key(key))
    override suspend fun set(key: String, value: String) = store.set(key(key), value)
    override suspend fun remove(key: String) = store.remove(key(key))
}

class NamespacedSecureStore(private val store: SecureStore, private val namespace: String) : SecureStore {
    private fun key(name: String) = "$namespace.$name"
    override suspend fun get(key: String): String? = store.get(key(key))
    override suspend fun set(key: String, value: String) = store.set(key(key), value)
    override suspend fun remove(key: String) = store.remove(key(key))
}
