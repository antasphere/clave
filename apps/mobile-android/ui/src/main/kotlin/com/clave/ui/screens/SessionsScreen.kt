package com.clave.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import com.clave.core.contract.Session
import com.clave.core.contract.Transport
import com.clave.ui.components.ButtonKind
import com.clave.ui.components.ClaveButton
import com.clave.ui.components.ClaveIconButton
import com.clave.ui.components.EmptyState
import com.clave.ui.components.ListRow
import com.clave.ui.components.Notice
import com.clave.ui.components.NoticeKind
import com.clave.ui.components.PaneHeader
import com.clave.ui.components.ScreenScaffold
import com.clave.ui.components.SectionLabel
import com.clave.ui.components.StatusDot
import com.clave.ui.components.StatusWord
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveIcon
import com.clave.ui.theme.Icon
import com.clave.ui.theme.Metrics
import com.clave.ui.theme.Reachability
import com.clave.ui.theme.SessionStatus

/** A session and the state the phone shows for it, already mapped (the fatal error folded in). */
@Immutable
data class SessionRow(val session: Session, val status: SessionStatus)

/** One workspace's sessions, in the caller's order (chats first); null until the first answer. */
@Immutable
data class SessionsScreenState(
    val workspaceName: String?,
    val machineName: String?,
    val sessions: List<SessionRow>?,
    val error: String?,
    val reachability: Reachability,
)

/** A session's name: its title, or the folder it runs in when it has none. */
internal fun sessionTitle(session: Session): String = session.title.ifEmpty { basename(session.cwd) }

/**
 * A workspace's sessions. A chat opens on the phone; a terminal is listed for what it is and
 * stays on the Mac, so its row has no chevron and takes no tap. Each row says its state in
 * a dot and a word; whether the machine answers is said once, above the list.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
    state: SessionsScreenState,
    onOpen: (Session) -> Unit,
    onLaunch: () -> Unit,
    onRefresh: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = Clave.colors
    ScreenScaffold(
        modifier = modifier,
        header = {
            PaneHeader(
                title = state.workspaceName ?: "Sessions",
                subtitle = state.machineName,
                onBack = onBack,
                actions = { ClaveIconButton(ClaveIcon.Plus, onClick = onLaunch, contentDescription = "New session") },
            )
        },
    ) { padding ->
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
                SectionLabel("Sessions")
                val sessions = state.sessions
                when {
                    !sessions.isNullOrEmpty() -> sessions.forEach { row ->
                        val s = row.session
                        val chat = s.transport == Transport.Events
                        ListRow(
                            title = sessionTitle(s),
                            subtitle = if (chat) {
                                "${s.provider} · ${basename(s.cwd)}"
                            } else {
                                "Terminal · ${basename(s.cwd)} · read-only on the phone"
                            },
                            leading = {
                                Box(Modifier.size(Metrics.controlIcon), contentAlignment = Alignment.Center) {
                                    StatusDot(row.status.color(c.shared), pulsing = row.status.pulses)
                                }
                            },
                            trailing = {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Metrics.space(2))) {
                                    StatusWord(row.status)
                                    if (chat) Icon(ClaveIcon.ChevronRight, contentDescription = null, tint = c.theme.textTertiary)
                                }
                            },
                            onClick = if (chat) ({ onOpen(s) }) else null,
                        )
                    }
                    sessions == null && state.error == null -> Loading()
                    else -> EmptyState(
                        ClaveIcon.ChatBubbleLeftRight,
                        "No session in ${state.workspaceName ?: "this workspace"} yet",
                        text = "Start one from a saved profile.",
                        action = { ClaveButton("New session", onClick = onLaunch, kind = ButtonKind.Primary) },
                    )
                }
            }
        }
    }
}
