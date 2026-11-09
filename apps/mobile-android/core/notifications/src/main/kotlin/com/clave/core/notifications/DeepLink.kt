package com.clave.core.notifications

import com.clave.core.contract.NotificationPayload
import com.clave.core.devices.EnrollmentRecords
import com.clave.core.devices.decodeUriComponent
import com.clave.core.devices.encodeUriComponent

/**
 * Where a notification takes the app (decision 9 of the spec): a tap opens the
 * conversation it is about, on a cold launch and on a warm resume alike; a request the
 * notification could not settle opens the app on that request; a notification about an
 * account opens the machine's workspaces. The notification names a server and the phone
 * reaches a server through a machine, so the enrollment records resolve one to the other;
 * a server this phone is not paired with lands on Machines with the reason.
 */
public sealed interface DeepLink {
    public data class Chat(val machineId: String, val sessionId: String, val title: String) : DeepLink
    public data class Requests(val machineId: String, val requestId: String? = null) : DeepLink
    public data class Workspaces(val machineId: String) : DeepLink
    public data class Machines(val reason: String) : DeepLink
}

public data class MachineRef(val machineId: String)

/** The enrollment records, or anything that maps a server to a machine. */
public fun interface MachineResolver {
    public suspend fun byServerId(serverId: String): MachineRef?
}

/** The enrollment records as the resolver the notifications read. */
public fun EnrollmentRecords.asMachineResolver(): MachineResolver =
    MachineResolver { serverId -> byServerId(serverId)?.let { MachineRef(it.machineId) } }

public enum class DeepLinkTarget { Conversation, Request }

public suspend fun deepLinkOf(
    payload: NotificationPayload,
    machines: MachineResolver,
    target: DeepLinkTarget = DeepLinkTarget.Conversation,
): DeepLink {
    val record = machines.byServerId(payload.serverId)
        ?: return DeepLink.Machines("${payload.serverName.ifEmpty { "That machine" }} is not paired with this phone.")
    val machineId = record.machineId
    val requestId = payload.requestId
    if (target == DeepLinkTarget.Request && !requestId.isNullOrEmpty()) return DeepLink.Requests(machineId, requestId)
    if (payload.sessionId.isNotEmpty()) return DeepLink.Chat(machineId, payload.sessionId, payload.sessionTitle)
    return DeepLink.Workspaces(machineId)
}

/** The scheme the Android app registers, apart from the iOS app's `clave://` so the two
 *  installs on one test machine never take each other's links. */
public const val DEEP_LINK_SCHEME: String = "clave-android"

/**
 * The link as a URI: `<scheme>://chat/<machine>/<session>[?title=<title>]`,
 * `<scheme>://requests/<machine>[/<request>]`, `<scheme>://workspaces/<machine>`,
 * `<scheme>://machines`. Every segment is URI-encoded. The reason of a Machines link stays
 * out of the URI: it is a sentence for the screen, not an address.
 */
public fun DeepLink.toUri(scheme: String = DEEP_LINK_SCHEME): String =
    when (this) {
        is DeepLink.Chat -> "$scheme://chat/${encodeUriComponent(machineId)}/${encodeUriComponent(sessionId)}" +
            if (title.isNotEmpty()) "?title=${encodeUriComponent(title)}" else ""
        is DeepLink.Requests -> "$scheme://requests/${encodeUriComponent(machineId)}" +
            if (!requestId.isNullOrEmpty()) "/${encodeUriComponent(requestId)}" else ""
        is DeepLink.Workspaces -> "$scheme://workspaces/${encodeUriComponent(machineId)}"
        is DeepLink.Machines -> "$scheme://machines"
    }

/** The inverse of [toUri]; null for a URI of another scheme, or a path this app does not
 *  know. A chat without a title reads `""`; `machines` reads `Machines("")`. */
public fun parseDeepLink(uri: String, scheme: String = DEEP_LINK_SCHEME): DeepLink? {
    val prefix = "$scheme://"
    if (!uri.startsWith(prefix, ignoreCase = true)) return null
    val rest = uri.substring(prefix.length)
    val path = rest.substringBefore('?').substringBefore('#')
    val query = if ('?' in rest) rest.substringAfter('?').substringBefore('#') else ""
    val parts = path.split('/').filter { it.isNotEmpty() }
    if (parts.isEmpty()) return null
    val decoded = parts.drop(1).map { decodeUriComponent(it)?.takeIf { d -> d.isNotEmpty() } ?: return null }
    return when (parts[0]) {
        "chat" -> if (decoded.size == 2) DeepLink.Chat(decoded[0], decoded[1], queryParam(query, "title") ?: "") else null
        "requests" -> when (decoded.size) {
            1 -> DeepLink.Requests(decoded[0], null)
            2 -> DeepLink.Requests(decoded[0], decoded[1])
            else -> null
        }
        "workspaces" -> if (decoded.size == 1) DeepLink.Workspaces(decoded[0]) else null
        "machines" -> if (decoded.isEmpty()) DeepLink.Machines("") else null
        else -> null
    }
}

private fun queryParam(query: String, name: String): String? =
    query.split('&').firstNotNullOfOrNull { pair ->
        val key = pair.substringBefore('=')
        if (key == name) decodeUriComponent(pair.substringAfter('=', "")) else null
    }

/** One screen of the app's back stack: its route name and its arguments. */
public data class Route(val name: String, val params: Map<String, String> = emptyMap())

/** The screens under the deep link, root first: what a cold launch opens. */
public fun routesOf(link: DeepLink): List<Route> =
    when (link) {
        is DeepLink.Machines -> listOf(Route("Machines"))
        is DeepLink.Workspaces -> listOf(Route("Machines"), Route("Workspaces", mapOf("machineId" to link.machineId)))
        is DeepLink.Requests -> listOf(
            Route("Machines"),
            Route("Workspaces", mapOf("machineId" to link.machineId)),
            Route(
                "Requests",
                buildMap {
                    put("machineId", link.machineId)
                    if (!link.requestId.isNullOrEmpty()) put("requestId", link.requestId)
                },
            ),
        )
        is DeepLink.Chat -> listOf(
            Route("Machines"),
            Route("Workspaces", mapOf("machineId" to link.machineId)),
            Route(
                "Chat",
                buildMap {
                    put("machineId", link.machineId)
                    put("sessionId", link.sessionId)
                    if (link.title.isNotEmpty()) put("title", link.title)
                },
            ),
        )
    }

/** The back stack a launch opens on: the routes and the index of the visible one. */
public data class InitialRoute(val index: Int, val routes: List<Route>)

/** The navigation state a cold launch starts on. */
public fun navigationStateOf(link: DeepLink): InitialRoute {
    val routes = routesOf(link)
    return InitialRoute(routes.size - 1, routes)
}

/** The one screen a warm resume navigates to. */
public fun routeOf(link: DeepLink): Route = routesOf(link).last()

/** A cold launch without a link: Machines, then the Workspaces of the current machine. */
public fun coldLaunchState(machineId: String?): InitialRoute =
    if (machineId != null) {
        InitialRoute(1, listOf(Route("Machines"), Route("Workspaces", mapOf("machineId" to machineId))))
    } else {
        InitialRoute(0, listOf(Route("Machines")))
    }

/** Where a launch opens when the platform handed the app an explicit URL: that URL's link
 *  when it is one of this app's, else the cold launch. */
public fun initialLaunchState(machineId: String?, url: String?): InitialRoute {
    val explicit = if (url != null && url.startsWith("$DEEP_LINK_SCHEME://")) parseDeepLink(url) else null
    return explicit?.let { navigationStateOf(it) } ?: coldLaunchState(machineId)
}
