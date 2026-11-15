package com.clave.ui.screens

import java.text.DateFormat
import java.util.Date
import kotlin.math.roundToInt

/*
 * The words the shell's screens put on times and percentages, as pure functions so the tests
 * fix the clock: "resets in 2 h 10", "updated 3 min ago", "42% used".
 */

private const val MINUTE = 60_000L
private const val HOUR = 60 * MINUTE
private const val DAY = 24 * HOUR

/** The phone's own short time of day ("14:05"). */
private fun shortTime(at: Long): String = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(at))

/** The phone's own short date and time, for a reset more than a day away. */
private fun shortDateTime(at: Long): String = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(Date(at))

/**
 * When a cap comes back: "resets in 12 min", "resets in 2 h 10", "resets in 3 d 4 h", or
 * "resets soon" once its time has passed; null without a reset time. [at] writes the date of
 * a reset a week away or more.
 */
fun resetsIn(resetsAt: Long?, now: Long, at: (Long) -> String = ::shortDateTime): String? {
    if (resetsAt == null) return null
    val left = resetsAt - now
    if (left <= 0) return "resets soon"
    val minutes = ((left + MINUTE - 1) / MINUTE)
    return when {
        left < HOUR -> "resets in $minutes min"
        left < DAY -> {
            val h = left / HOUR
            val m = (left % HOUR) / MINUTE
            if (m == 0L) "resets in $h h" else "resets in $h h ${m.toString().padStart(2, '0')}"
        }
        left < 7 * DAY -> {
            val d = left / DAY
            val h = (left % DAY) / HOUR
            if (h == 0L) "resets in $d d" else "resets in $d d $h h"
        }
        else -> "resets ${at(resetsAt)}"
    }
}

/** How old a read is: "updated just now", "updated 4 min ago", "updated 2 h ago", "updated at 14:05". */
fun updatedAgo(fetchedAt: Long?, now: Long, time: (Long) -> String = ::shortTime): String? {
    if (fetchedAt == null) return null
    val minutes = (now - fetchedAt) / MINUTE
    return when {
        minutes < 1 -> "updated just now"
        minutes < 60 -> "updated $minutes min ago"
        minutes < 24 * 60 -> "updated ${minutes / 60} h ago"
        else -> "updated at ${time(fetchedAt)}"
    }
}

/** A cap's use as its bar says it, rounded the desktop's way: "42% used". */
fun percentUsed(used: Double): String = "${used.coerceIn(0.0, 100.0).roundToInt()}% used"

/** What is left of a cap, for the compact strip: "58% left". */
fun percentLeft(used: Double): String = "${(100 - used).coerceIn(0.0, 100.0).roundToInt()}% left"
