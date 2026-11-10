package com.clave.core.state

import com.clave.core.devices.decodeUriComponent
import com.clave.core.devices.encodeUriComponent
import com.clave.core.notifications.DEEP_LINK_SCHEME

/*
 * Where the app opens (persistence.ts, the rule the wave restated on 29 October 2026). A warm
 * resume keeps the navigator the process already holds: there is nothing to restore. A cold
 * launch, a new process, opens the Workspaces of the current machine, with no machine picker
 * when one is already paired or selected, and Machines alone when none is. A notification tap
 * is a deep link to its conversation on either path (`clave-android://chat/<m>/<s>`). Elapsed
 * time is never the signal of how the app was closed, and saved instance state after a process
 * death is not read: every new process is a cold launch.
 */

public const val LAST_MACHINE_KEY: String = "clave.last-machine"

public data class LaunchRoute(val name: String, val params: Map<String, String>? = null)

public data class RouteState(val index: Int, val routes: List<LaunchRoute>)

/** A cold launch: Machines, then the Workspaces of the current machine. */
public fun coldLaunchState(machineId: String?): RouteState =
    if (machineId != null) {
        RouteState(1, listOf(LaunchRoute("Machines"), LaunchRoute("Workspaces", mapOf("machineId" to machineId))))
    } else {
        RouteState(0, listOf(LaunchRoute("Machines")))
    }

/** The conversation a deep link names, over its machine's Workspaces: back from the chat goes
 *  to the machine's workspaces. */
public fun deepLinkState(machineId: String, sessionId: String): RouteState = RouteState(
    2,
    listOf(
        LaunchRoute("Machines"),
        LaunchRoute("Workspaces", mapOf("machineId" to machineId)),
        LaunchRoute("Chat", mapOf("machineId" to machineId, "sessionId" to sessionId)),
    ),
)

/** The path of a deep link to a conversation: `chat/<machineId>/<sessionId>`, each id encoded
 *  as JavaScript's encodeURIComponent does, so links minted by either app read alike. */
public fun chatPath(machineId: String, sessionId: String): String =
    "chat/${encodeUriComponent(machineId)}/${encodeUriComponent(sessionId)}"

private val SCHEME_PREFIX = Regex("^[a-z][a-z0-9+.-]*://", RegexOption.IGNORE_CASE)

/**
 * The state a URL opens: `clave-android://chat/<machineId>/<sessionId>` (or the same path
 * without the scheme) opens that conversation on a cold start and on a warm one alike;
 * anything else is not a link this app knows, and the navigator keeps its own state.
 */
public fun stateForPath(path: String): RouteState? {
    val clean = path.replace(SCHEME_PREFIX, "").trimStart('/').split('?', '#')[0]
    val parts = clean.split('/').filter { it.isNotEmpty() }
    if (parts.size == 3 && parts[0] == "chat") {
        val machineId = decodeUriComponent(parts[1])?.takeIf { it.isNotEmpty() }
        val sessionId = decodeUriComponent(parts[2])?.takeIf { it.isNotEmpty() }
        if (machineId != null && sessionId != null) return deepLinkState(machineId, sessionId)
    }
    return null
}

/** The machine of a screen tree, read off the deepest route that names one. */
public fun machineIdOf(state: RouteState?): String? =
    state?.routes?.asReversed()?.firstNotNullOfOrNull { it.params?.get("machineId") }

/** The launch URL wins over the cold-launch state when it is one of this app's links. */
public fun initialLaunchState(machineId: String?, url: String?): RouteState =
    (if (url != null && url.startsWith("$DEEP_LINK_SCHEME://")) stateForPath(url) else null) ?: coldLaunchState(machineId)
