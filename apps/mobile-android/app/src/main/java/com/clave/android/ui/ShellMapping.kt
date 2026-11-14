package com.clave.android.ui

import com.clave.core.auth.AuthStatus
import com.clave.core.chat.WorkspaceRoot
import com.clave.core.chat.phoneSessionState
import com.clave.core.contract.LaunchProfileView
import com.clave.core.contract.Session
import com.clave.core.contract.UsageRead
import com.clave.core.contract.UsageSeverity
import com.clave.core.contract.UsageWindow
import com.clave.core.contract.WorkspaceView
import com.clave.core.state.MachineShell
import com.clave.core.state.ShellPrefs
import com.clave.core.state.ShellRead
import com.clave.core.state.StoreState
import com.clave.core.state.accountLimitsOf
import com.clave.core.state.chatProfilesOf
import com.clave.core.state.conversationKey
import com.clave.core.state.defaultChatProfile
import com.clave.core.state.defaultWorkspace
import com.clave.core.state.groupNameOf
import com.clave.core.state.recentSessions
import com.clave.core.state.sessionSections
import com.clave.core.state.valueOrNull
import com.clave.core.state.windowExhausted
import com.clave.ui.screens.AccountCard
import com.clave.ui.screens.AccountStatus
import com.clave.ui.screens.AccountsScreenState
import com.clave.ui.screens.BarInk
import com.clave.ui.screens.HomeScreenState
import com.clave.ui.screens.LimitChip
import com.clave.ui.screens.MachineChoice
import com.clave.ui.screens.ProfileChoice
import com.clave.ui.screens.ProviderAccounts
import com.clave.ui.screens.QuickComposerState
import com.clave.ui.screens.RecentRow
import com.clave.ui.screens.SessionRow
import com.clave.ui.screens.SessionSectionView
import com.clave.ui.screens.SessionsScreenState
import com.clave.ui.screens.SettingsScreenState
import com.clave.ui.screens.UsageBar
import com.clave.ui.screens.WorkspaceChoice
import com.clave.ui.screens.toStatus

/*
 * From the store, the shell's reads and the phone's preferences to the shell's screens (Home,
 * Sessions, Settings, Accounts & limits), as pure functions like Mapping.kt's.
 */

/** The line a section shows when the Mac's server does not offer its read to phones yet. */
const val UPDATE_FOR_GROUPS: String = "Update Clave on your Mac to see its groups here."
const val UPDATE_FOR_LIMITS: String = "Update Clave on your Mac to see its accounts and limits here."

/** What the quick composer holds for one machine beside the store: the text, and a choice made on its chips. */
data class ComposerDraft(val text: String = "", val workspaceId: String? = null, val profileId: String? = null)

/** Where and on what a new chat starts. */
data class ComposerPick(val workspace: WorkspaceView?, val profile: LaunchProfileView?, val profiles: List<LaunchProfileView>)

/**
 * The quick composer's workspace and profile: the chip's own choice, else the default set in
 * Settings, else the last used (ShellPrefs), else the Mac's (its last active workspace, its
 * default profile), else the first. The profiles are the chat profiles of the launch's source
 * machine, the built-ins listed even before its saved profiles are in.
 */
fun composerPick(store: StoreState, machineId: String, draft: ComposerDraft, prefs: ShellPrefs): ComposerPick {
    val workspaces = store.workspaces[machineId].orEmpty()
    val workspace = defaultWorkspace(workspaces, draft.workspaceId ?: prefs.preferredWorkspace, store.lastActiveWorkspace[machineId])
    val launchPrefs = store.profiles[launchSourceOf(store, machineId)]
    val profiles = chatProfilesOf(launchPrefs)
    val profile = defaultChatProfile(profiles, launchPrefs, draft.profileId ?: prefs.preferredProfile, workspace?.id)
    return ComposerPick(workspace, profile, profiles)
}

private fun choiceOf(p: LaunchProfileView) = ProfileChoice(p.id, p.name, p.family.wire)

/** The quick composer of [machineId]: [starting] the profile being started, [refusal] the server's own sentence. */
fun composerState(
    store: StoreState,
    machineId: String,
    draft: ComposerDraft,
    prefs: ShellPrefs,
    starting: String?,
    refusal: String?,
): QuickComposerState {
    val pick = composerPick(store, machineId, draft, prefs)
    val workspaces = store.workspaces[machineId]
    val workspacesError = store.workspacesError[machineId]
    return QuickComposerState(
        text = draft.text,
        workspace = pick.workspace?.let { WorkspaceChoice(it.id, it.name) },
        profile = pick.profile?.let(::choiceOf),
        workspaces = workspaces.orEmpty().map { WorkspaceChoice(it.id, it.name) },
        profiles = pick.profiles.map(::choiceOf),
        starting = starting != null,
        error = refusal ?: workspacesError?.takeIf { workspaces == null },
        hint = when {
            workspaces == null && workspacesError == null -> "Loading the workspaces…"
            workspaces != null && workspaces.isEmpty() -> "Add a workspace on the Mac to start a chat from here."
            else -> null
        },
    )
}

