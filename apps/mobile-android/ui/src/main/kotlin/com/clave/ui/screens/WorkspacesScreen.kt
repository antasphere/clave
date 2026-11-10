package com.clave.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.clave.core.contract.WorkspaceView
import com.clave.core.devices.Machine
import com.clave.ui.components.Badge
import com.clave.ui.components.ClaveIconButton
import com.clave.ui.components.EmptyState
import com.clave.ui.components.ListRow
import com.clave.ui.components.Notice
import com.clave.ui.components.NoticeKind
import com.clave.ui.components.PaneHeader
import com.clave.ui.components.ScreenScaffold
import com.clave.ui.components.SectionLabel
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveIcon
import com.clave.ui.theme.Icon
import com.clave.ui.theme.Metrics
import com.clave.ui.theme.Reachability

/**
 * One machine's workspaces. [machine] is null when the machine left the list (or the list
 * is still loading, [machinesLoading]); [workspaces] is null until the first answer.
 */
@Immutable
data class WorkspacesScreenState(
    val machine: Machine?,
    val machinesLoading: Boolean,
    val workspaces: List<WorkspaceView>?,
    val error: String?,
    val reachability: Reachability,
    val pendingRequests: Int,
)

/** The header's way to the requests: the count when any wait, and the inbox. */
@Composable
internal fun RequestsAction(pending: Int, onRequests: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Metrics.space(1))) {
        if (pending > 0) Badge("$pending")
        ClaveIconButton(ClaveIcon.InboxStack, onClick = onRequests, contentDescription = "Requests, $pending pending")
    }
}

/**
 * The folders registered on a machine, each opening its sessions; the machine's
 * reachability above them and its pending requests one tap away in the header.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkspacesScreen(
    state: WorkspacesScreenState,
    onOpen: (WorkspaceView) -> Unit,
    onRequests: () -> Unit,
    onRefresh: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val t = Clave.colors.theme
    ScreenScaffold(
        modifier = modifier,
        header = {
            PaneHeader(
                title = state.machine?.name ?: "Workspaces",
                subtitle = "Workspaces",
                onBack = onBack,
                actions = { RequestsAction(state.pendingRequests, onRequests) },
            )
        },
    ) { padding ->
        if (state.machine == null) {
            Column(Modifier.padding(padding).padding(Metrics.gutter)) {
                if (state.machinesLoading) Loading() else Notice("That machine is not in the list any more.")
            }
            return@ScreenScaffold
        }
        PullToRefreshBox(isRefreshing = false, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) {
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(padding)
                    .padding(vertical = Metrics.space(3)),
            ) {
                MachineReachabilityRow(state.reachability)
                if (state.error != null) {
                    Notice(
                        state.error,
                        kind = NoticeKind.Destructive,
                        modifier = Modifier.padding(horizontal = Metrics.gutter, vertical = Metrics.space(2)),
                    )
                }
                SectionLabel("Workspaces")
                val workspaces = state.workspaces
                when {
                    !workspaces.isNullOrEmpty() -> workspaces.forEach { w ->
                        ListRow(
                            title = w.name,
                            subtitle = w.rootDir,
                            leading = { Icon(ClaveIcon.Folder, contentDescription = null, tint = t.textTertiary) },
                            onClick = { onOpen(w) },
                        )
                    }
                    workspaces == null && state.error == null -> Loading()
                    else -> EmptyState(
                        ClaveIcon.Folder,
                        "No workspace yet",
                        text = "Add one on the Mac, in Settings → General → Workspaces.",
                    )
                }
            }
        }
    }
}
