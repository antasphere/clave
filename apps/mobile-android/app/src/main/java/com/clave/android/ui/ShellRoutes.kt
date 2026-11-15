package com.clave.android.ui

import android.content.ActivityNotFoundException
import android.content.Intent
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavHostController
import com.clave.android.BuildConfig
import com.clave.android.Development
import com.clave.core.state.ShellPrefs
import com.clave.ui.screens.AccountsScreen
import com.clave.ui.screens.HomeScreen
import com.clave.ui.screens.QuickComposerActions
import com.clave.ui.screens.SessionsScreen
import com.clave.ui.screens.SettingsScreen
import com.clave.ui.screens.basename

/** The chat a new session opens on, the composer's text sent in it once. */
private fun openNewChat(nav: NavHostController, machineId: String, sessionId: String, folderName: String, text: String) {
    nav.navigate(Routes.chat(machineId, sessionId, folderName, message = text)) { launchSingleTop = true }
}

/**
 * The machine's landing screen: connects, remembers it as the one a cold launch opens on,
 * and reads what Home shows (workspaces, sessions, requests, profiles, the shell's reads).
 * Send starts a chat and opens it with the text, which the chat sends once (ChatRoute).
 */
@Composable
internal fun HomeRoute(nav: NavHostController, viewModel: ClaveViewModel, machineId: String) {
    val store by viewModel.store.collectAsStateWithLifecycle()
    val owner by viewModel.owner.collectAsStateWithLifecycle()
    val shell by viewModel.shell.collectAsStateWithLifecycle()
    val prefs by viewModel.prefs.collectAsStateWithLifecycle()
    val drafts by viewModel.composer.collectAsStateWithLifecycle()
    val paired by viewModel.paired.collectAsStateWithLifecycle()
    val starting by viewModel.starting.collectAsStateWithLifecycle()
    val refusals by viewModel.refusals.collectAsStateWithLifecycle()
    val now = rememberNow(30_000)
    val source = launchSourceOf(store, machineId)
    LaunchedEffect(machineId, owner) {
        viewModel.openMachine(machineId)
        viewModel.loadPrefs(machineId)
        viewModel.loadWorkspaces(machineId)
        viewModel.loadSessions(machineId)
        viewModel.loadRequests(machineId)
        viewModel.loadShell(machineId)
    }
    LaunchedEffect(source, owner) { viewModel.loadProfiles(source) }
    val draft = drafts[machineId] ?: ComposerDraft()
    val pick = composerPick(store, machineId, draft, prefs[machineId] ?: ShellPrefs())
    HomeScreen(
        state = homeState(
            store, shell[machineId], machineId, paired, draft, prefs[machineId] ?: ShellPrefs(),
            starting[machineId], refusals[machineId], now, autoFocus = true,
        ),
        onTextChange = { viewModel.setComposerText(machineId, it) },
        onSend = {
            viewModel.quickStart(machineId) { info, text -> openNewChat(nav, machineId, info.id, info.folderName, text) }
        },
        onPickWorkspace = { viewModel.pickComposerWorkspace(machineId, it) },
        onPickProfile = { viewModel.pickComposerProfile(machineId, it) },
        onMoreOptions = { pick.workspace?.let { nav.navigate(Routes.launch(machineId, it.id)) } },
        onOpenSession = { s -> nav.navigate(Routes.chat(machineId, s.id, s.title.ifEmpty { basename(s.cwd) })) },
        onAllSessions = { nav.navigate(Routes.sessions(machineId)) },
        onRequests = { nav.navigate(Routes.requests(machineId)) },
        onLimits = { nav.navigate(Routes.accounts(machineId)) },
        onSettings = { nav.navigate(Routes.settings(machineId)) },
        onSwitchMachine = { openRoot(nav, Routes.home(it)) },
        onRefresh = { viewModel.refreshMachine(machineId) },
    )
}

