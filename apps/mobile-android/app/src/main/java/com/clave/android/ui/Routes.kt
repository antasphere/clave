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
    const val WORKSPACES = "workspaces/{machineId}"
    const val SESSIONS = "sessions/{machineId}/{workspaceId}"
    const val LAUNCH = "launch/{machineId}/{workspaceId}"
    const val CHAT = "chat/{machineId}/{sessionId}?title={title}"
    const val REQUESTS = "requests/{machineId}?requestId={requestId}"
    const val APPEARANCE = "appearance"

    /** The debug build's developer screen; a release build registers no such destination. */
    const val DEVELOPER = "developer"

    const val MACHINE_ID = "machineId"
    const val WORKSPACE_ID = "workspaceId"
    const val SESSION_ID = "sessionId"
    const val TITLE = "title"
    const val REQUEST_ID = "requestId"

    /** The deep links the destinations declare, in the scheme the notifications use. */
    const val LINK_CHAT = "$DEEP_LINK_SCHEME://chat/{machineId}/{sessionId}?title={title}"
    const val LINK_REQUESTS = "$DEEP_LINK_SCHEME://requests/{machineId}"
    const val LINK_REQUEST = "$DEEP_LINK_SCHEME://requests/{machineId}/{requestId}"
    const val LINK_WORKSPACES = "$DEEP_LINK_SCHEME://workspaces/{machineId}"
    const val LINK_MACHINES = "$DEEP_LINK_SCHEME://machines"

    private fun e(value: String): String = encodeUriComponent(value)

    fun pairing(machineId: String): String = "pairing/${e(machineId)}"

    fun workspaces(machineId: String): String = "workspaces/${e(machineId)}"

    fun sessions(machineId: String, workspaceId: String): String = "sessions/${e(machineId)}/${e(workspaceId)}"

    fun launch(machineId: String, workspaceId: String): String = "launch/${e(machineId)}/${e(workspaceId)}"

    /** A chat route; the title, when known, is the header's until the session list names it. */
    fun chat(machineId: String, sessionId: String, title: String? = null): String =
        "chat/${e(machineId)}/${e(sessionId)}" + if (!title.isNullOrEmpty()) "?title=${e(title)}" else ""

    fun requests(machineId: String, requestId: String? = null): String =
        "requests/${e(machineId)}" + if (!requestId.isNullOrEmpty()) "?requestId=${e(requestId)}" else ""
}
