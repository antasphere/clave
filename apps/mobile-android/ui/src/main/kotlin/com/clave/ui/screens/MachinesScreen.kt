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
import androidx.compose.runtime.saveable.rememberSaveable
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
import com.clave.core.devices.MachineAddress
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
 * Who is signed in and how, the way Settings → Accounts says it on the desktop. A failure is
 * the sign-in's own sentence.
 */
@Immutable
data class AccountState(
    val signedIn: Boolean,
    val name: String?,
    val email: String?,
    val signingIn: Boolean,
    val signingOut: Boolean,
    val lastFailure: String?,
)

/**
 * One machine address as its row shows it: how many machines it listed the last time, and
 * the sentence of its failure when it could not be read. [fromCache] says the machines it
 * lends are the last ones it listed, every one offline. [pending] says it is still being
 * asked while the others already answered.
 */
@Immutable
data class AddressRow(
    val address: MachineAddress,
    val machineCount: Int,
    val error: String?,
    val fromCache: Boolean,
    val pending: Boolean = false,
)

/**
 * One machine as the list shows it: whether this phone holds a credential for it (a tap
 * opens it, else pairs with it), whether it is the main one, and its reachability once the
 * phone has tried it; until then the address's online flag stands in. [listedBy] is the
 * label of the address that lists it, or the sentence saying a paired machine is listed by
 * none; null for a developer machine.
 */
@Immutable
data class MachineRow(
    val machine: Machine,
    val paired: Boolean,
    val main: Boolean,
    val reachability: Reachability?,
    val listedBy: String? = null,
)

/**
 * Everything the machines screen draws; [now] dates the "seen 5 min ago" lines. [error] is
 * the store's own (a developer server that failed); each address says its own failure on
 * its row. [addressError] is the sentence of an address the phone would not keep, and
 * [adding] says one is being added.
 */
@Immutable
data class MachinesScreenState(
    val account: AccountState,
    val machines: List<MachineRow>,
    val loading: Boolean,
    val error: String?,
    val now: Long,
    val addresses: List<AddressRow> = emptyList(),
    val addressError: String? = null,
    val adding: Boolean = false,
)

