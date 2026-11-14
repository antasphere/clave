package com.clave.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import com.clave.core.contract.Session
import com.clave.core.contract.Transport
import com.clave.ui.components.ButtonKind
import com.clave.ui.components.Chip
import com.clave.ui.components.ClaveButton
import com.clave.ui.components.EmptyState
import com.clave.ui.components.ListRow
import com.clave.ui.components.Notice
import com.clave.ui.components.NoticeKind
import com.clave.ui.components.PaneHeader
import com.clave.ui.components.ScreenScaffold
import com.clave.ui.components.StatusDot
import com.clave.ui.components.StatusWord
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveIcon
import com.clave.ui.theme.ClaveTypography
import com.clave.ui.theme.Icon
import com.clave.ui.theme.Metrics
import com.clave.ui.theme.Reachability
import com.clave.ui.theme.SessionStatus
import com.clave.ui.theme.groupColorOf

/** A session and the state the phone shows for it, already mapped (the fatal error folded in). */
@Immutable
data class SessionRow(val session: Session, val status: SessionStatus, val workspaceName: String? = null)

/** One section of the list: a desktop group (its colour, folded or open) or the sessions in none. */
@Immutable
data class SessionSectionView(
    /** The phone's key for the fold: the group's id, or null for the last section. */
    val groupId: String?,
    val name: String,
    val color: String?,
    val collapsed: Boolean,
    val rows: List<SessionRow>,
)

/**
 * The sessions of one workspace, or of all of them ([workspaceId] null), sectioned the way
 * the desktop's sidebar groups them; [sections] null until the first answer. [groupsNote]
 * says why there are no groups when the Mac does not offer them yet.
 */
@Immutable
data class SessionsScreenState(
    val machineName: String?,
    val workspaces: List<WorkspaceChoice>,
    val workspaceId: String?,
    val sections: List<SessionSectionView>?,
    val error: String?,
    val reachability: Reachability,
    val groupsNote: String? = null,
) {
    val workspaceName: String? get() = workspaces.firstOrNull { it.id == workspaceId }?.name
}

/** A session's name: its title, or the folder it runs in when it has none. */
internal fun sessionTitle(session: Session): String = session.title.ifEmpty { basename(session.cwd) }

/** A row's line under the title: the provider and the folder, or what a terminal is on the phone. */
internal fun sessionSubtitle(row: SessionRow, allWorkspaces: Boolean): String {
    val s = row.session
    val where = if (allWorkspaces && row.workspaceName != null) "${row.workspaceName} · ${basename(s.cwd)}" else basename(s.cwd)
    return if (s.transport == Transport.Events) "${s.provider} · $where" else "Terminal · $where · read-only on the phone"
}

