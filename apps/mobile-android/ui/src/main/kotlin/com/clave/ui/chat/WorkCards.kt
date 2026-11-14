package com.clave.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.clave.core.chat.elapsed
import com.clave.ui.components.ButtonKind
import com.clave.ui.components.ClaveButton
import com.clave.ui.components.StatusDot
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveIcon
import com.clave.ui.theme.ClaveTypography
import com.clave.ui.theme.Icon
import com.clave.ui.theme.Metrics
import kotlinx.coroutines.delay

/** One piece of background work: a subagent or a command left running. */
@Immutable
data class WorkCardView(
    val id: String,
    val title: String,
    val shell: Boolean,
    /** Epoch milliseconds the work started at. */
    val startedAt: Long,
    /** The command a shell runs, the model an agent was launched on. */
    val detail: String? = null,
)

/**
 * The work running now, the desktop's work cards adapted to a thumb: one compact card per
 * subagent or background command, its kind, its title and how long it has run, ticking each
 * second. A tap opens the card to what it runs and a Stop, which stops that one task.
 */
@Composable
fun WorkCards(cards: List<WorkCardView>, onStop: (String) -> Unit, modifier: Modifier = Modifier, clockStart: Long = 0) {
    if (cards.isEmpty()) return
    val t = Clave.colors.theme
    var now by remember { mutableLongStateOf(if (clockStart > 0) clockStart else System.currentTimeMillis()) }
    LaunchedEffect(cards.isNotEmpty(), clockStart) {
        if (clockStart > 0) return@LaunchedEffect
        while (true) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }
    var open by remember { mutableStateOf<String?>(null) }
    val shape = RoundedCornerShape(Metrics.radiusLg)
    Column(modifier.fillMaxWidth().testTag("work-cards"), verticalArrangement = Arrangement.spacedBy(Metrics.space(1.5f))) {
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(Metrics.space(1.5f))) {
            cards.forEach { card ->
                val opened = open == card.id
                Row(
                    Modifier
                        .widthIn(max = 220.dp)
                        .clip(shape)
                        .background(if (opened) t.surface200 else t.surface100)
                        .border(Metrics.hairline, t.borderSubtle, shape)
                        .clickable(role = Role.Button) { open = if (opened) null else card.id }
                        .semantics {
                            contentDescription = "${if (card.shell) "Command" else "Subagent"}: ${card.title}"
                            stateDescription = if (opened) "Expanded" else "Collapsed"
                        }
                        .heightIn(min = Metrics.controlHeight)
                        .padding(horizontal = Metrics.space(2.5f)),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Metrics.space(1.5f)),
                ) {
                    StatusDot(Clave.colors.shared.statusWorking, pulsing = true)
                    Icon(if (card.shell) ClaveIcon.CommandLine else ClaveIcon.CpuChip, null, tint = t.textTertiary, size = Metrics.chatGlyph)
                    BasicText(
                        card.title,
                        modifier = Modifier.weight(1f, fill = false),
                        style = ClaveTypography.type(Metrics.textXs, FontWeight.Medium).copy(color = t.textPrimary),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    BasicText(elapsed(card.startedAt, now), style = ClaveTypography.mono(Metrics.textMeta).copy(color = t.textTertiary), maxLines = 1)
                }
            }
        }
        val card = cards.firstOrNull { it.id == open }
        if (card != null) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(shape)
                    .background(t.surface100)
                    .padding(horizontal = Metrics.space(3), vertical = Metrics.space(2)),
                verticalArrangement = Arrangement.spacedBy(Metrics.space(1.5f)),
            ) {
                BasicText(
                    if (card.shell) "Running in the background" else "Subagent at work",
                    style = ClaveTypography.type(Metrics.textXs).copy(color = t.textTertiary),
                )
                BasicText(card.title, style = ClaveTypography.type(Metrics.textControl, lineHeight = Metrics.proseLineHeight).copy(color = t.textPrimary))
                if (!card.detail.isNullOrBlank()) {
                    if (card.shell) CodeBlock(card.detail, "bash", maxHeight = 96.dp, copyable = false)
                    else BasicText(card.detail, style = ClaveTypography.type(Metrics.textXs).copy(color = t.textSecondary))
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    ClaveButton("Stop", onClick = {
                        open = null
                        onStop(card.id)
                    }, kind = ButtonKind.Destructive, icon = ClaveIcon.Stop, modifier = Modifier.heightIn(min = ThumbHeight))
                }
            }
        }
    }
}
