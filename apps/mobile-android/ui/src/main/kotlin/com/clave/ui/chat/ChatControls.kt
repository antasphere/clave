package com.clave.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.clave.ui.components.ClaveIconButton
import com.clave.ui.components.Rule
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveIcon
import com.clave.ui.theme.ClaveTypography
import com.clave.ui.theme.Icon
import com.clave.ui.theme.Metrics

/** One row of a picker: a model, an effort level, a permission mode. */
@Immutable
data class ChatChoice(val id: String, val label: String, val hint: String? = null, val selected: Boolean = false)

/**
 * The composer's status, the desktop's composer footer: the context meter, then the
 * permission mode, the model and its effort, each a chip that opens its picker. A null label
 * hides its chip: a provider without modes, a model that takes no effort. [refusal] is the
 * server's own sentence when it refused a switch, said plainly over the controls.
 */
@Immutable
data class ChatControlsView(
    val provider: String = "",
    val model: String? = null,
    /** The model was just picked and the provider has not confirmed it yet. */
    val modelPending: Boolean = false,
    val models: List<ChatChoice> = emptyList(),
    val modelsLoading: Boolean = false,
    val effort: String? = null,
    val efforts: List<ChatChoice> = emptyList(),
    val mode: String? = null,
    val modes: List<ChatChoice> = emptyList(),
    val contextLabel: String? = null,
    val contextRatio: Float = 0f,
    val refusal: String? = null,
)

/** Which picker is open. */
enum class ControlSheet { Model, Effort, Mode }

/**
 * The chat's header: back, the provider's mark, the conversation's title over the machine and
 * the state, and the header's own actions on the right.
 */