private fun statusOf(store: StoreState, machineId: String, s: Session) =
    phoneSessionState(s.state, store.fatal[conversationKey(machineId, s.id)]).toStatus()

private fun workspaceNameOf(store: StoreState, machineId: String, s: Session): String? {
    val stamp = store.stamps[machineId]?.get(s.id) ?: s.workspaceId ?: return null
    return store.workspaces[machineId]?.firstOrNull { it.id == stamp }?.name
}

/** The Home strip: each account with a credential, its tightest shared cap; none while the reads are out. */
private fun limitChips(shell: MachineShell): List<LimitChip>? {
    val claude = shell.claudeAccounts.valueOrNull()
    val codex = shell.codexAccounts.valueOrNull()
    if (claude == null && codex == null) return null
    val claudeUsage = shell.claudeUsage.valueOrNull().orEmpty()
    val codexUsage = shell.codexUsage.valueOrNull().orEmpty()
    fun chip(provider: String, id: String, label: String, read: UsageRead?, note: String?): LimitChip {
        val limits = accountLimitsOf(read)
        val tightest = limits?.tightest
        return LimitChip(
            provider = provider,
            label = label,
            usedPercentage = tightest?.usedPercentage,
            resetsAt = tightest?.resetsAt,
            exhausted = limits?.exhausted == true,
            note = note ?: (read as? UsageRead.Failed)?.error,
        )
    }
    return claude.orEmpty().filter { it.hasToken }.map { a ->
        chip("claude", a.id, a.label, claudeUsage[a.id], if (a.tokenInvalid) "Token refused" else null)
    } + codex.orEmpty().filter { it.hasCredential }.map { a ->
        val read = codexUsage[a.id]
        chip("codex", a.id, a.label, read, if (a.kind == "apiKey" && read !is UsageRead.Limits) "API key, no plan limits" else null)
    }
}

/** Whether the Mac offers none of the limits to the phone: every account and usage read unsupported. */
private fun limitsUnsupported(shell: MachineShell): Boolean =
    shell.claudeAccounts is ShellRead.Unsupported && shell.codexAccounts is ShellRead.Unsupported

/**
 * Home: the machine and the paired ones it can switch to, the quick composer, the requests
 * waiting, the limits strip (hidden behind a line on an older Mac), and the recent sessions
 * across workspaces.
 */
fun homeState(
    store: StoreState,
    shell: MachineShell?,
    machineId: String,
    paired: Set<String>,
    draft: ComposerDraft,
    prefs: ShellPrefs,
    starting: String?,
    refusal: String?,
    now: Long,
    autoFocus: Boolean = false,
): HomeScreenState {
    val s = shell ?: MachineShell()
    val unsupported = limitsUnsupported(s)
    val sessions = store.sessions[machineId]
    return HomeScreenState(
        machineName = store.machines.firstOrNull { it.id == machineId }?.name,
        machines = store.machines.filter { it.id in paired || it.id == machineId }.map { MachineChoice(it.id, it.name) },
        currentMachineId = machineId,
        reachability = reachabilityOf(store, machineId),
        composer = composerState(store, machineId, draft, prefs, starting, refusal),
        pendingRequests = pendingOf(store, machineId).size,
        limits = if (unsupported) null else limitChips(s),
        limitsNote = if (unsupported) UPDATE_FOR_LIMITS else null,
        recent = sessions?.let { list ->
            val overview = s.overview.valueOrNull()
            recentSessions(list, s.activity).map { session ->
                RecentRow(session, statusOf(store, machineId, session), workspaceNameOf(store, machineId, session), groupNameOf(overview, session.id))
            }
        },
        recentError = store.sessionsError[machineId],
        now = now,
        autoFocus = autoFocus,
    )
}

/**
 * The session list of one workspace or of all ([workspaceId] null), sectioned by the
 * desktop's groups (core/state `sessionSections`), each fold the phone's own choice when it
 * made one, else the desktop's.
 */
fun sessionsState(
    store: StoreState,
    shell: MachineShell?,
    machineId: String,
    workspaceId: String?,
    prefs: ShellPrefs = ShellPrefs(),
): SessionsScreenState {
    val workspaces = store.workspaces[machineId].orEmpty()
    val overviewRead = shell?.overview ?: ShellRead.Loading
    val sections = store.sessions[machineId]?.let { sessions ->
        sessionSections(
            overviewRead.valueOrNull(),
            sessions,
            workspaceId,
            store.stamps[machineId].orEmpty(),
            workspaces.map { WorkspaceRoot(it.id, it.rootDir) },
        ).map { section ->
            SessionSectionView(
                groupId = section.groupId,
                name = section.name,
                color = section.color,
                collapsed = section.groupId?.let { prefs.folds[it] } ?: section.collapsedOnDesktop,
                rows = section.sessions.map { s -> SessionRow(s, statusOf(store, machineId, s), workspaceNameOf(store, machineId, s)) },
            )
        }
    }
    return SessionsScreenState(
        machineName = store.machines.firstOrNull { it.id == machineId }?.name,
        workspaces = workspaces.map { WorkspaceChoice(it.id, it.name) },
        workspaceId = workspaceId?.takeIf { id -> workspaces.isEmpty() || workspaces.any { it.id == id } },
        sections = sections,
        error = store.sessionsError[machineId],
        reachability = reachabilityOf(store, machineId),
        groupsNote = when (overviewRead) {
            is ShellRead.Unsupported -> UPDATE_FOR_GROUPS
            is ShellRead.Failed -> "The groups could not be read: ${overviewRead.message}"
            else -> null
        },
    )
}

