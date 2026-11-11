package com.clave.ui.screens

import com.clave.core.chat.PhoneSessionState
import com.clave.core.contract.LaunchProfileView
import com.clave.core.contract.MachinePlatform
import com.clave.core.devices.Machine
import com.clave.ui.theme.SessionStatus
import java.text.DateFormat
import java.util.Date
import kotlin.math.floor
import com.clave.core.chat.Reachability as CoreReachability
import com.clave.ui.theme.Reachability as UiReachability

/**
 * The words and inks the screens read off the core's values, as pure functions so they are
 * tested without a composition. The core and the design system name the same five states
 * and the same four reachabilities; these are the one place they meet.
 */

/** A session's state as the design system draws it: the same five cases, one for one. */
fun PhoneSessionState.toStatus(): SessionStatus = when (this) {
    PhoneSessionState.Working -> SessionStatus.Working
    PhoneSessionState.Waiting -> SessionStatus.Waiting
    PhoneSessionState.Idle -> SessionStatus.Idle
    PhoneSessionState.Finished -> SessionStatus.Finished
    PhoneSessionState.Error -> SessionStatus.Error
}

/** Whether a machine answers, as the design system draws it: the same four cases. */
fun CoreReachability.toReachability(): UiReachability = when (this) {
    CoreReachability.Connecting -> UiReachability.Connecting
    CoreReachability.Reachable -> UiReachability.Reachable
    CoreReachability.Unreachable -> UiReachability.Unreachable
    CoreReachability.Refused -> UiReachability.Refused
}

/** JavaScript's `Math.round`: half rounds up, the way the prototype counted. */
private fun jsRound(x: Double): Long = floor(x + 0.5).toLong()

/** The day a machine was last heard, in the phone's own short date. */
private fun shortDate(at: Long): String = DateFormat.getDateInstance(DateFormat.SHORT).format(Date(at))

/** When the relay last heard a machine that is not online now, in the prototype's words. */
private fun seen(lastSeen: Long?, now: Long, date: (Long) -> String): String {
    if (lastSeen == null) return "never seen"
    val minutes = jsRound((now - lastSeen) / 60_000.0)
    if (minutes < 1) return "seen just now"
    if (minutes < 60) return "seen $minutes min ago"
    val hours = jsRound(minutes / 60.0)
    if (hours < 48) return "seen $hours h ago"
    return "seen ${date(lastSeen)}"
}

/**
 * A machine's line under its name: what it is, the Clave it runs when known, and whether it
 * is online or when it was last seen ("macOS · Clave 1.2.3 · online"). [date] writes a day
 * past two days ago; the phone's short date unless a test fixes it.
 */
fun describeMachine(m: Machine, now: Long, date: (Long) -> String = ::shortDate): String {
    val platform = when (m.platform) {
        MachinePlatform.Macos -> "macOS"
        MachinePlatform.Linux -> "Linux"
        MachinePlatform.Unknown -> "Clave server"
    }
    val version = if (m.version.isNotEmpty()) " · Clave ${m.version}" else ""
    val presence = if (m.online) "online" else seen(m.lastSeen, now, date)
    return "$platform$version · $presence"
}

/** The last segment of a path, a trailing slash ignored; a path with no segment is itself. */
fun basename(path: String): String = path.split('/').lastOrNull { it.isNotEmpty() } ?: path

private val CHAT_PROFILES = setOf("claude-chat", "codex-chat", "dev-echo-adapter")

/** A profile that opens a chat on the phone; every other one starts a terminal, read-only here. */
fun isChatProfile(p: LaunchProfileView): Boolean = p.id in CHAT_PROFILES || p.id.startsWith("chat:")
