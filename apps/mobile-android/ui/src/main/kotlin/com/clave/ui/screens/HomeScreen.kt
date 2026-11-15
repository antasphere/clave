package com.clave.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
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
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import com.clave.core.contract.Session
import com.clave.core.contract.Transport
import com.clave.ui.chat.ProviderMark
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
import com.clave.ui.theme.ClaveTypography
import com.clave.ui.theme.Icon
import com.clave.ui.theme.Metrics
import com.clave.ui.theme.Reachability
import com.clave.ui.theme.SessionStatus

/** A paired machine the top bar can switch to. */
@Immutable
data class MachineChoice(val id: String, val name: String)

/**
 * One account in the Home strip: its tightest shared cap, when it comes back, and whether it
 * is out. [note] stands in for the numbers when there are none ("No usage read yet").
 */
@Immutable
data class LimitChip(
    val provider: String,
    val label: String,
    val usedPercentage: Double?,
    val resetsAt: Long?,
    val exhausted: Boolean,
    val note: String? = null,
)

/** A recent session, where it is: its workspace and the desktop group holding it. */
@Immutable
data class RecentRow(val session: Session, val status: SessionStatus, val workspaceName: String?, val groupName: String?)

/**
 * The landing screen of a paired phone: the machine and whether it answers, the quick
 * composer, the requests waiting, the limits of the machine's accounts, and the sessions
 * most recently active. [limits] is null while the first read is out; [limitsNote] replaces the
 * strip when the Mac does not offer the limits yet. [recent] is null until the sessions are in.
 */
@Immutable
data class HomeScreenState(
    val machineName: String?,
    val machines: List<MachineChoice>,
    val currentMachineId: String?,
    val reachability: Reachability,
    val composer: QuickComposerState,
    val pendingRequests: Int,
    val limits: List<LimitChip>?,
    val limitsNote: String? = null,
    val recent: List<RecentRow>?,
    val recentError: String? = null,
    val now: Long,
    /** Focus the composer as the screen opens: the first visit of a launch, not a return. */
    val autoFocus: Boolean = false,
)

/** "3 requests waiting", "1 request waiting". */
internal fun requestsWaiting(n: Int): String = if (n == 1) "1 request waiting" else "$n requests waiting"

/** Where a recent session is, under its title: "clave · Auth", "clave", "claude". */
internal fun recentSubtitle(row: RecentRow): String {
    val s = row.session
    val place = listOfNotNull(row.workspaceName, row.groupName).joinToString(" · ").ifEmpty { s.provider }
    return if (s.transport == Transport.Events) place else "Terminal · $place"
}

/** The words of one limit chip: "58% left · resets in 2 h 10", or "Exhausted · resets in 12 min". */
internal fun limitLine(chip: LimitChip, now: Long): String {
    if (chip.usedPercentage == null) return chip.note ?: "No usage read yet"
    val head = if (chip.exhausted) "Exhausted" else percentLeft(chip.usedPercentage)
    return listOfNotNull(head, resetsIn(chip.resetsAt, now)).joinToString(" · ")
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    state: HomeScreenState,
    onTextChange: (String) -> Unit,
    onSend: () -> Unit,
    onPickWorkspace: (String) -> Unit,
    onPickProfile: (String) -> Unit,
    onMoreOptions: () -> Unit,
    onOpenSession: (Session) -> Unit,
    onAllSessions: () -> Unit,
    onRequests: () -> Unit,
    onLimits: () -> Unit,
    onSettings: () -> Unit,
    onSwitchMachine: (String) -> Unit,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = Clave.colors
    val t = c.theme
    var switching by rememberSaveable { mutableStateOf(false) }
    ScreenScaffold(
        modifier = modifier,
        header = {
            PaneHeader(
                title = state.machineName ?: "Clave",
                subtitle = state.reachability.label,
                actions = {
                    if (state.machines.size > 1) {
                        ClaveIconButton(ClaveIcon.ComputerDesktop, onClick = { switching = true }, contentDescription = "Switch machine")
                    }
                    ClaveIconButton(ClaveIcon.Cog6Tooth, onClick = onSettings, contentDescription = "Settings")
                },
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
                verticalArrangement = Arrangement.spacedBy(Metrics.space(2)),
            ) {
                QuickComposer(
                    state = state.composer,
                    onTextChange = onTextChange,
                    onSend = onSend,
                    onPickWorkspace = onPickWorkspace,
                    onPickProfile = onPickProfile,
                    onMoreOptions = onMoreOptions,
                    modifier = Modifier.padding(horizontal = Metrics.gutter),
                    autoFocus = state.autoFocus,
                )
                if (state.pendingRequests > 0) {
                    RequestsBanner(state.pendingRequests, onRequests, Modifier.padding(horizontal = Metrics.gutter))
                }
                LimitsStrip(state, onLimits)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    SectionLabel("Recent", Modifier.weight(1f))
                    BasicText(
                        "All sessions",
                        modifier = Modifier
                            .clickable(role = Role.Button, onClick = onAllSessions)
                            .padding(horizontal = Metrics.gutter, vertical = Metrics.space(2)),
                        style = ClaveTypography.type(Metrics.textXs).copy(color = t.accent),
                    )
                }
                val recent = state.recent
                when {
                    state.recentError != null && recent.isNullOrEmpty() -> Notice(
                        state.recentError,
                        kind = NoticeKind.Destructive,
                        modifier = Modifier.padding(horizontal = Metrics.gutter),
                    )
                    recent == null -> Loading()
                    recent.isEmpty() -> EmptyState(ClaveIcon.ChatBubbleLeftRight, "No session yet", text = "Type above to start one.")
                    else -> Column {
                        recent.forEach { row -> RecentSessionRow(row, onOpenSession) }
                    }
                }
            }
        }
    }
    if (switching) {
        ChoiceSheet(title = "Machines", onDismiss = { switching = false }) {
            state.machines.forEach { m ->
                ListRow(
                    title = m.name,
                    leading = { Icon(ClaveIcon.ComputerDesktop, contentDescription = null, tint = t.textTertiary) },
                    trailing = { if (m.id == state.currentMachineId) Icon(ClaveIcon.Check, contentDescription = "Current", tint = t.accent) },
                    selected = m.id == state.currentMachineId,
                    onClick = {
                        switching = false
                        if (m.id != state.currentMachineId) onSwitchMachine(m.id)
                    },
                )
            }
        }
    }
}