/**
 * The sessions, grouped as on the desktop: a header per group with its colour, its name and
 * how many it holds, folding at a tap (the phone remembers each fold), and the sessions in no
 * group last. A chat opens on the phone; a terminal is listed for what it is and stays on the
 * Mac, so its row takes no tap. The chips above pick the workspace, or all of them. "New chat"
 * opens the quick composer over the list.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionsScreen(
    state: SessionsScreenState,
    onOpen: (Session) -> Unit,
    onPickWorkspace: (String?) -> Unit,
    onToggleGroup: (String, Boolean) -> Unit,
    onRefresh: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    composer: QuickComposerState? = null,
    composerActions: QuickComposerActions? = null,
) {
    val c = Clave.colors
    var composing by rememberSaveable { mutableStateOf(false) }
    ScreenScaffold(
        modifier = modifier,
        header = {
            PaneHeader(
                title = state.workspaceName ?: "All sessions",
                subtitle = state.machineName,
                onBack = onBack,
            )
        },
    ) { padding ->
        PullToRefreshBox(isRefreshing = false, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) {
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(padding)
                    .padding(top = Metrics.space(2), bottom = Metrics.space(20)),
            ) {
                if (state.workspaces.size > 1) {
                    Row(
                        Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = Metrics.gutter, vertical = Metrics.space(1)),
                        horizontalArrangement = Arrangement.spacedBy(Metrics.space(2)),
                    ) {
                        Chip("All", selected = state.workspaceId == null, onClick = { onPickWorkspace(null) })
                        state.workspaces.forEach { w ->
                            Chip(w.name, selected = state.workspaceId == w.id, onClick = { onPickWorkspace(w.id) })
                        }
                    }
                }
                MachineReachabilityRow(state.reachability)
                if (state.error != null) {
                    Notice(
                        state.error,
                        kind = NoticeKind.Destructive,
                        modifier = Modifier.padding(horizontal = Metrics.gutter, vertical = Metrics.space(2)),
                    )
                }
                if (state.groupsNote != null) {
                    BasicText(
                        state.groupsNote,
                        modifier = Modifier.padding(horizontal = Metrics.gutter, vertical = Metrics.space(1)),
                        style = ClaveTypography.type(Metrics.textXs, lineHeight = Metrics.proseLineHeight).copy(color = c.theme.textTertiary),
                    )
                }
                val sections = state.sections
                when {
                    !sections.isNullOrEmpty() -> sections.forEach { section ->
                        GroupHeader(section, onToggle = { g -> onToggleGroup(g, !section.collapsed) })
                        if (!section.collapsed) {
                            section.rows.forEach { row -> SessionListRow(row, state.workspaceId == null, onOpen) }
                        }
                    }
                    sections == null && state.error == null -> Loading()
                    else -> EmptyState(
                        ClaveIcon.ChatBubbleLeftRight,
                        "No session in ${state.workspaceName ?: "any workspace"} yet",
                        text = "Start a chat from here.",
                        action = if (composer != null) ({ ClaveButton("New chat", onClick = { composing = true }, kind = ButtonKind.Primary) }) else null,
                    )
                }
            }
        }
        if (composer != null) {
            Box(Modifier.fillMaxSize().padding(padding).navigationBarsPadding(), contentAlignment = Alignment.BottomEnd) {
                NewChatButton(onClick = { composing = true }, modifier = Modifier.padding(Metrics.gutter))
            }
        }
    }
    if (composing && composer != null && composerActions != null) {
        ModalBottomSheet(onDismissRequest = { composing = false }, containerColor = c.theme.surfaceRaised) {
            QuickComposer(
                state = composer,
                onTextChange = composerActions.onTextChange,
                onSend = composerActions.onSend,
                onPickWorkspace = composerActions.onPickWorkspace,
                onPickProfile = composerActions.onPickProfile,
                onMoreOptions = {
                    composing = false
                    composerActions.onMoreOptions()
                },
                modifier = Modifier.padding(horizontal = Metrics.gutter).padding(bottom = Metrics.space(4)).navigationBarsPadding(),
                autoFocus = true,
            )
        }
    }
}

/** What the quick composer does, handed down together by a screen that shows it in a sheet. */
@Immutable
data class QuickComposerActions(
    val onTextChange: (String) -> Unit,
    val onSend: () -> Unit,
    val onPickWorkspace: (String) -> Unit,
    val onPickProfile: (String) -> Unit,
    val onMoreOptions: () -> Unit,
)

@Composable
private fun GroupHeader(section: SessionSectionView, onToggle: (String) -> Unit) {
    val c = Clave.colors
    val t = c.theme
    val groupId = section.groupId
    val dot = groupColorOf(section.color) ?: t.textTertiary
    val fold = if (section.collapsed) "folded" else "open"
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = Metrics.rowMinHeight)
            .then(if (groupId != null) Modifier.clickable(role = Role.Button) { onToggle(groupId) } else Modifier)
            .semantics(mergeDescendants = true) {
                heading()
                contentDescription = "${section.name}, ${section.rows.size}"
                if (groupId != null) stateDescription = fold
            }
            .padding(horizontal = Metrics.gutter, vertical = Metrics.space(2)),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Metrics.space(2)),
    ) {
        if (groupId != null) {
            Icon(
                ClaveIcon.ChevronDown,
                contentDescription = null,
                tint = t.textTertiary,
                size = Metrics.controlSmIcon,
                modifier = Modifier.rotate(if (section.collapsed) -90f else 0f),
            )
            Box(Modifier.size(Metrics.statusDot + Metrics.space(0.5f)).clip(CircleShape).background(dot))
        }
        BasicText(
            section.name,
            modifier = Modifier.weight(1f, fill = false),
            style = ClaveTypography.type(Metrics.textXs, FontWeight.Medium).copy(color = t.textSecondary),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        BasicText(
            section.rows.size.toString(),
            style = ClaveTypography.type(Metrics.textMeta).copy(color = t.textTertiary),
        )
    }
}

@Composable
private fun SessionListRow(row: SessionRow, allWorkspaces: Boolean, onOpen: (Session) -> Unit) {
    val c = Clave.colors
    val s = row.session
    val chat = s.transport == Transport.Events
    ListRow(
        title = sessionTitle(s),
        subtitle = sessionSubtitle(row, allWorkspaces),
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

/** The "New chat" button over the list's corner: the action fill, a pill, the glyph and the word. */
@Composable
private fun NewChatButton(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val t = Clave.colors.theme
    val shape = RoundedCornerShape(Metrics.radiusXxl)
    Row(
        modifier
            .clip(shape)
            .background(t.action)
            .clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = Metrics.space(12))
            .padding(horizontal = Metrics.space(4)),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Metrics.space(2)),
    ) {
        Icon(ClaveIcon.PencilSquare, contentDescription = null, tint = t.actionForeground)
        BasicText("New chat", style = ClaveTypography.type(Metrics.controlText, FontWeight.Medium).copy(color = t.actionForeground))
    }
}
