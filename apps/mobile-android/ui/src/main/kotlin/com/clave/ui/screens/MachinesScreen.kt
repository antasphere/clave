package com.clave.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import com.clave.core.contract.MachinePlatform
import com.clave.core.devices.Machine
import com.clave.ui.components.Badge
import com.clave.ui.components.ButtonKind
import com.clave.ui.components.ClaveButton
import com.clave.ui.components.ClaveIconButton
import com.clave.ui.components.ClaveTextField
import com.clave.ui.components.EmptyState
import com.clave.ui.components.ListRow
import com.clave.ui.components.Notice
import com.clave.ui.components.NoticeKind
import com.clave.ui.components.PaneHeader
import com.clave.ui.components.Rule
import com.clave.ui.components.ScreenScaffold
import com.clave.ui.components.SectionLabel
import com.clave.ui.components.StatusWord
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveIcon
import com.clave.ui.theme.ClaveTypography
import com.clave.ui.theme.Icon
import com.clave.ui.theme.Metrics
import com.clave.ui.theme.Reachability

/**
 * Who is signed in and how, the way Settings → Accounts says it on the desktop, with the
 * team relay the machines are reached through. A failure is the sign-in's own sentence.
 */
@Immutable
data class AccountState(
    val signedIn: Boolean,
    val name: String?,
    val email: String?,
    val signingIn: Boolean,
    val signingOut: Boolean,
    val relayUrl: String,
    val lastFailure: String?,
)

/**
 * One machine as the list shows it: whether this phone holds a credential for it (a tap
 * opens it, else pairs with it), whether it is the main one, and its reachability once the
 * phone has tried it; until then the relay's online flag stands in.
 */
@Immutable
data class MachineRow(
    val machine: Machine,
    val paired: Boolean,
    val main: Boolean,
    val reachability: Reachability?,
)

/** Everything the machines screen draws; [now] dates the "seen 5 min ago" lines. */
@Immutable
data class MachinesScreenState(
    val account: AccountState,
    val machines: List<MachineRow>,
    val loading: Boolean,
    val error: String?,
    val now: Long,
)

/**
 * The first screen: the account, then the Macs and Clave servers it reaches. A paired
 * machine opens on a tap, an unpaired one starts the pairing; the actions a long list of
 * rows cannot hold (making one the main machine, forgetting a development server) sit
 * behind the row's "More" button. Forgetting is offered only for a `dev:` machine and only
 * when the build passes [onForget]. The [developer] slot is the debug build's own card.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MachinesScreen(
    state: MachinesScreenState,
    onSignIn: () -> Unit,
    onSignOut: () -> Unit,
    onRelayUrlChange: (String) -> Unit,
    onConnectRelay: () -> Unit,
    onRefresh: () -> Unit,
    onOpen: (Machine) -> Unit,
    onPair: (Machine) -> Unit,
    onMakeMain: (Machine) -> Unit,
    onForget: ((Machine) -> Unit)?,
    onAppearance: () -> Unit,
    modifier: Modifier = Modifier,
    developer: (@Composable () -> Unit)? = null,
) {
    var actionsFor by remember { mutableStateOf<MachineRow?>(null) }
    ScreenScaffold(
        modifier = modifier,
        header = {
            PaneHeader(
                title = "Machines",
                subtitle = "Your Macs and Clave servers",
                actions = { ClaveIconButton(ClaveIcon.PaintBrush, onClick = onAppearance, contentDescription = "Appearance") },
            )
        },
    ) { padding ->
        PullToRefreshBox(isRefreshing = state.loading, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) {
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(padding)
                    .padding(vertical = Metrics.space(4)),
                verticalArrangement = Arrangement.spacedBy(Metrics.space(6)),
            ) {
                AccountSection(state.account, onSignIn, onSignOut, onRelayUrlChange, onConnectRelay)
                Column {
                    SectionLabel("Machines")
                    if (state.error != null) {
                        Notice(
                            state.error,
                            kind = NoticeKind.Destructive,
                            modifier = Modifier.padding(horizontal = Metrics.gutter).padding(bottom = Metrics.space(2)),
                        )
                    }
                    when {
                        state.machines.isNotEmpty() -> state.machines.forEach { row ->
                            MachineListRow(
                                row = row,
                                now = state.now,
                                onClick = { if (row.paired) onOpen(row.machine) else onPair(row.machine) },
                                onMore = { actionsFor = row },
                            )
                        }
                        state.loading -> Loading()
                        else -> EmptyState(
                            ClaveIcon.ComputerDesktop,
                            "No machine yet",
                            text = "Sign in to see your own machines; in a development build, add a server below.",
                        )
                    }
                }
                if (developer != null) developer()
            }
        }
    }
    val chosen = actionsFor
    if (chosen != null) {
        MachineActionsSheet(
            row = chosen,
            onMakeMain = { onMakeMain(chosen.machine) },
            onForget = onForget?.takeIf { chosen.machine.id.startsWith("dev:") }?.let { forget -> { forget(chosen.machine) } },
            onDismiss = { actionsFor = null },
        )
    }
}

/** The account's row and, once signed in, the team relay's address under it. */
@Composable
private fun AccountSection(
    account: AccountState,
    onSignIn: () -> Unit,
    onSignOut: () -> Unit,
    onRelayUrlChange: (String) -> Unit,
    onConnectRelay: () -> Unit,
) {
    val t = Clave.colors.theme
    Column {
        SectionLabel("Account")
        val leading: @Composable () -> Unit = { Icon(ClaveIcon.UserCircle, contentDescription = null, tint = t.textTertiary) }
        if (!account.signedIn) {
            ListRow(
                title = "Not signed in",
                subtitle = "Sign in with your Antasphere account to see your machines.",
                leading = leading,
            )
            ClaveButton(
                label = if (account.signingIn) "Signing in…" else "Sign in with Antasphere",
                onClick = onSignIn,
                kind = ButtonKind.Primary,
                enabled = !account.signingIn,
                modifier = Modifier.padding(horizontal = Metrics.gutter, vertical = Metrics.space(2)),
            )
        } else {
            ListRow(
                title = account.name ?: account.email ?: "Your Antasphere account",
                subtitle = "Signed in with Antasphere",
                leading = leading,
                trailing = {
                    ClaveButton(
                        label = if (account.signingOut) "Signing out…" else "Sign out",
                        onClick = onSignOut,
                        kind = ButtonKind.Secondary,
                        enabled = !account.signingOut,
                    )
                },
            )
            Column(
                Modifier.fillMaxWidth().padding(horizontal = Metrics.gutter, vertical = Metrics.space(2)),
                verticalArrangement = Arrangement.spacedBy(Metrics.space(2)),
            ) {
                BasicText("Team relay address", style = ClaveTypography.type(Metrics.textXs).copy(color = t.textSecondary))
                ClaveTextField(
                    value = account.relayUrl,
                    onValueChange = onRelayUrlChange,
                    placeholder = "https://your-team-relay.example",
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    enabled = !account.signingOut,
                    // The field is named by what it holds, not by its sample address: TalkBack
                    // says "Team relay address" whatever the placeholder or the typed value.
                    modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Team relay address" },
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    ClaveButton(
                        label = "Connect to team relay",
                        onClick = onConnectRelay,
                        kind = ButtonKind.Secondary,
                        enabled = !account.signingOut,
                    )
                }
            }
        }
        if (account.lastFailure != null) {
            Notice(
                "Sign-in could not complete. ${account.lastFailure}. Try again.",
                kind = NoticeKind.Destructive,
                modifier = Modifier.padding(horizontal = Metrics.gutter, vertical = Metrics.space(2)),
            )
        }
    }
}