/**
 * The first screen: the account, the addresses the phone asks for machines, then the Macs
 * and Clave servers they list. A paired machine opens on a tap, an unpaired one starts the
 * pairing; the actions a long list of rows cannot hold (making one the main machine,
 * forgetting it) sit behind the row's "More" button. Forgetting is offered for a paired
 * machine and for a `dev:` one, when the build passes [onForget]. An address is renamed or
 * removed from its own sheet; [onAddAddress] gets the address, the name as typed and what
 * to do once it is kept (the form clears). The [developer] slot is the debug build's own card.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MachinesScreen(
    state: MachinesScreenState,
    onSignIn: () -> Unit,
    onSignOut: () -> Unit,
    onAddAddress: (url: String, name: String, onAdded: () -> Unit) -> Unit,
    onRenameAddress: (MachineAddress, String) -> Unit,
    onRemoveAddress: (MachineAddress) -> Unit,
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
    var addressFor by remember { mutableStateOf<MachineAddress?>(null) }
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
                AccountSection(state.account, onSignIn, onSignOut)
                if (state.account.signedIn) {
                    AddressesSection(
                        rows = state.addresses,
                        error = state.addressError,
                        adding = state.adding,
                        enabled = !state.account.signingOut,
                        onAdd = onAddAddress,
                        onMore = { addressFor = it },
                    )
                }
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
                        // Each address already says on its row what it listed or why it could not.
                        state.account.signedIn -> EmptyState(
                            ClaveIcon.ComputerDesktop,
                            "No machine yet",
                            text = "Add the address of a Mac, a Clave server or a relay to see its machines."
                                .takeIf { state.addresses.isEmpty() },
                        )
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
        val forgettable = chosen.paired || chosen.machine.id.startsWith("dev:")
        MachineActionsSheet(
            row = chosen,
            onMakeMain = { onMakeMain(chosen.machine) },
            onForget = onForget?.takeIf { forgettable }?.let { forget -> { forget(chosen.machine) } },
            onDismiss = { actionsFor = null },
        )
    }
    val address = addressFor
    if (address != null) {
        AddressActionsSheet(
            address = address,
            onRename = { onRenameAddress(address, it) },
            onRemove = { onRemoveAddress(address) },
            onDismiss = { addressFor = null },
        )
    }
}

/** The account's row: sign in, or who is signed in and the way out. */
@Composable
private fun AccountSection(
    account: AccountState,
    onSignIn: () -> Unit,
    onSignOut: () -> Unit,
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
 * A machine's row: its name, what it is and when it was seen, and under that the address
 * that lists it; then the "Main" badge, the reachability the phone measured (the address's
 * online flag until it has), and "More".
 */
@Composable
private fun MachineListRow(row: MachineRow, now: Long, onClick: () -> Unit, onMore: () -> Unit) {
    val c = Clave.colors
    val m = row.machine
    ListRow(
        title = m.name,
        subtitle = listOfNotNull(describeMachine(m, now), row.listedBy).joinToString("\n"),
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

/**
 * The addresses the phone asks for machines, each with what it listed or why it could not
 * be read, then the form that adds one. The form keeps what is typed until the address is
 * kept; a refused one stays in the field with the core's sentence under it.
 */
@Composable
private fun AddressesSection(
    rows: List<AddressRow>,
    error: String?,
    adding: Boolean,
    enabled: Boolean,
    onAdd: (url: String, name: String, onAdded: () -> Unit) -> Unit,
    onMore: (MachineAddress) -> Unit,
) {
    val t = Clave.colors.theme
    var url by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    Column {
        SectionLabel("Addresses")
        rows.forEach { row -> AddressListRow(row, onMore = { onMore(row.address) }) }
        Column(
            Modifier.fillMaxWidth().padding(horizontal = Metrics.gutter, vertical = Metrics.space(2)),
            verticalArrangement = Arrangement.spacedBy(Metrics.space(2)),
        ) {
            BasicText("Address", style = ClaveTypography.type(Metrics.textXs).copy(color = t.textSecondary))
            ClaveTextField(
                value = url,
                onValueChange = { url = it },
                placeholder = "https://your-mac.example",
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                enabled = enabled && !adding,
                // Named by what it holds, not by its sample address, whatever is typed.
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Machine address" },
            )
            BasicText("Name (optional)", style = ClaveTypography.type(Metrics.textXs).copy(color = t.textSecondary))
            ClaveTextField(
                value = name,
                onValueChange = { name = it },
                enabled = enabled && !adding,
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Address name" },
            )
            if (error != null) {
                Notice(error, kind = NoticeKind.Destructive)
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                ClaveButton(
                    label = if (adding) "Adding…" else "Add address",
                    onClick = {
                        onAdd(url, name) {
                            url = ""
                            name = ""
                        }
                    },
                    kind = ButtonKind.Secondary,
                    enabled = enabled && !adding && url.isNotBlank(),
                    busy = adding,
                )
            }
        }
    }
}

/**
 * An address's row: its name (or host) and its url, "More" for its sheet, and under it on
 * this row only how many machines it listed, or its failure in the destructive color, said
 * after "Showing its last list." when its machines come from its last answer.
 */
@Composable
private fun AddressListRow(row: AddressRow, onMore: () -> Unit) {
    val c = Clave.colors
    val label = row.address.label
    Column {
        ListRow(
            title = label,
            subtitle = row.address.url,
            onClick = onMore,
            leading = { Icon(ClaveIcon.GlobeAlt, contentDescription = null, tint = c.theme.textTertiary) },
            trailing = {
                ClaveIconButton(
                    ClaveIcon.EllipsisHorizontal,
                    onClick = onMore,
                    contentDescription = "More about the address $label",
                    size = Metrics.controlSmHeight,
                )
            },
        )
        val error = row.error
        val line = when {
            error != null && row.fromCache -> "Showing its last list. $error"
            error != null -> error
            row.pending -> "Asking…"
            row.machineCount == 1 -> "1 machine"
            else -> "${row.machineCount} machines"
        }
        BasicText(
            line,
            modifier = Modifier.padding(horizontal = Metrics.gutter).padding(bottom = Metrics.space(2)),
            style = ClaveTypography.type(Metrics.textXs, lineHeight = Metrics.proseLineHeight)
                .copy(color = if (error != null) c.shared.destructive else c.theme.textTertiary),
        )
    }
}

/**
 * An address's actions as a sheet: its label and url, then its name to change (Save, or
 * Clear name to show the host again), and its removal, which keeps every pairing made
 * through it.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AddressActionsSheet(address: MachineAddress, onRename: (String) -> Unit, onRemove: () -> Unit, onDismiss: () -> Unit) {
    val t = Clave.colors.theme
    var name by rememberSaveable(address.url) { mutableStateOf(address.name.orEmpty()) }
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = t.surfaceRaised) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = Metrics.space(4))) {
            Column(Modifier.padding(horizontal = Metrics.gutter, vertical = Metrics.space(2))) {
                BasicText(
                    address.label,
                    style = ClaveTypography.type(Metrics.textSm, FontWeight.Medium).copy(color = t.textPrimary),
                )
                BasicText(address.url, style = ClaveTypography.type(Metrics.textXs).copy(color = t.textTertiary))
            }
            Rule()
            Column(
                Modifier.fillMaxWidth().padding(horizontal = Metrics.gutter, vertical = Metrics.space(2)),
                verticalArrangement = Arrangement.spacedBy(Metrics.space(2)),
            ) {
                BasicText("Rename", style = ClaveTypography.type(Metrics.textXs).copy(color = t.textSecondary))
                ClaveTextField(
                    value = name,
                    onValueChange = { name = it },
                    modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Address name" },
                )
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(Metrics.space(2), Alignment.End),
                ) {
                    ClaveButton(
                        label = "Clear name",
                        onClick = {
                            onDismiss()
                            onRename("")
                        },
                        kind = ButtonKind.Secondary,
                        enabled = address.name != null,
                    )
                    ClaveButton(
                        label = "Save",
                        onClick = {
                            onDismiss()
                            onRename(name)
                        },
                        kind = ButtonKind.Primary,
                    )
                }
            }
            Rule()
            ListRow(
                title = "Remove this address",
                subtitle = "Machines paired through it stay paired; forget one from its own row.",
                trailing = {},
                onClick = {
                    onDismiss()
                    onRemove()
                },
            )
            ListRow(title = "Cancel", trailing = {}, onClick = onDismiss)
        }
    }
}