@Composable
private fun RequestsBanner(count: Int, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = Clave.colors
    val t = c.theme
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Metrics.radiusLg))
            .background(t.surface100)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = Metrics.space(3), vertical = Metrics.space(2.5f)),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Metrics.space(2)),
    ) {
        Icon(ClaveIcon.Bell, contentDescription = null, tint = c.shared.statusWaiting, size = Metrics.chatGlyph)
        BasicText(
            requestsWaiting(count),
            modifier = Modifier.weight(1f),
            style = ClaveTypography.type(Metrics.textControl, FontWeight.Medium).copy(color = t.textPrimary),
        )
        Icon(ClaveIcon.ChevronRight, contentDescription = null, tint = t.textTertiary)
    }
}

@Composable
private fun LimitsStrip(state: HomeScreenState, onLimits: () -> Unit) {
    val t = Clave.colors.theme
    val note = state.limitsNote
    val limits = state.limits
    if (note == null && limits.isNullOrEmpty()) return
    Row(verticalAlignment = Alignment.CenterVertically) {
        SectionLabel("Limits", Modifier.weight(1f))
        BasicText(
            "Accounts",
            modifier = Modifier
                .clickable(role = Role.Button, onClick = onLimits)
                .padding(horizontal = Metrics.gutter, vertical = Metrics.space(2)),
            style = ClaveTypography.type(Metrics.textXs).copy(color = t.accent),
        )
    }
    if (note != null) {
        BasicText(
            note,
            modifier = Modifier.padding(horizontal = Metrics.gutter),
            style = ClaveTypography.type(Metrics.textXs, lineHeight = Metrics.proseLineHeight).copy(color = t.textTertiary),
        )
        return
    }
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = Metrics.gutter),
        horizontalArrangement = Arrangement.spacedBy(Metrics.space(2)),
    ) {
        limits.orEmpty().forEach { chip -> LimitCard(chip, state.now, onLimits) }
    }
}

@Composable
private fun LimitCard(chip: LimitChip, now: Long, onClick: () -> Unit) {
    val c = Clave.colors
    val t = c.theme
    val shape = RoundedCornerShape(Metrics.radiusLg)
    val line = limitLine(chip, now)
    Column(
        Modifier
            .widthIn(min = Metrics.space(36), max = Metrics.space(60))
            .clip(shape)
            .background(t.surface50)
            .border(Metrics.hairline, if (chip.exhausted) c.shared.destructive else t.border, shape)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) { contentDescription = "${chip.label}: $line" }
            .padding(horizontal = Metrics.space(3), vertical = Metrics.space(2)),
        verticalArrangement = Arrangement.spacedBy(Metrics.space(1)),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Metrics.space(1.5f))) {
            ProviderMark(chip.provider, size = Metrics.controlSmIcon)
            BasicText(
                chip.label,
                style = ClaveTypography.type(Metrics.textXs, FontWeight.Medium).copy(color = t.textPrimary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        BasicText(
            line,
            style = ClaveTypography.type(Metrics.textXs).copy(color = if (chip.exhausted) c.shared.destructive else t.textSecondary),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun RecentSessionRow(row: RecentRow, onOpen: (Session) -> Unit) {
    val c = Clave.colors
    val s = row.session
    val chat = s.transport == Transport.Events
    ListRow(
        title = sessionTitle(s),
        subtitle = recentSubtitle(row),
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