/**
 * A machine's row: its name, what it is and when it was seen; then the "Main" badge, the
 * reachability the phone measured (the relay's online flag until it has), and "More".
 */
@Composable
private fun MachineListRow(row: MachineRow, now: Long, onClick: () -> Unit, onMore: () -> Unit) {
    val c = Clave.colors
    val m = row.machine
    ListRow(
        title = m.name,
        subtitle = describeMachine(m, now),
        onClick = onClick,
        leading = {
            Icon(
                if (m.platform == MachinePlatform.Macos) ClaveIcon.ComputerDesktop else ClaveIcon.ServerStack,
                contentDescription = null,
                tint = c.theme.textTertiary,
            )
        },
        trailing = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Metrics.space(2))) {
                if (row.main) Badge("Main")
                val reach = row.reachability
                when {
                    reach != null -> StatusWord(reach)
                    m.online -> StatusWord("Online", c.shared.statusReady)
                    else -> StatusWord("Offline", c.shared.statusInactive)
                }
                ClaveIconButton(
                    ClaveIcon.EllipsisHorizontal,
                    onClick = onMore,
                    contentDescription = "More about ${m.name}",
                    size = Metrics.controlSmHeight,
                )
            }
        },
    )
}

/** The machine's actions, the prototype's alert as a sheet: the name and address, then the choices. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MachineActionsSheet(row: MachineRow, onMakeMain: () -> Unit, onForget: (() -> Unit)?, onDismiss: () -> Unit) {
    val t = Clave.colors.theme
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = t.surfaceRaised) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = Metrics.space(4))) {
            Column(Modifier.padding(horizontal = Metrics.gutter, vertical = Metrics.space(2))) {
                BasicText(
                    row.machine.name,
                    style = ClaveTypography.type(Metrics.textSm, FontWeight.Medium).copy(color = t.textPrimary),
                )
                BasicText(row.machine.baseUrl, style = ClaveTypography.type(Metrics.textXs).copy(color = t.textTertiary))
            }
            Rule()
            if (row.main) {
                ListRow(title = "Already the main machine", modifier = Modifier.alpha(Metrics.disabledAlpha), trailing = {})
            } else {
                ListRow(title = "Make it the main machine", trailing = {}, onClick = {
                    onDismiss()
                    onMakeMain()
                })
            }
            if (onForget != null) {
                ListRow(title = "Forget this machine", trailing = {}, onClick = {
                    onDismiss()
                    onForget()
                })
            }
            ListRow(title = "Cancel", trailing = {}, onClick = onDismiss)
        }
    }
}
