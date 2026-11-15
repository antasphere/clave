package com.clave.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.progressBarRangeInfo
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import com.clave.ui.chat.ProviderMark
import com.clave.ui.components.Badge
import com.clave.ui.components.Notice
import com.clave.ui.components.NoticeKind
import com.clave.ui.components.PaneHeader
import com.clave.ui.components.ScreenScaffold
import com.clave.ui.components.SectionLabel
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveTypography
import com.clave.ui.theme.Metrics

/** How a cap's bar is inked: the theme's accent, the warning, or the destructive red. */
enum class BarInk { Normal, Warning, Critical }

/** One cap of an account, as its bar shows it. */
@Immutable
data class UsageBar(val label: String, val usedPercentage: Double, val resetsAt: Long?, val ink: BarInk)

/** Whether an account can start sessions, in the desktop's words. */
enum class AccountStatus(val label: String) {
    SignedIn("Signed in"),
    TokenInvalid("Token refused"),
    NoCredential("Not signed in"),
}

/**
 * One account: its label, whether it can start sessions, its caps, whether a shared cap is
 * out ([exhausted]) and which model families' own caps are, and when its read was taken.
 * [readNote] says why there are no bars (a read that failed, none yet).
 */
@Immutable
data class AccountCard(
    val id: String,
    val label: String,
    val status: AccountStatus,
    val bars: List<UsageBar>,
    val exhausted: Boolean,
    val familiesOut: List<String> = emptyList(),
    val fetchedAt: Long? = null,
    val readNote: String? = null,
)

/** One provider's accounts; null while the first read is out. [note] replaces them when the Mac does not offer them. */
@Immutable
data class ProviderAccounts(
    val provider: String,
    val title: String,
    val accounts: List<AccountCard>?,
    val note: String? = null,
    val error: String? = null,
)

@Immutable
data class AccountsScreenState(val machineName: String?, val providers: List<ProviderAccounts>, val now: Long)

/** The colour of a bar: the accent while it has room, the warning, the red when it is out. */
@Composable
private fun inkOf(ink: BarInk): Color {
    val c = Clave.colors
    return when (ink) {
        BarInk.Normal -> c.theme.accent
        BarInk.Warning -> c.shared.warning
        BarInk.Critical -> c.shared.destructive
    }
}

/**
 * Accounts & limits: per provider, each agent account of the Mac with its caps as labelled
 * bars, when each comes back, and an "Exhausted" badge by the desktop's rule. Live: the
 * usage events read the snapshot again; a pull reads everything again.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AccountsScreen(state: AccountsScreenState, onRefresh: () -> Unit, onBack: () -> Unit, modifier: Modifier = Modifier) {
    val t = Clave.colors.theme
    ScreenScaffold(
        modifier = modifier,
        header = { PaneHeader(title = "Accounts & limits", subtitle = state.machineName, onBack = onBack) },
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
                state.providers.forEach { p ->
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(start = Metrics.gutter)) {
                        ProviderMark(p.provider, size = Metrics.controlSmIcon)
                        SectionLabel(p.title)
                    }
                    val accounts = p.accounts
                    when {
                        p.note != null -> BasicText(
                            p.note,
                            modifier = Modifier.padding(horizontal = Metrics.gutter),
                            style = ClaveTypography.type(Metrics.textXs, lineHeight = Metrics.proseLineHeight).copy(color = t.textTertiary),
                        )
                        p.error != null && accounts == null -> Notice(p.error, kind = NoticeKind.Destructive, modifier = Modifier.padding(horizontal = Metrics.gutter))
                        accounts == null -> Loading()
                        accounts.isEmpty() -> BasicText(
                            "No ${p.title} account on this Mac.",
                            modifier = Modifier.padding(horizontal = Metrics.gutter),
                            style = ClaveTypography.type(Metrics.textXs).copy(color = t.textTertiary),
                        )
                        else -> accounts.forEach { a -> AccountBlock(a, state.now) }
                    }
                }
            }
        }
    }
}

@Composable
private fun AccountBlock(a: AccountCard, now: Long) {
    val c = Clave.colors
    val t = c.theme
    val shape = RoundedCornerShape(Metrics.radiusLg)
    Column(
        Modifier
            .padding(horizontal = Metrics.gutter)
            .fillMaxWidth()
            .clip(shape)
            .background(t.surface50)
            .border(Metrics.hairline, if (a.exhausted) c.shared.destructive else t.border, shape)
            .padding(Metrics.space(3)),
        verticalArrangement = Arrangement.spacedBy(Metrics.space(2)),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Metrics.space(2))) {
            Column(Modifier.weight(1f)) {
                BasicText(a.label, style = ClaveTypography.type(Metrics.textSm, FontWeight.Medium).copy(color = t.textPrimary))
                BasicText(
                    a.status.label,
                    style = ClaveTypography.type(Metrics.textXs).copy(
                        color = if (a.status == AccountStatus.SignedIn) t.textTertiary else c.shared.destructive,
                    ),
                )
            }
            if (a.exhausted) Badge("Exhausted")
        }
        a.bars.forEach { bar -> Bar(bar, now) }
        if (a.familiesOut.isNotEmpty()) {
            BasicText(
                "${a.familiesOut.joinToString(", ")}: weekly cap reached, other models still run",
                style = ClaveTypography.type(Metrics.textXs, lineHeight = Metrics.proseLineHeight).copy(color = t.textSecondary),
            )
        }
        val foot = listOfNotNull(a.readNote, updatedAgo(a.fetchedAt, now)).joinToString(" · ")
        if (foot.isNotEmpty()) {
            BasicText(foot, style = ClaveTypography.type(Metrics.textMeta).copy(color = t.textTertiary))
        }
    }
}

@Composable
private fun Bar(bar: UsageBar, now: Long) {
    val t = Clave.colors.theme
    val ink = inkOf(bar.ink)
    val fraction = (bar.usedPercentage / 100.0).coerceIn(0.0, 1.0).toFloat()
    val words = listOfNotNull(percentUsed(bar.usedPercentage), resetsIn(bar.resetsAt, now)).joinToString(" · ")
    Column(
        Modifier.semantics(mergeDescendants = true) {
            contentDescription = "${bar.label}: $words"
            progressBarRangeInfo = ProgressBarRangeInfo(fraction, 0f..1f)
        },
        verticalArrangement = Arrangement.spacedBy(Metrics.space(1)),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            BasicText(bar.label, modifier = Modifier.weight(1f), style = ClaveTypography.type(Metrics.textXs).copy(color = t.textSecondary))
            BasicText(words, style = ClaveTypography.type(Metrics.textXs).copy(color = if (bar.ink == BarInk.Critical) ink else t.textTertiary))
        }
        Box(
            Modifier
                .fillMaxWidth()
                .height(Metrics.space(1.5f))
                .clip(RoundedCornerShape(Metrics.radiusSm))
                .background(t.surface200),
        ) {
            Box(Modifier.fillMaxWidth(fraction).fillMaxHeight().background(ink))
        }
    }
}
