package com.clave.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * The five states the phone shows for a session, in the words of the prototype and the
 * sidebar's inks. Whether the machine answers is apart ([Reachability]), never folded in.
 */
enum class SessionStatus(val label: String) {
    Working("Working"),
    Waiting("Waiting for you"),
    Idle("Idle"),
    Finished("Finished"),
    Error("Error");

    fun color(shared: SharedColors): Color = when (this) {
        Working -> shared.statusWorking
        Waiting -> shared.statusWaiting
        Idle -> shared.statusInactive
        Finished -> shared.statusReady
        Error -> shared.destructive
    }

    /** Only work in progress breathes; a still dot reads as settled. */
    val pulses: Boolean get() = this == Working
}

/** Whether the chosen machine answers. */
enum class Reachability(val label: String) {
    Reachable("Reachable"),
    Connecting("Connecting"),
    Unreachable("Not reachable"),
    Refused("Token refused");

    fun color(shared: SharedColors): Color = when (this) {
        Reachable -> shared.statusReady
        Connecting -> shared.statusWorking
        Unreachable -> shared.statusInactive
        Refused -> shared.destructive
    }
}