/** The session list, grouped as on the desktop, with the quick composer a tap away. */
@Composable
internal fun SessionsRoute(nav: NavHostController, viewModel: ClaveViewModel, machineId: String, workspaceId: String?) {
    val store by viewModel.store.collectAsStateWithLifecycle()
    val owner by viewModel.owner.collectAsStateWithLifecycle()
    val shell by viewModel.shell.collectAsStateWithLifecycle()
    val prefs by viewModel.prefs.collectAsStateWithLifecycle()
    val drafts by viewModel.composer.collectAsStateWithLifecycle()
    val starting by viewModel.starting.collectAsStateWithLifecycle()
    val refusals by viewModel.refusals.collectAsStateWithLifecycle()
    var selected by rememberSaveable { mutableStateOf(workspaceId) }
    LaunchedEffect(machineId, owner) {
        viewModel.loadPrefs(machineId)
        if (viewModel.store.value.workspaces[machineId] == null) viewModel.loadWorkspaces(machineId)
        viewModel.loadSessions(machineId)
        viewModel.refreshGroups(machineId)
    }
    // The list's workspace is where its "New chat" starts.
    LaunchedEffect(selected) { selected?.let { viewModel.pickComposerWorkspace(machineId, it) } }
    val machinePrefs = prefs[machineId] ?: ShellPrefs()
    val draft = drafts[machineId] ?: ComposerDraft()
    val pick = composerPick(store, machineId, draft, machinePrefs)
    SessionsScreen(
        state = sessionsState(store, shell[machineId], machineId, selected, machinePrefs),
        onOpen = { s -> nav.navigate(Routes.chat(machineId, s.id, s.title.ifEmpty { basename(s.cwd) })) },
        onPickWorkspace = { selected = it },
        onToggleGroup = { group, folded -> viewModel.setGroupFolded(machineId, group, folded) },
        onRefresh = {
            viewModel.loadSessions(machineId)
            viewModel.refreshGroups(machineId)
        },
        onBack = { nav.popBackStack() },
        composer = composerState(store, machineId, draft, machinePrefs, starting[machineId], refusals[machineId]),
        composerActions = QuickComposerActions(
            onTextChange = { viewModel.setComposerText(machineId, it) },
            onSend = { viewModel.quickStart(machineId) { info, text -> openNewChat(nav, machineId, info.id, info.folderName, text) } },
            onPickWorkspace = { viewModel.pickComposerWorkspace(machineId, it) },
            onPickProfile = { viewModel.pickComposerProfile(machineId, it) },
            onMoreOptions = { pick.workspace?.let { nav.navigate(Routes.launch(machineId, it.id)) } },
        ),
    )
}

/** Settings of the current machine; Machines and Sign out reach the phone's whole account. */
@Composable
internal fun SettingsRoute(nav: NavHostController, viewModel: ClaveViewModel, machineId: String) {
    val context = LocalContext.current
    val store by viewModel.store.collectAsStateWithLifecycle()
    val owner by viewModel.owner.collectAsStateWithLifecycle()
    val shell by viewModel.shell.collectAsStateWithLifecycle()
    val prefs by viewModel.prefs.collectAsStateWithLifecycle()
    val paired by viewModel.paired.collectAsStateWithLifecycle()
    val auth by viewModel.auth.collectAsStateWithLifecycle()
    val appearance by viewModel.appearance.collectAsStateWithLifecycle()
    val signingOut by viewModel.signingOut.collectAsStateWithLifecycle()
    // Read again on every composition: the person may come back from the system settings.
    val notificationsAllowed = NotificationManagerCompat.from(context).areNotificationsEnabled()
    LaunchedEffect(machineId, owner) {
        viewModel.loadPrefs(machineId)
        viewModel.loadShell(machineId)
    }
    val card = Development.machinesCard
    SettingsScreen(
        state = settingsState(
            store, shell[machineId], machineId, paired, prefs[machineId] ?: ShellPrefs(), auth,
            appearance.label, notificationsAllowed, "${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})", signingOut,
        ),
        onMachines = { nav.navigate(Routes.MACHINES) { launchSingleTop = true } },
        onAccounts = { nav.navigate(Routes.accounts(machineId)) },
        onDefaultWorkspace = { viewModel.setDefaultWorkspace(machineId, it) },
        onDefaultProfile = { viewModel.setDefaultProfile(machineId, it) },
        onAppearance = { nav.navigate(Routes.APPEARANCE) },
        onNotificationSettings = {
            val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            try {
                context.startActivity(intent)
            } catch (_: ActivityNotFoundException) {
                viewModel.showNotice("This phone has no notification settings to open.")
            }
        },
        onSignOut = {
            viewModel.signOut()
            openRoot(nav, Routes.MACHINES)
        },
        onBack = { nav.popBackStack() },
        developer = card?.let { { it { nav.navigate(Routes.DEVELOPER) } } },
    )
}

/** The machine's agent accounts and their limits, read again as the page opens. */
@Composable
internal fun AccountsRoute(nav: NavHostController, viewModel: ClaveViewModel, machineId: String) {
    val store by viewModel.store.collectAsStateWithLifecycle()
    val owner by viewModel.owner.collectAsStateWithLifecycle()
    val shell by viewModel.shell.collectAsStateWithLifecycle()
    val now = rememberNow(30_000)
    LaunchedEffect(machineId, owner) { viewModel.refreshLimits(machineId) }
    AccountsScreen(
        state = accountsState(store, shell[machineId], machineId, now),
        onRefresh = { viewModel.refreshLimits(machineId) },
        onBack = { nav.popBackStack() },
    )
}

/**
 * The quick composer's message, sent once through the chat's own send path as the chat opens:
 * the draft set, then [ChatSession.send], so the delivery, its ledger and its unknown-outcome
 * choice are the chat's, never a second path. Kept as sent across a recreation of the screen
 * (saved with the back stack entry), so a rotation or a return never sends it again.
 */
@Composable
internal fun SendOnce(chat: ChatSession?, message: String?) {
    var sent by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(chat, message) {
        if (chat == null || message.isNullOrBlank() || sent) return@LaunchedEffect
        sent = true
        chat.setDraft(message)
        chat.send()
    }
}
