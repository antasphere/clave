/**
 * The composer's drafts, one per session per machine, kept on the device until sent:
 * through a restart of the app and through being offline, never sent by themselves
 * (decision 10 of the spec). Ported from `apps/mobile/src/chat/drafts.ts`.
 */
package com.clave.core.chat

import com.clave.core.ports.KeyValueStore
import java.util.concurrent.ConcurrentHashMap

fun draftKey(machineId: String, sessionId: String): String = "clave.draft:$machineId:$sessionId"

class Drafts(private val store: KeyValueStore) {
    /** Read once per key: a keystroke must not wait on storage to learn what it already wrote. */
    private val cache = ConcurrentHashMap<String, String>()

    /** The draft kept for this session, '' when none. */
    suspend fun get(machineId: String, sessionId: String): String {
        val key = draftKey(machineId, sessionId)
        cache[key]?.let { return it }
        val stored = store.get(key) ?: ""
        cache[key] = stored
        return stored
    }

    /** Keeps the text; an empty text removes the draft. */
    suspend fun set(machineId: String, sessionId: String, text: String) {
        val key = draftKey(machineId, sessionId)
        cache[key] = text
        if (text == "") store.remove(key) else store.set(key, text)
    }

    suspend fun clear(machineId: String, sessionId: String): Unit = set(machineId, sessionId, "")
}
