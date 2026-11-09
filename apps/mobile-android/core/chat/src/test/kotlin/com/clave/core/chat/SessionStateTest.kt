package com.clave.core.chat

import com.clave.core.contract.AgentState
import com.clave.core.contract.Session
import com.clave.core.contract.Transport
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SessionStateTest {
    private val base = Session(
        id = "s",
        provider = "claude",
        transport = Transport.Events,
        cwd = "/home/v/project",
        windowKey = "server",
        state = AgentState.Idle,
        createdAt = 1,
        adapterId = "claude-chat",
        title = "t",
    )
    private val workspaces = listOf(
        WorkspaceRoot("home", "/home/v"),
        WorkspaceRoot("project", "/home/v/project"),
        WorkspaceRoot("other", "/srv/other"),
    )

    @Test
    fun `maps the five server states and the fatal error`() {
        assertEquals(PhoneSessionState.Working, phoneSessionState(AgentState.Working))
        assertEquals(PhoneSessionState.Waiting, phoneSessionState(AgentState.Blocked))
        assertEquals(PhoneSessionState.Idle, phoneSessionState(AgentState.Idle))
        assertEquals(PhoneSessionState.Finished, phoneSessionState(AgentState.Done))
        assertEquals(PhoneSessionState.Finished, phoneSessionState(AgentState.Ended))
        assertEquals(PhoneSessionState.Error, phoneSessionState(AgentState.Working, "limit reached"))
        assertEquals(PhoneSessionState.Finished, phoneSessionState(AgentState.Ended, null))
        assertEquals("Waiting for you", SESSION_STATE_LABEL[PhoneSessionState.Waiting])
        assertEquals("Token refused", REACHABILITY_LABEL[Reachability.Refused])
    }

    @Test
    fun `lists chats first, newest first, terminals after`() {
        val ordered = orderSessions(
            listOf(
                base.copy(id = "term-new", transport = Transport.Pty, createdAt = 9),
                base.copy(id = "chat-old", createdAt = 1),
                base.copy(id = "chat-new", createdAt = 5),
            ),
        )
        assertEquals(listOf("chat-new", "chat-old", "term-new"), ordered.map { it.id })
    }

    @Test
    fun `uses an explicit stamp even when its workspace is missing or deleted`() {
        assertEquals("other", workspaceOfSession(base, "other", workspaces))
        assertEquals("gone-workspace", workspaceOfSession(base, "gone-workspace", emptyList()))
    }

    @Test
    fun `keeps an absent stamp unknown for compatibility with older servers`() {
        assertNull(workspaceOfSession(base, null, workspaces))
    }

    @Test
    fun `filters only by the stamp, never by a contradictory or nested cwd`() {
        val sessions = listOf(
            base.copy(id = "a", cwd = "/home/v/project"),
            base.copy(id = "b", cwd = "/home/v/project/nested"),
            base.copy(id = "c", cwd = "/srv/other/x"),
            base.copy(id = "deleted", cwd = "/home/v/project"),
        )
        val stamps = mapOf("a" to "other", "c" to "home", "deleted" to "gone-workspace")
        assertEquals(listOf("b"), sessionsOfWorkspace(sessions, stamps, workspaces, "project").map { it.id })
        assertEquals(listOf("b", "c"), sessionsOfWorkspace(sessions, stamps, workspaces, "home").map { it.id })
        assertEquals(listOf("a", "b"), sessionsOfWorkspace(sessions, stamps, workspaces, "other").map { it.id })
        assertEquals(listOf("b", "deleted"), sessionsOfWorkspace(sessions, stamps, workspaces, "gone-workspace").map { it.id })
    }
}
