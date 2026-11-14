package com.clave.core.state

import com.clave.core.contract.AgentState
import com.clave.core.contract.LaunchProfilePreferencesView
import com.clave.core.contract.LaunchProfileView
import com.clave.core.contract.LauncherFamily
import com.clave.core.contract.Session
import com.clave.core.contract.SidebarGroupView
import com.clave.core.contract.SidebarOverview
import com.clave.core.contract.SidebarWindowView
import com.clave.core.contract.Transport
import com.clave.core.contract.UsageRead
import com.clave.core.contract.UsageSeverity
import com.clave.core.contract.UsageWindow
import com.clave.core.contract.WorkspaceView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShellTest {
    private fun session(id: String, createdAt: Long = 1, workspaceId: String? = null) = Session(
        id = id,
        provider = "claude",
        transport = Transport.Events,
        cwd = "/w/$id",
        windowKey = "main",
        workspaceId = workspaceId,
        state = AgentState.Idle,
        createdAt = createdAt,
        adapterId = "claude-chat",
        title = id,
    )

    private fun group(id: String, vararg sessions: String, workspaceId: String? = null, collapsed: Boolean = false) =
        SidebarGroupView(id, "Group $id", "blue", collapsed, workspaceId, sessions.toList())

    private fun ids(sections: List<SessionSection>) = sections.map { s -> (s.groupId ?: "other") to s.sessions.map { it.id } }

    @Test
    fun sectionsFollowTheSidebarOrderAcrossWindowsWithTheUngroupedLast() {
        val overview = SidebarOverview(
            listOf(
                SidebarWindowView("main", null, listOf("g2", "s5", "g1"), listOf(group("g1", "s1", "s2"), group("g2", "s3"))),
                SidebarWindowView("second", null, listOf("g3"), listOf(group("g3", "s4"))),
            ),
        )
        val sessions = listOf(session("s1"), session("s2"), session("s3"), session("s4"), session("s5"), session("s6", createdAt = 9), session("s7", createdAt = 3))
        assertEquals(
            listOf(
                "g2" to listOf("s3"),
                "g1" to listOf("s1", "s2"),
                "g3" to listOf("s4"),
                // The loose one where the sidebar names it first, then the rest newest first.
                "other" to listOf("s5", "s6", "s7"),
            ),
            ids(sessionSections(overview, sessions)),
        )
    }

    @Test
    fun aGroupKeepsItsOwnOrderAndASessionIsListedOnce() {
        val overview = SidebarOverview(
            listOf(SidebarWindowView("main", null, listOf("g1", "g2"), listOf(group("g1", "s2", "s1", "gone"), group("g2", "s1", "s3")))),
        )
        assertEquals(
            listOf("g1" to listOf("s2", "s1"), "g2" to listOf("s3")),
            ids(sessionSections(overview, listOf(session("s1"), session("s2"), session("s3")))),
        )
    }

    @Test
    fun aGroupTheTopLevelDoesNotNameFollowsTheNamedOnes() {
        val overview = SidebarOverview(listOf(SidebarWindowView("main", null, listOf("g2"), listOf(group("g1", "s1"), group("g2", "s2")))))
        assertEquals(listOf("g2", "g1"), sessionSections(overview, listOf(session("s1"), session("s2"))).map { it.groupId })
    }

    @Test
    fun aWorkspaceShowsItsGroupsAndItsSessionsAlone() {
        val overview = SidebarOverview(
            listOf(
                SidebarWindowView("main", "ws1", listOf("g1", "g2"), listOf(group("g1", "s1", "s2"), group("g2", "s3", workspaceId = "ws2"))),
                SidebarWindowView("other", "ws2", listOf("g3"), listOf(group("g3", "s4"))),
            ),
        )
        val sessions = listOf(session("s1", workspaceId = "ws1"), session("s2", workspaceId = "ws2"), session("s3", workspaceId = "ws2"), session("s4", workspaceId = "ws2"), session("s5"))
        // ws1: g1 holds s1 (s2 is another workspace's); g2 and g3 are ws2's; the unstamped s5 is in every workspace.
        assertEquals(listOf("g1" to listOf("s1"), "other" to listOf("s5")), ids(sessionSections(overview, sessions, "ws1")))
        assertEquals(
            listOf("g2" to listOf("s3"), "g3" to listOf("s4"), "other" to listOf("s2", "s5")),
            ids(sessionSections(overview, sessions, "ws2")).let { list -> list.map { (g, s) -> g to s.sortedBy { it } } },
        )
    }

    @Test
    fun withoutAnOverviewEverySessionIsInOneSection() {
        val sections = sessionSections(null, listOf(session("a", createdAt = 1), session("b", createdAt = 2)))
        assertEquals(listOf("other" to listOf("b", "a")), ids(sections))
        assertEquals(OTHER_SESSIONS, sections.single().name)
        assertEquals(emptyList<SessionSection>(), sessionSections(null, emptyList()))
    }

    @Test
    fun theDesktopsFoldAndColourAreCarried() {
        val overview = SidebarOverview(listOf(SidebarWindowView("main", null, listOf("g1"), listOf(group("g1", "s1", collapsed = true)))))
        val section = sessionSections(overview, listOf(session("s1"))).single()
        assertTrue(section.collapsedOnDesktop)
        assertEquals("blue", section.color)
        assertEquals("Group g1", groupNameOf(overview, "s1"))
        assertNull(groupNameOf(overview, "s9"))
    }

    @Test
    fun recentSessionsAreByLastHeardActivityThenCreation() {
        val sessions = listOf(session("old", createdAt = 1), session("new", createdAt = 50), session("busy", createdAt = 2))
        assertEquals(listOf("busy", "new", "old"), recentSessions(sessions, mapOf("busy" to 100)).map { it.id })
        assertEquals(listOf("busy"), recentSessions(sessions, mapOf("busy" to 100), limit = 1).map { it.id })
    }

    // ── limits ──

    private fun window(kind: String, used: Double, scope: String? = null, severity: UsageSeverity? = null, resetsAt: Long? = null) =
        UsageWindow(kind, kind, kind, scope, used, resetsAt, severity)

    @Test
    fun anAccountIsExhaustedByASharedCapAtFivePercentLeftOrCritical() {
        assertTrue(windowExhausted(window("session", 95.0)))
        assertFalse(windowExhausted(window("session", 94.9)))
        assertTrue(windowExhausted(window("session", 10.0, severity = UsageSeverity.Critical)))
        val limits = accountLimitsOf(UsageRead.Limits(listOf(window("session", 40.0), window("weekly_all", 96.0)), 0))!!
        assertTrue(limits.exhausted)
        assertEquals("weekly_all", limits.tightest?.kind)
    }

    @Test
    fun aFamilyCapOutNeverExhaustsTheAccount() {
        val limits = accountLimitsOf(
            UsageRead.Limits(listOf(window("session", 30.0), window("weekly_scoped", 100.0, scope = "Fable"), window("weekly_scoped", 60.0, scope = " ")), 0),
        )!!
        assertFalse(limits.exhausted)
        assertEquals(listOf("Fable"), limits.familiesOut)
        // A scope of blanks names no family: that cap is shared, and the tightest.
        assertEquals(60.0, limits.tightest!!.usedPercentage, 0.0)
    }

    @Test
    fun theTightestPrefersTheCapOutThatComesBackLastThenSeverityThenUse() {
        val a = window("session", 97.0, resetsAt = 10)
        val b = window("weekly_all", 99.0, resetsAt = 50)
        assertEquals(b, tightestOf(listOf(a, b)))
        val warn = window("session", 50.0, severity = UsageSeverity.Warning)
        val more = window("weekly_all", 80.0)
        assertEquals(warn, tightestOf(listOf(more, warn)))
        assertEquals(more, tightestOf(listOf(window("session", 20.0), more)))
    }

    @Test
    fun unknownUsageIsNeverExhaustion() {
        assertNull(accountLimitsOf(null))
        assertNull(accountLimitsOf(UsageRead.Failed("No read yet")))
        val empty = accountLimitsOf(UsageRead.Limits(emptyList(), 0))!!
        assertFalse(empty.exhausted)
        assertNull(empty.tightest)
    }

    // ── defaults ──

    private fun profile(id: String, family: LauncherFamily = LauncherFamily.Claude, name: String = id) =
        LaunchProfileView(id, name, family, listOf(family.wire), listOf("--x"))

    private fun prefs(vararg custom: LaunchProfileView, defaults: Map<LauncherFamily, String> = emptyMap(), overrides: Map<String, Map<LauncherFamily, String>> = emptyMap()) =
        LaunchProfilePreferencesView(custom.toList(), defaults, overrides)

    @Test
    fun theChatProfilesAreTheBuiltInsThenTheSavedTwinsThenTheSavedChats() {
        val list = chatProfilesOf(
            prefs(profile("work"), profile("pi", LauncherFamily.Pi), profile("dev-echo-adapter"), profile("cx", LauncherFamily.Codex)),
        )
        assertEquals(listOf("claude-chat", "codex-chat", "chat:claude:work", "chat:codex:cx", "dev-echo-adapter"), list.map { it.id })
        val twin = list[2]
        assertEquals("work (chat)", twin.name)
        assertEquals("work", twin.sourceProfileId)
        assertEquals(listOf("--x"), twin.additionalArgs)
        assertEquals(listOf("claude-chat", "codex-chat"), chatProfilesOf(null).map { it.id })
    }

    @Test
    fun theDefaultWorkspaceIsTheLastUsedThenTheMacsLastActiveThenTheFirst() {
        val ws = listOf(WorkspaceView("a", "A", "/a", null, 1), WorkspaceView("b", "B", "/b", null, 2))
        assertEquals("b", defaultWorkspace(ws, "b", "a")?.id)
        assertEquals("a", defaultWorkspace(ws, "gone", "a")?.id)
        assertEquals("a", defaultWorkspace(ws, null, null)?.id)
        assertNull(defaultWorkspace(emptyList(), "a", "a"))
    }

    @Test
    fun theDefaultProfileIsTheLastUsedThenTheMacsDefaultThenTheFirst() {
        val p = prefs(profile("work"), defaults = mapOf(LauncherFamily.Codex to "codex-chat", LauncherFamily.Claude to "work"))
        val list = chatProfilesOf(p)
        assertEquals("codex-chat", defaultChatProfile(list, p, "codex-chat")?.id)
        // Claude's default names a saved terminal profile: its chat twin stands for it.
        assertEquals("chat:claude:work", defaultChatProfile(list, p, "gone")?.id)
        val overridden = prefs(profile("work"), defaults = mapOf(LauncherFamily.Claude to "work"), overrides = mapOf("ws1" to mapOf(LauncherFamily.Claude to "claude-chat")))
        assertEquals("claude-chat", defaultChatProfile(chatProfilesOf(overridden), overridden, null, "ws1")?.id)
        assertEquals("claude-chat", defaultChatProfile(list, null, null)?.id)
        assertNull(defaultChatProfile(emptyList(), p, null))
    }
}
