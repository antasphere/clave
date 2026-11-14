package com.clave.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import com.clave.ui.chat.ProviderMark
import com.clave.ui.components.ButtonKind
import com.clave.ui.components.ClaveButton
import com.clave.ui.components.ListRow
import com.clave.ui.components.PaneHeader
import com.clave.ui.components.Rule
import com.clave.ui.components.ScreenScaffold
import com.clave.ui.components.SectionLabel
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveIcon
import com.clave.ui.theme.Icon
import com.clave.ui.theme.Metrics

/** The words of a "use the last one" default, the choice every new-chat default starts on. */
const val LAST_USED: String = "Last used"

/**
 * Settings: the machines, the accounts and their limits, the new chat's defaults, the look,
 * the notifications, what this phone and the Mac run, and the way out. A default of null is
 * "Last used". [developer] is the debug build's own card, null in a release.
 */
@Immutable
data class SettingsScreenState(
    val machinesSummary: String,
    val defaultWorkspaceId: String?,
    val defaultProfileId: String?,
    val workspaces: List<WorkspaceChoice>,
    val profiles: List<ProfileChoice>,
    val appearance: String,
    /** Whether the system lets Clave post notifications. */
    val notificationsAllowed: Boolean,
    val appVersion: String,
    /** The Mac's Clave version, when the current machine's server said it or the relay knows it. */
    val macVersion: String?,
    val macName: String?,
    val accountName: String?,
    val accountEmail: String?,
    val signingOut: Boolean,
)

private enum class DefaultPicker { Workspace, Profile }

@Composable
fun SettingsScreen(
    state: SettingsScreenState,
    onMachines: () -> Unit,
    onAccounts: (() -> Unit)?,
    onDefaultWorkspace: (String?) -> Unit,
    onDefaultProfile: (String?) -> Unit,
    onAppearance: () -> Unit,
    onNotificationSettings: () -> Unit,
    onSignOut: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    developer: (@Composable () -> Unit)? = null,
) {
    val t = Clave.colors.theme
    var picker by rememberSaveable { mutableStateOf<DefaultPicker?>(null) }
    ScreenScaffold(modifier = modifier, header = { PaneHeader(title = "Settings", onBack = onBack) }) { padding ->
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(padding)
                .padding(vertical = Metrics.space(3)),
        ) {
            ListRow(
                title = "Machines",
                subtitle = state.machinesSummary,
                leading = { Icon(ClaveIcon.ComputerDesktop, contentDescription = null, tint = t.textTertiary) },
                onClick = onMachines,
            )
            if (onAccounts != null) {
                ListRow(
                    title = "Accounts & limits",
                    subtitle = state.macName?.let { "The agent accounts of $it" },
                    leading = { Icon(ClaveIcon.ChartBar, contentDescription = null, tint = t.textTertiary) },
                    onClick = onAccounts,
                )
            }
            Rule(Modifier.padding(vertical = Metrics.space(2)))

            SectionLabel("New chat")
            ListRow(
                title = "Default workspace",
                subtitle = state.workspaces.firstOrNull { it.id == state.defaultWorkspaceId }?.name ?: LAST_USED,
                leading = { Icon(ClaveIcon.Folder, contentDescription = null, tint = t.textTertiary) },
                onClick = if (state.workspaces.isEmpty()) null else ({ picker = DefaultPicker.Workspace }),
            )
            ListRow(
                title = "Default agent",
                subtitle = state.profiles.firstOrNull { it.id == state.defaultProfileId }?.name ?: LAST_USED,
                leading = { Icon(ClaveIcon.CpuChip, contentDescription = null, tint = t.textTertiary) },
                onClick = if (state.profiles.isEmpty()) null else ({ picker = DefaultPicker.Profile }),
            )
            Rule(Modifier.padding(vertical = Metrics.space(2)))

            SectionLabel("This phone")
            ListRow(
                title = "Appearance",
                subtitle = state.appearance,
                leading = { Icon(ClaveIcon.PaintBrush, contentDescription = null, tint = t.textTertiary) },
                onClick = onAppearance,
            )
            ListRow(
                title = "Notifications",
                subtitle = if (state.notificationsAllowed) "Allowed" else "Off: Clave cannot tell you when an agent needs you",
                leading = { Icon(ClaveIcon.Bell, contentDescription = null, tint = t.textTertiary) },
                trailing = { ClaveButton("Open settings", onClick = onNotificationSettings, kind = ButtonKind.Ghost) },
            )
            Rule(Modifier.padding(vertical = Metrics.space(2)))

            SectionLabel("About")
            ListRow(title = "Clave for Android", subtitle = state.appVersion)
            ListRow(
                title = state.macName?.let { "Clave on $it" } ?: "Clave on the Mac",
                subtitle = state.macVersion ?: "Version not known",
            )
            ListRow(
                title = "Signed in",
                subtitle = listOfNotNull(state.accountName, state.accountEmail).joinToString(" · ").ifEmpty { "Not signed in" },
                leading = { Icon(ClaveIcon.UserCircle, contentDescription = null, tint = t.textTertiary) },
            )
            if (developer != null) {
                Rule(Modifier.padding(vertical = Metrics.space(2)))
                SectionLabel("Developer")
                developer()
            }
            Rule(Modifier.padding(vertical = Metrics.space(2)))
            ClaveButton(
                label = if (state.signingOut) "Signing out…" else "Sign out",
                onClick = onSignOut,
                kind = ButtonKind.Destructive,
                icon = ClaveIcon.ArrowRightStartOnRectangle,
                enabled = !state.signingOut && state.accountEmail != null,
                modifier = Modifier.padding(horizontal = Metrics.gutter, vertical = Metrics.space(2)),
            )
        }
    }
    when (picker) {
        DefaultPicker.Workspace -> ChoiceSheet(title = "Default workspace", onDismiss = { picker = null }) {
            DefaultRow(LAST_USED, state.defaultWorkspaceId == null) {
                picker = null
                onDefaultWorkspace(null)
            }
            state.workspaces.forEach { w ->
                DefaultRow(w.name, state.defaultWorkspaceId == w.id, leading = { Icon(ClaveIcon.Folder, contentDescription = null, tint = t.textTertiary) }) {
                    picker = null
                    onDefaultWorkspace(w.id)
                }
            }
        }
        DefaultPicker.Profile -> ChoiceSheet(title = "Default agent", onDismiss = { picker = null }) {
            DefaultRow(LAST_USED, state.defaultProfileId == null) {
                picker = null
                onDefaultProfile(null)
            }
            state.profiles.forEach { p ->
                DefaultRow(p.name, state.defaultProfileId == p.id, leading = { ProviderMark(p.provider, size = Metrics.controlIcon) }) {
                    picker = null
                    onDefaultProfile(p.id)
                }
            }
        }
        null -> Unit
    }
}

@Composable
private fun DefaultRow(title: String, chosen: Boolean, leading: (@Composable () -> Unit)? = null, onClick: () -> Unit) {
    val t = Clave.colors.theme
    ListRow(
        title = title,
        leading = leading,
        trailing = { if (chosen) Icon(ClaveIcon.Check, contentDescription = "Chosen", tint = t.accent) },
        selected = chosen,
        onClick = onClick,
    )
}
