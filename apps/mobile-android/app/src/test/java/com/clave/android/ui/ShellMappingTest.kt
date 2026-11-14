package com.clave.android.ui

import com.clave.core.auth.AuthPhase
import com.clave.core.auth.AuthStatus
import com.clave.core.contract.AgentState
import com.clave.core.contract.ClaudeAccountView
import com.clave.core.contract.CodexAccountView
import com.clave.core.contract.LaunchProfilePreferencesView
import com.clave.core.contract.LaunchProfileView
import com.clave.core.contract.LauncherFamily
import com.clave.core.contract.MachinePlatform
import com.clave.core.contract.ServerInfoView
import com.clave.core.contract.Session
import com.clave.core.contract.SidebarGroupView
import com.clave.core.contract.SidebarOverview
import com.clave.core.contract.SidebarWindowView
import com.clave.core.contract.Transport
import com.clave.core.contract.UsageRead
import com.clave.core.contract.UsageSeverity
import com.clave.core.contract.UsageWindow
import com.clave.core.contract.WorkspaceView
import com.clave.core.devices.Machine
import com.clave.core.state.MachineShell
import com.clave.core.state.ShellPrefs
import com.clave.core.state.ShellRead
import com.clave.core.state.StoreState
import com.clave.ui.screens.AccountStatus
import com.clave.ui.screens.BarInk
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShellMappingTest {
    private val now = 1_800_000_000_000L

    private fun machine(id: String, name: String = id) =
        Machine(id, name, MachinePlatform.Macos, "1.40.0", online = true, lastSeen = null, baseUrl = "https://r.example/m/$id", pushUrl = "wss://r.example/m/$id/push")

    private fun session(id: String, workspaceId: String? = null, createdAt: Long = 1) = Session(
        id = id, provider = "claude", transport = Transport.Events, cwd = "/w/$id", windowKey = "main", workspaceId = workspaceId,
        state = AgentState.Idle, createdAt = createdAt, adapterId = "claude-chat", title = id,
    )

    private val workspaces = listOf(WorkspaceView("w1", "clave", "/w/clave", null, 0), WorkspaceView("w2", "notes", "/w/notes", null, 0))

    private val launchPrefs = LaunchProfilePreferencesView(
        customProfiles = listOf(LaunchProfileView("work", "Work", LauncherFamily.Claude, listOf("claude"), emptyList())),
        globalDefaults = mapOf(LauncherFamily.Claude to "work"),
        workspaceOverrides = emptyMap(),
    )

    private fun store(lastActive: String? = "w2") = StoreState(
        machines = listOf(machine("m", "Studio"), machine("other", "Build box"), machine("unpaired")),
        mainMachineId = "m",
        workspaces = mapOf("m" to workspaces),
        lastActiveWorkspace = mapOf("m" to lastActive),
        sessions = mapOf("m" to listOf(session("s1", "w1", 5), session("s2", "w2", 9), session("s3", null, 1))),
        stamps = mapOf("m" to mapOf("s1" to "w1", "s2" to "w2", "s3" to null)),
        profiles = mapOf("m" to launchPrefs),
    )

    // ── the quick composer ──

    @Test
    fun theComposerStartsInTheMacsLastActiveWorkspaceOnItsDefaultProfile() {
        val state = composerState(store(), "m", ComposerDraft("hi"), ShellPrefs(), starting = null, refusal = null)
        assertEquals("notes", state.workspace?.name)
        // Claude's default names a saved terminal profile: its chat twin starts the chat.
        assertEquals("chat:claude:work", state.profile?.id)
        assertEquals(listOf("claude-chat", "codex-chat", "chat:claude:work"), state.profiles.map { it.id })
        assertTrue(state.canSend)
    }

    @Test
    fun theChipsChoiceThenTheSettingsDefaultThenTheLastUsedWin() {
        val s = store()
        assertEquals("w1", composerPick(s, "m", ComposerDraft(), ShellPrefs(lastWorkspace = "w1")).workspace?.id)
        assertEquals("w2", composerPick(s, "m", ComposerDraft(), ShellPrefs(lastWorkspace = "w1", defaultWorkspace = "w2")).workspace?.id)
        assertEquals("w1", composerPick(s, "m", ComposerDraft(workspaceId = "w1"), ShellPrefs(defaultWorkspace = "w2")).workspace?.id)
        assertEquals("codex-chat", composerPick(s, "m", ComposerDraft(), ShellPrefs(lastProfile = "codex-chat")).profile?.id)
        assertEquals("claude-chat", composerPick(s, "m", ComposerDraft(profileId = "claude-chat"), ShellPrefs(defaultProfile = "codex-chat")).profile?.id)
        // No saved profile read yet: the built-ins are offered already.
        assertEquals("claude-chat", composerPick(s.copy(profiles = emptyMap()), "m", ComposerDraft(), ShellPrefs()).profile?.id)
    }

    @Test
    fun theComposerSaysWhyItWaits() {
        val loading = composerState(StoreState(machines = listOf(machine("m"))), "m", ComposerDraft("hi"), ShellPrefs(), null, null)
        assertEquals("Loading the workspaces…", loading.hint)
        assertFalse(loading.canSend)
        val empty = composerState(store().copy(workspaces = mapOf("m" to emptyList())), "m", ComposerDraft("hi"), ShellPrefs(), null, null)
        assertEquals("Add a workspace on the Mac to start a chat from here.", empty.hint)
        val refused = composerState(store(), "m", ComposerDraft("hi"), ShellPrefs(), "claude-chat", "Program \"codex\" was not found")
        assertEquals("Program \"codex\" was not found", refused.error)
        assertTrue(refused.starting)
        assertFalse(refused.canSend)
        assertFalse(composerState(store(), "m", ComposerDraft("   "), ShellPrefs(), null, null).canSend)
    }

    // ── Home ──

    private val claude = listOf(
        ClaudeAccountView("a1", "Work", hasToken = true, tokenInvalid = false),
        ClaudeAccountView("a2", "Old", hasToken = false, tokenInvalid = false),
    )
    private val codex = listOf(CodexAccountView("c1", "Key", "apiKey", hasCredential = true))

    private fun window(used: Double, kind: String = "session", scope: String? = null, severity: UsageSeverity? = null, resetsAt: Long? = null) =
        UsageWindow(kind, "$kind $scope", kind, scope, used, resetsAt, severity)

    private fun shell(
        claudeUsage: Map<String, UsageRead> = mapOf("a1" to UsageRead.Limits(listOf(window(40.0), window(96.0, "weekly_all", resetsAt = now + 60_000)), now - 120_000)),
    ) = MachineShell(
        overview = ShellRead.Loaded(SidebarOverview(listOf(SidebarWindowView("main", null, listOf("g1"), listOf(SidebarGroupView("g1", "Auth", "blue", false, null, listOf("s1"))))))),
        claudeAccounts = ShellRead.Loaded(claude),
        codexAccounts = ShellRead.Loaded(codex),
        claudeUsage = ShellRead.Loaded(claudeUsage),
        codexUsage = ShellRead.Loaded(emptyMap()),
        serverInfo = ShellRead.Loaded(ServerInfoView("1.42.0")),
        activity = mapOf("s3" to now),
    )

    @Test
    fun homeListsTheAccountsWithACredentialAndTheirTightestSharedCap() {
        val home = homeState(store(), shell(), "m", setOf("m", "other"), ComposerDraft(), ShellPrefs(), null, null, now)
        val limits = home.limits!!
        assertEquals(listOf("Work", "Key"), limits.map { it.label })
        assertTrue(limits[0].exhausted)
        assertEquals(96.0, limits[0].usedPercentage!!, 0.0)
        assertEquals(now + 60_000, limits[0].resetsAt)
        assertEquals("API key, no plan limits", limits[1].note)
        assertNull(home.limitsNote)
        assertEquals(listOf("m", "other"), home.machines.map { it.id })
        assertEquals("Studio", home.machineName)
    }

    @Test
    fun homesRecentSessionsSayTheirWorkspaceAndGroup() {
        val home = homeState(store(), shell(), "m", setOf("m"), ComposerDraft(), ShellPrefs(), null, null, now)
        val recent = home.recent!!
        // s3 was heard of just now, then the newest by creation.
        assertEquals(listOf("s3", "s2", "s1"), recent.map { it.session.id })
        assertEquals("Auth", recent.single { it.session.id == "s1" }.groupName)
        assertEquals("clave", recent.single { it.session.id == "s1" }.workspaceName)
        assertNull(recent.single { it.session.id == "s3" }.workspaceName)
        assertNull(homeState(StoreState(), null, "m", emptySet(), ComposerDraft(), ShellPrefs(), null, null, now).recent)
    }

    @Test
    fun anOlderMacHidesTheLimitsBehindALineAndNeverAnError() {
        val older = MachineShell(
            overview = ShellRead.Unsupported,
            claudeAccounts = ShellRead.Unsupported,
            codexAccounts = ShellRead.Unsupported,
            claudeUsage = ShellRead.Unsupported,
            codexUsage = ShellRead.Unsupported,
            serverInfo = ShellRead.Unsupported,
        )
        val home = homeState(store(), older, "m", setOf("m"), ComposerDraft(), ShellPrefs(), null, null, now)
        assertNull(home.limits)
        assertEquals(UPDATE_FOR_LIMITS, home.limitsNote)
        val sessions = sessionsState(store(), older, "m", null)
        assertEquals(UPDATE_FOR_GROUPS, sessions.groupsNote)
        assertEquals(listOf(null), sessions.sections!!.map { it.groupId })
        val accounts = accountsState(store(), older, "m", now)
        assertTrue(accounts.providers.all { it.note == UPDATE_FOR_LIMITS && it.error == null })
        // The Mac's version falls back to what the relay said of it.
        assertEquals("1.40.0", settingsState(store(), older, "m", setOf("m"), ShellPrefs(), noAuth, "System", true, "0.1.0 (1)", false).macVersion)
    }

    @Test
    fun theSessionListKeepsThePhonesFoldOverTheDesktops() {
        val sections = sessionsState(store(), shell(), "m", null, ShellPrefs(folds = mapOf("g1" to true))).sections!!
        assertEquals(listOf("g1", null), sections.map { it.groupId })
        assertTrue(sections[0].collapsed)
        assertEquals("clave", sections[0].rows.single().workspaceName)
        assertFalse(sessionsState(store(), shell(), "m", null).sections!![0].collapsed)
        // A workspace no longer listed reads as all of them.
        assertNull(sessionsState(store(), shell(), "m", "gone").workspaceId)
    }

    // ── Accounts & limits ──

    @Test
    fun accountsShowEveryCapWithItsInkAndTheExhaustedWord() {
        val usage = mapOf<String, UsageRead>(
            "a1" to UsageRead.Limits(
                listOf(window(40.0), window(70.0, "weekly_all", severity = UsageSeverity.Warning), window(100.0, "weekly_scoped", scope = "Fable")),
                now - 240_000,
            ),
            "a2" to UsageRead.Failed("Token refused", unauthorized = true),
        )
        val state = accountsState(store(), shell(usage), "m", now)
        val claudeCards = state.providers[0].accounts!!
        val work = claudeCards[0]
        assertEquals(AccountStatus.SignedIn, work.status)
        assertEquals(listOf(BarInk.Normal, BarInk.Warning, BarInk.Critical), work.bars.map { it.ink })
        assertFalse(work.exhausted)
        assertEquals(listOf("Fable"), work.familiesOut)
        assertEquals(now - 240_000, work.fetchedAt)
        val old = claudeCards[1]
        assertEquals(AccountStatus.NoCredential, old.status)
        assertEquals("The service refused this account's credential", old.readNote)
        val key = state.providers[1].accounts!!.single()
        assertEquals("API key, no plan limits", key.readNote)
        assertEquals(listOf("Claude", "Codex"), state.providers.map { it.title })
    }

    @Test
    fun aFailedFirstReadIsSaidAndALoadingOneSpins() {
        val failed = accountsState(store(), MachineShell(claudeAccounts = ShellRead.Failed("The server could not be reached.")), "m", now)
        assertEquals("The server could not be reached.", failed.providers[0].error)
        assertNull(failed.providers[0].accounts)
        val loading = accountsState(store(), null, "m", now)
        assertTrue(loading.providers.all { it.accounts == null && it.note == null && it.error == null })
    }

    // ── Settings ──

    private val noAuth = AuthStatus(AuthPhase.SignedOut, null, null, null, false, "", null)

    @Test
    fun settingsSayTheMachinesTheDefaultsAndTheVersions() {
        val state = settingsState(store(), shell(), "m", setOf("m", "other"), ShellPrefs(defaultProfile = "codex-chat"), noAuth, "Dark", false, "0.1.0 (1)", false)
        assertEquals("Studio · 2 machines paired", state.machinesSummary)
        assertEquals("1.42.0", state.macVersion)
        assertEquals("codex-chat", state.defaultProfileId)
        assertNull(state.defaultWorkspaceId)
        assertEquals(listOf("clave", "notes"), state.workspaces.map { it.name })
        assertEquals(3, state.profiles.size)
        assertFalse(state.notificationsAllowed)
        assertEquals("1 machine paired", settingsState(StoreState(machines = listOf(machine("x"))), null, null, setOf("x"), ShellPrefs(), noAuth, "Dark", true, "v", false).machinesSummary)
    }
}
