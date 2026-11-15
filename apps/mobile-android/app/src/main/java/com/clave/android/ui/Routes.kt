package com.clave.android.ui

import com.clave.core.devices.encodeUriComponent
import com.clave.core.notifications.DEEP_LINK_SCHEME

/**
 * The navigation graph's route patterns and the builders of concrete routes. Every argument
 * is encoded as JavaScript's encodeURIComponent does (a machine id carries `:`, a title any
 * text), and the navigation library decodes it back, so a route is a plain string with no
 * Android type in it.
 */
object Routes {
    const val MACHINES = "machines"
    const val PAIRING = "pairing/{machineId}"

    /** The landing screen of a paired machine: the quick composer, the limits, the recent sessions. */
    const val HOME = "home/{machineId}"

    /** The session list, of one workspace or (no workspace) of all. */
    const val SESSIONS = "sessions/{machineId}?workspaceId={workspaceId}"
    const val LAUNCH = "launch/{machineId}/{workspaceId}"

    /** A conversation; `message`, when given, is sent once as the chat opens (the quick composer's). */
    const val CHAT = "chat/{machineId}/{sessionId}?title={title}&message={message}"
    const val REQUESTS = "requests/{machineId}?requestId={requestId}"
    const val SETTINGS = "settings/{machineId}"
    const val ACCOUNTS = "accounts/{machineId}"
    const val APPEARANCE = "appearance"

    /** The debug build's developer screen; a release build registers no such destination. */
    const val DEVELOPER = "developer"

    const val MACHINE_ID = "machineId"
    const val WORKSPACE_ID = "workspaceId"
    const val SESSION_ID = "sessionId"
    const val TITLE = "title"
    const val MESSAGE = "message"
    const val REQUEST_ID = "requestId"

    /** The deep links the destinations declare, in the scheme the notifications use. */
    const val LINK_CHAT = "$DEEP_LINK_SCHEME://chat/{machineId}/{sessionId}?title={title}"
    const val LINK_REQUESTS = "$DEEP_LINK_SCHEME://requests/{machineId}"
    const val LINK_REQUEST = "$DEEP_LINK_SCHEME://requests/{machineId}/{requestId}"

    /** The machine's landing screen, by the link the notifications have always minted for it. */
    const val LINK_WORKSPACES = "$DEEP_LINK_SCHEME://workspaces/{machineId}"
    const val LINK_MACHINES = "$DEEP_LINK_SCHEME://machines"

    private fun e(value: String): String = encodeUriComponent(value)

    fun pairing(machineId: String): String = "pairing/${e(machineId)}"

    fun home(machineId: String): String = "home/${e(machineId)}"

    fun sessions(machineId: String, workspaceId: String? = null): String =
        "sessions/${e(machineId)}" + if (!workspaceId.isNullOrEmpty()) "?workspaceId=${e(workspaceId)}" else ""

    fun launch(machineId: String, workspaceId: String): String = "launch/${e(machineId)}/${e(workspaceId)}"

    /** A chat route; the title, when known, is the header's until the session list names it. */
    fun chat(machineId: String, sessionId: String, title: String? = null, message: String? = null): String {
        val query = listOfNotNull(
            title?.takeIf { it.isNotEmpty() }?.let { "title=${e(it)}" },
            message?.takeIf { it.isNotEmpty() }?.let { "message=${e(it)}" },
        )
        return "chat/${e(machineId)}/${e(sessionId)}" + if (query.isEmpty()) "" else query.joinToString("&", prefix = "?")
    }

    fun requests(machineId: String, requestId: String? = null): String =
        "requests/${e(machineId)}" + if (!requestId.isNullOrEmpty()) "?requestId=${e(requestId)}" else ""

    fun settings(machineId: String): String = "settings/${e(machineId)}"

    fun accounts(machineId: String): String = "accounts/${e(machineId)}"
}
