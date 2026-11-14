package com.clave.ui.screens

import androidx.compose.ui.graphics.Color
import com.clave.core.contract.AgentState
import com.clave.core.contract.Session
import com.clave.core.contract.Transport
import com.clave.ui.theme.SessionStatus
import com.clave.ui.theme.groupColorOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ShellFormatTest {
    private val now = 1_800_000_000_000L
    private val min = 60_000L
    private val hour = 60 * min
    private val day = 24 * hour

    @Test
    fun resetsInSaysMinutesHoursAndDays() {
        assertNull(resetsIn(null, now))
        assertEquals("resets soon", resetsIn(now - 1, now))
        assertEquals("resets in 1 min", resetsIn(now + 10_000, now))
        assertEquals("resets in 12 min", resetsIn(now + 12 * min, now))
        assertEquals("resets in 2 h", resetsIn(now + 2 * hour, now))
        assertEquals("resets in 2 h 05", resetsIn(now + 2 * hour + 5 * min, now))
        assertEquals("resets in 3 d 4 h", resetsIn(now + 3 * day + 4 * hour, now))
        assertEquals("resets in 1 d", resetsIn(now + day, now))
        assertEquals("resets on the day", resetsIn(now + 9 * day, now) { "on the day" })
    }

    @Test
    fun updatedAgoSaysHowOldARead() {
        assertNull(updatedAgo(null, now))
        assertEquals("updated just now", updatedAgo(now - 30_000, now))
        assertEquals("updated 4 min ago", updatedAgo(now - 4 * min, now))
        assertEquals("updated 3 h ago", updatedAgo(now - 3 * hour, now))
        assertEquals("updated at noon", updatedAgo(now - 2 * day, now) { "noon" })
    }

    @Test
    fun percentagesAreRoundedAndBounded() {
        assertEquals("42% used", percentUsed(42.4))
        assertEquals("100% used", percentUsed(130.0))
        assertEquals("58% left", percentLeft(42.4))
        assertEquals("0% left", percentLeft(101.0))
    }

    @Test
    fun aLimitChipSaysExhaustedOrWhatIsLeft() {
        val chip = LimitChip("claude", "Work", 97.0, now + 12 * min, exhausted = true)
        assertEquals("Exhausted · resets in 12 min", limitLine(chip, now))
        assertEquals("58% left", limitLine(chip.copy(usedPercentage = 42.0, resetsAt = null, exhausted = false), now))
        assertEquals("No usage read yet", limitLine(chip.copy(usedPercentage = null), now))
        assertEquals("Token refused", limitLine(chip.copy(usedPercentage = null, note = "Token refused"), now))
    }

    private fun session(transport: Transport) = Session(
        id = "s", provider = "claude", transport = transport, cwd = "/a/clave", windowKey = "w",
        state = AgentState.Idle, createdAt = 1, adapterId = "a", title = "T",
    )

    @Test
    fun aRecentRowSaysWhereItIs() {
        assertEquals("clave · Auth", recentSubtitle(RecentRow(session(Transport.Events), SessionStatus.Idle, "clave", "Auth")))
        assertEquals("claude", recentSubtitle(RecentRow(session(Transport.Events), SessionStatus.Idle, null, null)))
        assertEquals("Terminal · clave", recentSubtitle(RecentRow(session(Transport.Pty), SessionStatus.Idle, "clave", null)))
        assertEquals("1 request waiting", requestsWaiting(1))
        assertEquals("3 requests waiting", requestsWaiting(3))
    }

    @Test
    fun aSessionRowNamesItsWorkspaceInTheAllView() {
        val row = SessionRow(session(Transport.Events), SessionStatus.Idle, workspaceName = "notes")
        assertEquals("claude · notes · clave", sessionSubtitle(row, allWorkspaces = true))
        assertEquals("claude · clave", sessionSubtitle(row, allWorkspaces = false))
    }

    @Test
    fun groupColoursResolveTheDesktopNamesAndHex() {
        assertEquals(Color(0xFF5E6AD2), groupColorOf("blue"))
        assertEquals(Color(0xFF112233), groupColorOf("#112233"))
        assertNull(groupColorOf("mauve"))
        assertNull(groupColorOf("#12"))
        assertNull(groupColorOf(null))
    }
}