private fun inkOf(w: UsageWindow): BarInk = when {
    windowExhausted(w) || w.severity == UsageSeverity.Critical -> BarInk.Critical
    w.severity == UsageSeverity.Warning -> BarInk.Warning
    else -> BarInk.Normal
}

/** One account's card: its status, every cap as a bar, the desktop's exhausted word, and its read's age or why it has none. */
private fun card(id: String, label: String, status: AccountStatus, usage: ShellRead<Map<String, UsageRead>>, fallback: Boolean): AccountCard {
    val read = usage.valueOrNull()?.get(id)
    val limits = accountLimitsOf(read)
    return AccountCard(
        id = id,
        label = label,
        status = status,
        bars = (read as? UsageRead.Limits)?.windows.orEmpty().map { UsageBar(it.label, it.usedPercentage, it.resetsAt, inkOf(it)) },
        exhausted = limits?.exhausted == true,
        familiesOut = limits?.familiesOut.orEmpty(),
        fetchedAt = (read as? UsageRead.Limits)?.fetchedAt,
        readNote = when {
            read is UsageRead.Limits -> read.message
            read is UsageRead.Failed -> if (read.unauthorized) "The service refused this account's credential" else read.error
            usage is ShellRead.Unsupported -> "Update Clave on your Mac to see the limits"
            fallback -> "API key, no plan limits"
            status == AccountStatus.SignedIn -> "No usage read yet"
            else -> null
        },
    )
}

private fun <T> providerOf(
    provider: String,
    title: String,
    accounts: ShellRead<List<T>>,
    cards: (List<T>) -> List<AccountCard>,
): ProviderAccounts = when (accounts) {
    is ShellRead.Loaded -> ProviderAccounts(provider, title, cards(accounts.value))
    is ShellRead.Unsupported -> ProviderAccounts(provider, title, null, note = UPDATE_FOR_LIMITS)
    is ShellRead.Failed -> ProviderAccounts(provider, title, null, error = accounts.message)
    is ShellRead.Loading -> ProviderAccounts(provider, title, null)
}

/** Accounts & limits: Claude's accounts, then Codex's, each with its caps. */
fun accountsState(store: StoreState, shell: MachineShell?, machineId: String, now: Long): AccountsScreenState {
    val s = shell ?: MachineShell()
    return AccountsScreenState(
        machineName = store.machines.firstOrNull { it.id == machineId }?.name,
        providers = listOf(
            providerOf("claude", "Claude", s.claudeAccounts) { list ->
                list.map { a ->
                    val status = when {
                        a.tokenInvalid -> AccountStatus.TokenInvalid
                        !a.hasToken -> AccountStatus.NoCredential
                        else -> AccountStatus.SignedIn
                    }
                    card(a.id, a.label, status, s.claudeUsage, fallback = false)
                }
            },
            providerOf("codex", "Codex", s.codexAccounts) { list ->
                list.map { a ->
                    card(a.id, a.label, if (a.hasCredential) AccountStatus.SignedIn else AccountStatus.NoCredential, s.codexUsage, fallback = a.kind == "apiKey")
                }
            },
        ),
        now = now,
    )
}

/**
 * Settings of the current machine: how many machines this phone has paired, the new chat's
 * defaults (null is "Last used"), the look, the notifications, what runs where, and the account.
 */
fun settingsState(
    store: StoreState,
    shell: MachineShell?,
    machineId: String?,
    paired: Set<String>,
    prefs: ShellPrefs,
    auth: AuthStatus,
    appearance: String,
    notificationsAllowed: Boolean,
    appVersion: String,
    signingOut: Boolean,
): SettingsScreenState {
    val machine = store.machines.firstOrNull { it.id == machineId }
    val count = store.machines.count { it.id in paired }
    val pick = machineId?.let { composerPick(store, it, ComposerDraft(), ShellPrefs()) }
    return SettingsScreenState(
        machinesSummary = listOfNotNull(machine?.name, if (count == 1) "1 machine paired" else "$count machines paired").joinToString(" · "),
        defaultWorkspaceId = prefs.defaultWorkspace,
        defaultProfileId = prefs.defaultProfile,
        workspaces = machineId?.let { store.workspaces[it] }.orEmpty().map { WorkspaceChoice(it.id, it.name) },
        profiles = pick?.profiles.orEmpty().map(::choiceOf),
        appearance = appearance,
        notificationsAllowed = notificationsAllowed,
        appVersion = appVersion,
        macVersion = shell?.serverInfo?.valueOrNull()?.version ?: machine?.version?.takeIf { it.isNotEmpty() },
        macName = machine?.name,
        accountName = auth.account?.name,
        accountEmail = auth.account?.email,
        signingOut = signingOut,
    )
}