@Composable
fun ChatHeader(
    title: String,
    subtitle: String?,
    provider: String,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
    actions: @Composable RowScope.() -> Unit = {},
) {
    val t = Clave.colors.theme
    Column(modifier.fillMaxWidth().background(t.surface0).windowInsetsPadding(WindowInsets.statusBars)) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = Metrics.paneHeaderHeight)
                .padding(horizontal = Metrics.space(1), vertical = Metrics.space(1)),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Metrics.space(1)),
        ) {
            ClaveIconButton(icon = ClaveIcon.ArrowLeft, onClick = onBack, contentDescription = "Back")
            if (provider.isNotEmpty()) {
                ProviderMark(provider, Modifier.padding(start = Metrics.space(1)), size = Metrics.controlIcon)
            }
            Column(Modifier.weight(1f).padding(start = Metrics.space(1))) {
                BasicText(
                    text = title,
                    modifier = Modifier.semantics { heading() },
                    style = ClaveTypography.type(Metrics.textSm, FontWeight.Medium).copy(color = t.textPrimary),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (!subtitle.isNullOrEmpty()) {
                    BasicText(
                        text = subtitle,
                        style = ClaveTypography.type(Metrics.textMeta).copy(color = t.textTertiary),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, content = actions)
        }
        Rule()
    }
}

/** `.chat-context`: a thin bar that fills as the context does, amber past 70 %, red past 90 %. */
@Composable
fun ContextMeter(label: String, ratio: Float, modifier: Modifier = Modifier) {
    val c = Clave.colors
    val t = c.theme
    val fill = when {
        ratio >= 0.9f -> c.shared.destructive
        ratio >= 0.7f -> c.shared.warning
        else -> t.textTertiary
    }
    val percent = Math.round(ratio * 100)
    Row(
        modifier.semantics { contentDescription = "Context used: $label ($percent %)" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Metrics.space(1.5f)),
    ) {
        Box(
            Modifier
                .size(width = 28.dp, height = 4.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(t.surface200),
        ) {
            Box(Modifier.fillMaxHeight().fillMaxWidth(ratio).background(fill))
        }
        BasicText(label, style = ClaveTypography.mono(Metrics.textMeta).copy(color = t.textTertiary), maxLines = 1)
    }
}

/** A status chip: its word and a chevron, a thumb tall; pending reads dimmer until confirmed. */
@Composable
private fun StatusChip(label: String, description: String, onClick: () -> Unit, enabled: Boolean, pending: Boolean = false) {
    val t = Clave.colors.theme
    Row(
        Modifier
            .heightIn(min = Metrics.controlSmHeight)
            .clip(RoundedCornerShape(Metrics.controlSmRadius))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = "$description: $label" }
            .padding(horizontal = Metrics.space(2)),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Metrics.space(1)),
    ) {
        BasicText(
            label,
            style = ClaveTypography.type(Metrics.controlSmText).copy(color = if (pending) t.textTertiary else t.textSecondary),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (enabled) Icon(ClaveIcon.ChevronDown, null, tint = t.textTertiary, size = Metrics.controlXsIcon)
    }
}

/** The row under the composer: the meter on the left, the chips on the right. */
@Composable
fun ComposerStatusRow(
    controls: ChatControlsView,
    enabled: Boolean,
    onOpen: (ControlSheet) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier.fillMaxWidth().testTag("chat-status-row"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (controls.contextLabel != null) {
            ContextMeter(controls.contextLabel, controls.contextRatio, Modifier.padding(start = Metrics.space(2)))
        }
        Row(
            Modifier.weight(1f).horizontalScroll(rememberScrollState(), reverseScrolling = true),
            horizontalArrangement = Arrangement.End,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (controls.mode != null) {
                StatusChip(controls.mode, "Permission mode", { onOpen(ControlSheet.Mode) }, enabled && controls.modes.size > 1)
            }
            if (controls.model != null) {
                StatusChip(controls.model, "Model", { onOpen(ControlSheet.Model) }, enabled, pending = controls.modelPending)
            }
            if (controls.effort != null) {
                StatusChip(controls.effort, "Effort", { onOpen(ControlSheet.Effort) }, enabled && controls.efforts.isNotEmpty())
            }
        }
    }
}

/** A picker in a bottom sheet: one row per choice, the current one checked, its hint under it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChoiceSheet(
    title: String,
    choices: List<ChatChoice>,
    onPick: (String) -> Unit,
    onDismiss: () -> Unit,
    loading: Boolean = false,
    emptyText: String = "Nothing to choose from.",
) {
    val t = Clave.colors.theme
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = t.surfaceRaised) {
        Column(
            Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .verticalScroll(rememberScrollState())
                .padding(bottom = Metrics.space(4))
                .testTag("choice-sheet"),
        ) {
            BasicText(
                title,
                modifier = Modifier.padding(horizontal = Metrics.gutter, vertical = Metrics.space(2)).semantics { heading() },
                style = ClaveTypography.type(Metrics.textSm, FontWeight.Medium).copy(color = t.textPrimary),
            )
            if (choices.isEmpty()) {
                BasicText(
                    if (loading) "Reading the choices…" else emptyText,
                    modifier = Modifier.padding(horizontal = Metrics.gutter, vertical = Metrics.space(3)),
                    style = ClaveTypography.type(Metrics.textControl).copy(color = t.textTertiary),
                )
            }
            choices.forEach { choice ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 52.dp)
                        .clickable(role = Role.Button) {
                            onDismiss()
                            if (!choice.selected) onPick(choice.id)
                        }
                        .semantics { selected = choice.selected }
                        .padding(horizontal = Metrics.gutter, vertical = Metrics.space(2)),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Metrics.space(3)),
                ) {
                    Column(Modifier.weight(1f)) {
                        BasicText(choice.label, style = ClaveTypography.type(Metrics.textSm).copy(color = t.textPrimary))
                        if (!choice.hint.isNullOrBlank()) {
                            BasicText(choice.hint, style = ClaveTypography.type(Metrics.textXs).copy(color = t.textTertiary))
                        }
                    }
                    if (choice.selected) Icon(ClaveIcon.Check, contentDescription = "Current", tint = t.accent, size = Metrics.controlIcon)
                }
            }
        }
    }
}
