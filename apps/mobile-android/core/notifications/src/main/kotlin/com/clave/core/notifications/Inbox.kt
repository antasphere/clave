package com.clave.core.notifications

import com.clave.core.ports.KeyValueStore
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

public const val PENDING_NOTIFICATION_KEY: String = "clave.pending-notification"

private const val SEEN_LIMIT = 64

/**
 * One owner and one navigator. A response may arrive before the screens exist (the tap
 * that launched the app cold, a response a background receiver handled), so its link is
 * kept in the key-value store until a launch or a mounted navigator takes it. Everything
 * runs one at a time on one fair lock: a response, the launch's read and the flush never
 * interleave, and [idle] waits for whatever was queued before it.
 */
public class NotificationInbox(
    private val kv: KeyValueStore,
    private val lastResponse: suspend () -> IncomingResponse?,
    private val clearLastResponse: suspend () -> Unit,
    private val respond: suspend (IncomingResponse) -> DeepLink?,
    private val navigate: ((DeepLink) -> Unit)? = null,
) {
    private val lock = Mutex()
    private val seen = LinkedHashSet<String>()
    private var queued: DeepLink? = null
    private var mounted = false

    @Volatile
    private var closed = false
    private var navigator: ((DeepLink) -> Unit)? = null

    /** Handles a response once: a second delivery of the same tap (same notification, date
     *  and action) is dropped. */
    public suspend fun receive(response: IncomingResponse): Unit = lock.withLock {
        if (closed) return@withLock
        val key = buildJsonArray {
            add(kotlinx.serialization.json.JsonPrimitive(response.notificationId))
            add(kotlinx.serialization.json.JsonPrimitive(response.date))
            add(kotlinx.serialization.json.JsonPrimitive(response.actionIdentifier))
        }.toString()
        if (key in seen) return@withLock
        val link = respond(response)
        if (link != null) {
            kv.set(PENDING_NOTIFICATION_KEY, encodeLink(link))
            queued = link
        }
        seen += key
        if (seen.size > SEEN_LIMIT) seen.remove(seen.first())
        clearLastResponse()
        flush()
    }

    /** Where a launch opens: the link of a pending notification, unless the platform handed
     *  the app an explicit `clave-android://` URL, which wins as it does without one. */
    public suspend fun initialState(machineId: String?, url: String?): InitialRoute {
        lastResponse()?.let { receive(it) }
        var state = initialLaunchState(machineId, url)
        lock.withLock {
            val raw = kv.get(PENDING_NOTIFICATION_KEY)
            val link = queued ?: pendingLink(raw)
            queued = null
            if (raw != null) acknowledge(raw)
            val explicit = url?.startsWith("$DEEP_LINK_SCHEME://") == true
            if (!explicit && link != null) state = navigationStateOf(link)
        }
        return state
    }

    /** The navigator is mounted: a link queued meanwhile is navigated to now. */
    public suspend fun ready(navigate: ((DeepLink) -> Unit)? = this.navigate) {
        lock.withLock {
            navigator = navigate
            mounted = true
            flush()
        }
    }

    /** The owner went away (signed out, unmounted): nothing navigates any more. */
    public fun close() {
        closed = true
    }

    /** Waits for everything queued before this call. */
    public suspend fun idle(): Unit = lock.withLock { }

    private suspend fun acknowledge(raw: String) {
        if (kv.get(PENDING_NOTIFICATION_KEY) == raw) kv.remove(PENDING_NOTIFICATION_KEY)
    }

    private suspend fun flush() {
        val link = queued
        val go = navigator
        if (!mounted || closed || link == null || go == null) return
        queued = null
        go(link)
        acknowledge(encodeLink(link))
    }
}

/** The stored form of a link, the TypeScript app's: `{kind, machineId, …}`. */
public fun encodeLink(link: DeepLink): String =
    when (link) {
        is DeepLink.Chat -> buildJsonObject {
            put("kind", "chat")
            put("machineId", link.machineId)
            put("sessionId", link.sessionId)
            put("title", link.title)
        }
        is DeepLink.Requests -> buildJsonObject {
            put("kind", "requests")
            put("machineId", link.machineId)
            if (link.requestId != null) put("requestId", link.requestId) else put("requestId", JsonNull)
        }
        is DeepLink.Workspaces -> buildJsonObject {
            put("kind", "workspaces")
            put("machineId", link.machineId)
        }
        is DeepLink.Machines -> buildJsonObject {
            put("kind", "machines")
            put("reason", link.reason)
        }
    }.toString()

/** A stored link, or null: a damaged pending link never prevents the account opening. */
public fun pendingLink(raw: String?): DeepLink? {
    if (raw.isNullOrEmpty()) return null
    val link: JsonObject = parseJsonOrNull(raw).objectOrNull() ?: return null
    val kind = link["kind"].stringOrNull()
    if (kind == "machines") return link["reason"].stringOrNull()?.let { DeepLink.Machines(it) }
    val machineId = link["machineId"].stringOrNull()?.takeIf { it.isNotEmpty() } ?: return null
    return when (kind) {
        "workspaces" -> DeepLink.Workspaces(machineId)
        "requests" -> {
            val requestId = link["requestId"]
            when {
                requestId == null || requestId is JsonNull -> DeepLink.Requests(machineId, null)
                requestId.stringOrNull() != null -> DeepLink.Requests(machineId, requestId.stringOrNull())
                else -> null
            }
        }
        "chat" -> {
            val sessionId = link["sessionId"].stringOrNull()?.takeIf { it.isNotEmpty() } ?: return null
            val title = link["title"].stringOrNull() ?: return null
            DeepLink.Chat(machineId, sessionId, title)
        }
        else -> null
    }
}
