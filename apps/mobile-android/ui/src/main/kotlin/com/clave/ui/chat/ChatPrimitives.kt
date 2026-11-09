package com.clave.ui.chat

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import com.clave.ui.components.ButtonKind
import com.clave.ui.components.Chip
import com.clave.ui.components.ClaveButton
import com.clave.ui.components.ClaveIconButton
import com.clave.ui.components.ClaveTextField
import com.clave.ui.components.Notice
import com.clave.ui.components.NoticeKind
import com.clave.ui.components.StatusDot
import com.clave.ui.markdown.Markdown
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveIcon
import com.clave.ui.theme.ClaveTypography
import com.clave.ui.theme.Icon
import com.clave.ui.theme.Metrics
import com.clave.ui.theme.shadow

/**
 * The chat's visual pieces, fed plain values: the transcript logic that decides what they
 * show lives in another module, so these stay drawable alone in a preview or a test.
 */

/** A turn the person sent: boxed on surface-100 at the end of the column; an interrupted one goes hollow. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun UserTurn(
    text: String,
    modifier: Modifier = Modifier,
    attachmentLabels: List<String> = emptyList(),
    interrupted: Boolean = false,
) {
    val t = Clave.colors.theme
    val shape = RoundedCornerShape(Metrics.radiusXxl)
    Column(
        modifier.fillMaxWidth().padding(start = Metrics.userTurnInset),
        horizontalAlignment = Alignment.End,
        verticalArrangement = Arrangement.spacedBy(Metrics.space(1.5f)),
    ) {
        if (attachmentLabels.isNotEmpty()) {
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(Metrics.space(1.5f), Alignment.End),
                verticalArrangement = Arrangement.spacedBy(Metrics.space(1.5f)),
            ) {
                attachmentLabels.forEach { Chip(it, icon = ClaveIcon.Document) }
            }
        }
        val body = text.trimEnd()
        if (body.isNotEmpty()) {
            val frame = if (interrupted) {
                Modifier.border(Metrics.hairline, t.borderSubtle, shape)
            } else {
                Modifier.background(t.surface100, shape)
            }
            BasicText(
                text = body,
                modifier = Modifier
                    .clip(shape)
                    .then(frame)
                    .padding(horizontal = Metrics.userTurnPaddingX, vertical = Metrics.userTurnPaddingY),
                style = ClaveTypography.type(Metrics.textSm, lineHeight = Metrics.userTurnLineHeight)
                    .copy(color = if (interrupted) t.textTertiary else t.textPrimary),
            )
        }
        if (interrupted) {
            BasicText(
                text = "Interrupted",
                modifier = Modifier.padding(horizontal = Metrics.space(1)),
                style = ClaveTypography.type(Metrics.textXs).copy(color = t.textTertiary),
            )
        }
    }
}

/** The assistant's answer on the ground, no box; a working dot breathes while it streams. */
@Composable
fun AssistantProse(
    markdown: String,
    modifier: Modifier = Modifier,
    streaming: Boolean = false,
    onLink: ((String) -> Unit)? = null,
) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Metrics.space(2))) {
        if (markdown.isNotBlank()) Markdown(markdown, onLink = onLink)
        if (streaming) {
            StatusDot(
                color = Clave.colors.shared.statusWorking,
                pulsing = true,
                modifier = Modifier.semantics { contentDescription = "Writing" },
            )
        }
    }
}

enum class ToolStatus { Running, Failed, Complete }

/** The glyph of a tool's kind, the desktop's `KIND_ICONS`. */
fun toolKindIcon(kind: String): ClaveIcon = when (kind) {
    "read" -> ClaveIcon.DocumentText
    "search" -> ClaveIcon.MagnifyingGlass
    "edit" -> ClaveIcon.PencilSquare
    "command" -> ClaveIcon.CommandLine
    "skill" -> ClaveIcon.BookOpen
    "web" -> ClaveIcon.GlobeAlt
    "agent" -> ClaveIcon.CpuChip
    else -> ClaveIcon.Wrench
}

/** The arrows turning while a tool runs: motion says "not finished" without a word. */
@Composable
private fun Spinning(content: @Composable (Modifier) -> Unit) {
    val transition = rememberInfiniteTransition(label = "tool spinner")
    val angle by transition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(tween(Metrics.spinMillis, easing = LinearEasing)),
        label = "tool spinner angle",
    )
    content(Modifier.rotate(angle))
}

/**
 * `.chat-tool-row`: one muted line led by its kind's glyph (the spinner while running, the
 * warning when failed: the reader needs those more than the kind), opening to its sections.
 */
@Composable
fun ToolRow(
    summary: String,
    hint: String,
    status: ToolStatus,
    expanded: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
    failures: Int = 0,
    sections: List<Pair<String, String>> = emptyList(),
    kind: String = "other",
) {
    val c = Clave.colors
    val t = c.theme
    Column(modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(min = Metrics.controlXsHeight)
                .clickable(role = Role.Button, onClick = onToggle)
                .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Metrics.space(2)),
        ) {
            when (status) {
                ToolStatus.Running -> Spinning { spin ->
                    Icon(ClaveIcon.ArrowPath, null, spin, tint = t.textTertiary, size = Metrics.chatGlyph)
                }
                ToolStatus.Failed ->
                    Icon(ClaveIcon.ExclamationTriangle, null, tint = c.shared.destructive, size = Metrics.chatGlyph)
                ToolStatus.Complete -> Icon(toolKindIcon(kind), null, tint = t.textTertiary, size = Metrics.chatGlyph)
            }
            val line = if (hint.isBlank()) summary else "$summary  ${hint.lineSequence().first()}"
            BasicText(
                text = line,
                modifier = Modifier.weight(1f, fill = false),
                style = ClaveTypography.type(Metrics.codeSize).copy(color = t.textTertiary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (failures > 0) {
                BasicText(
                    text = "$failures failed",
                    style = ClaveTypography.type(Metrics.textXs).copy(color = c.shared.destructive),
                    maxLines = 1,
                )
            }
            Icon(
                ClaveIcon.ChevronRight,
                null,
                Modifier.rotate(if (expanded) 90f else 0f).alpha(if (expanded) 1f else Metrics.restingChevronAlpha),
                tint = t.textTertiary,
                size = Metrics.chatGlyph,
            )
        }
        if (expanded) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = Metrics.space(0.5f), bottom = Metrics.space(1.5f))
                    .clip(RoundedCornerShape(Metrics.radiusLg))
                    .background(t.surface50)
                    .border(Metrics.hairline, t.borderSubtle, RoundedCornerShape(Metrics.radiusLg))
                    .padding(horizontal = Metrics.space(2.5f), vertical = Metrics.space(2)),
                verticalArrangement = Arrangement.spacedBy(Metrics.space(1.5f)),
            ) {
                if (sections.isEmpty()) {
                    BasicText(
                        text = if (status == ToolStatus.Running) "Waiting for output…" else "No output returned.",
                        style = ClaveTypography.type(Metrics.textXs).copy(color = t.textTertiary),
                    )
                }
                sections.forEach { (label, body) ->
                    Column(verticalArrangement = Arrangement.spacedBy(Metrics.space(1))) {
                        BasicText(label, style = ClaveTypography.type(Metrics.textXs).copy(color = t.textTertiary))
                        Box(
                            Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(Metrics.radiusMd))
                                .background(t.surface100)
                                .horizontalScroll(rememberScrollState())
                                .padding(Metrics.space(2)),
                        ) {
                            BasicText(
                                body,
                                style = ClaveTypography.mono(Metrics.textXs).copy(color = t.textSecondary),
                                softWrap = false,
                            )
                        }
                    }
                }
            }
        }
    }
}

/** One question the agent asks; multi-select picks several options, the field takes free words. */
@Immutable
data class QuestionView(
    val id: String,
    val prompt: String,
    val options: List<String> = emptyList(),
    val multiSelect: Boolean = false,
    val header: String? = null,
)

/** An option id that refuses: shown in the neutral kind, away from the verb. */
private fun isDeny(id: String): Boolean = Regex("deny|decline|cancel|reject|abort", RegexOption.IGNORE_CASE).containsMatchIn(id)

/**
 * `.chat-prompt`: what the agent waits on, on the raised card. Refusals sit on the left in
 * the neutral kind; the first allowing option is the one verb, last, where the eye ends.
 * With questions, the answers go out on Send as question id → the free text, or else the
 * picked options joined by ", ".
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ApprovalCard(
    title: String,
    target: String?,
    options: List<Pair<String, String>>,
    onAnswer: (optionId: String, answers: Map<String, String>) -> Unit,
    modifier: Modifier = Modifier,
    detail: String? = null,
    questions: List<QuestionView>? = null,
    answered: String? = null,
) {
    val c = Clave.colors
    val t = c.theme
    val shape = RoundedCornerShape(Metrics.radiusXl)
    val picks = remember(questions) { mutableStateMapOf<String, Set<String>>() }
    val words = remember(questions) { mutableStateMapOf<String, String>() }
    Column(
        modifier = modifier
            .fillMaxWidth()
            .shadow(Clave.shadows.raised, shape)
            .clip(shape)
            .background(t.surfaceRaised)
            .border(Metrics.hairline, t.borderSubtle, shape)
            .padding(horizontal = Metrics.space(3.5f), vertical = Metrics.space(3)),
        verticalArrangement = Arrangement.spacedBy(Metrics.space(2)),
    ) {
        BasicText(
            title,
            style = ClaveTypography.type(Metrics.textControl, FontWeight.Medium, Metrics.proseLineHeight).copy(color = t.textPrimary),
        )
        if (!target.isNullOrBlank()) {
            BasicText(target, style = ClaveTypography.type(Metrics.textXs, lineHeight = Metrics.proseLineHeight).copy(color = t.textTertiary))
        }
        if (!detail.isNullOrBlank()) {
            BasicText(detail, style = ClaveTypography.type(Metrics.codeSize, lineHeight = Metrics.proseLineHeight).copy(color = t.textSecondary))
        }
        questions.orEmpty().forEach { q ->
            Column(verticalArrangement = Arrangement.spacedBy(Metrics.space(1.5f))) {
                if (q.header != null) {
                    BasicText(q.header, style = ClaveTypography.type(Metrics.textMeta).copy(color = t.textTertiary))
                }
                BasicText(q.prompt, style = ClaveTypography.type(Metrics.textControl, lineHeight = Metrics.proseLineHeight).copy(color = t.textPrimary))
                if (q.options.isNotEmpty()) {
                    FlowRow(
                        horizontalArrangement = Arrangement.spacedBy(Metrics.space(1.5f)),
                        verticalArrangement = Arrangement.spacedBy(Metrics.space(1.5f)),
                    ) {
                        q.options.forEach { option ->
                            val chosen = picks[q.id].orEmpty()
                            Chip(
                                label = option,
                                selected = option in chosen,
                                onClick = if (answered != null) null else {
                                    {
                                        picks[q.id] = when {
                                            option in chosen -> chosen - option
                                            q.multiSelect -> chosen + option
                                            else -> setOf(option)
                                        }
                                    }
                                },
                            )
                        }
                    }
                }
                ClaveTextField(
                    value = words[q.id].orEmpty(),
                    onValueChange = { words[q.id] = it },
                    placeholder = "Type your own answer",
                    singleLine = false,
                    enabled = answered == null,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        if (answered != null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Metrics.space(1.5f))) {
                Icon(ClaveIcon.Check, null, tint = t.textTertiary, size = Metrics.chatGlyph)
                BasicText(answered, style = ClaveTypography.type(Metrics.codeSize).copy(color = t.textTertiary))
            }
            return@Column
        }
        val denies = options.filter { isDeny(it.first) }
        val allows = options.filterNot { isDeny(it.first) }
        Row(
            modifier = Modifier.fillMaxWidth().padding(top = Metrics.space(1)),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Metrics.controlGap),
        ) {
            denies.forEach { (id, label) ->
                ClaveButton(label, onClick = { onAnswer(id, emptyMap()) }, kind = ButtonKind.Secondary)
            }
            Spacer(Modifier.weight(1f))
            if (!questions.isNullOrEmpty()) {
                ClaveButton("Send", kind = ButtonKind.Primary, onClick = {
                    val answers = questions.associate { q ->
                        val typed = words[q.id].orEmpty().trim()
                        q.id to typed.ifEmpty { picks[q.id].orEmpty().joinToString(", ") }
                    }
                    onAnswer("answer", answers)
                })
            } else {
                (allows.drop(1).reversed() + allows.take(1)).forEach { (id, label) ->
                    ClaveButton(
                        label,
                        onClick = { onAnswer(id, emptyMap()) },
                        kind = if (id == allows.first().first) ButtonKind.Primary else ButtonKind.Secondary,
                    )
                }
            }
        }
    }
}

/** The small bar above the composer while requests wait: always in the same place, one tap away. */
@Composable
fun PromptDock(count: Int, label: String, onOpen: () -> Unit, modifier: Modifier = Modifier) {
    if (count <= 0) return
    val t = Clave.colors.theme
    val shape = RoundedCornerShape(Metrics.radiusXl)
    Row(
        modifier = modifier
            .fillMaxWidth()
            .shadow(Clave.shadows.raised, shape)
            .clip(shape)
            .background(t.surfaceRaised)
            .border(Metrics.hairline, t.borderSubtle, shape)
            .clickable(role = Role.Button, onClick = onOpen)
            .heightIn(min = Metrics.controlHeight)
            .padding(horizontal = Metrics.space(3)),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Metrics.space(2)),
    ) {
        Icon(ClaveIcon.ShieldCheck, null, tint = t.textSecondary, size = Metrics.chatGlyph)
        BasicText(
            label,
            modifier = Modifier.weight(1f),
            style = ClaveTypography.type(Metrics.textControl).copy(color = t.textPrimary),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (count > 1) {
            BasicText("1 of $count waiting", style = ClaveTypography.type(Metrics.textXs).copy(color = t.textTertiary))
        }
        Icon(ClaveIcon.ChevronRight, null, tint = t.textTertiary, size = Metrics.chatGlyph)
    }
}

/**
 * The raised composer: attachments above the field, the field growing from one line to six,
 * the paper clip, and the round Send in the action ink that turns into Stop while the agent
 * works and nothing is typed (typing while it works still sends).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun Composer(
    text: String,
    onTextChange: (String) -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onAttach: () -> Unit,
    modifier: Modifier = Modifier,
    working: Boolean = false,
    sending: Boolean = false,
    attachments: List<String> = emptyList(),
    onRemoveAttachment: (Int) -> Unit = {},
    deliveryMark: String? = null,
    placeholder: String = "Write a message…",
) {
    val t = Clave.colors.theme
    val shape = RoundedCornerShape(Metrics.radiusXxl)
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Metrics.space(1.5f))) {
        if (deliveryMark != null) Notice(deliveryMark, kind = NoticeKind.Info)
        if (sending) Notice("Sending…", kind = NoticeKind.Info)
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .shadow(Clave.shadows.raised, shape)
                .clip(shape)
                .background(t.surfaceRaised)
                .border(Metrics.hairline, t.borderSubtle, shape)
                .padding(Metrics.space(1.5f)),
            verticalArrangement = Arrangement.spacedBy(Metrics.space(1)),
        ) {
            if (attachments.isNotEmpty()) {
                FlowRow(
                    modifier = Modifier.padding(horizontal = Metrics.space(1)),
                    horizontalArrangement = Arrangement.spacedBy(Metrics.space(1.5f)),
                    verticalArrangement = Arrangement.spacedBy(Metrics.space(1.5f)),
                ) {
                    attachments.forEachIndexed { index, label ->
                        Chip(
                            label,
                            icon = ClaveIcon.Document,
                            onRemove = if (sending) null else { { onRemoveAttachment(index) } },
                        )
                    }
                }
            }
            Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(Metrics.space(1))) {
                ClaveIconButton(
                    icon = ClaveIcon.PaperClip,
                    onClick = onAttach,
                    contentDescription = "Add files",
                    size = Metrics.controlSmHeight,
                    enabled = !sending,
                )
                val style = ClaveTypography.type(Metrics.textSm, lineHeight = Metrics.proseLineHeight).copy(color = t.textPrimary)
                BasicTextField(
                    value = text,
                    onValueChange = onTextChange,
                    enabled = !sending,
                    textStyle = style,
                    minLines = Metrics.composerMinLines,
                    maxLines = Metrics.composerMaxLines,
                    cursorBrush = SolidColor(t.accent),
                    modifier = Modifier
                        .weight(1f)
                        .heightIn(min = Metrics.controlSmHeight)
                        .semantics { contentDescription = "Message" },
                    decorationBox = { inner ->
                        Box(Modifier.padding(vertical = Metrics.space(1.5f)), contentAlignment = Alignment.CenterStart) {
                            if (text.isEmpty()) BasicText(placeholder, style = style.copy(color = t.textTertiary), maxLines = 1)
                            inner()
                        }
                    },
                )
                val canSend = (text.isNotBlank() || attachments.isNotEmpty()) && !sending
                if (working && text.isBlank()) {
                    RoundAction(ClaveIcon.Stop, "Interrupt", enabled = true, onClick = onStop)
                } else {
                    RoundAction(ClaveIcon.ArrowUp, "Send message", enabled = canSend, onClick = onSend)
                }
            }
        }
    }
}

/** The composer's round verb: the action fill when it can act, surface-200 when it cannot. */
@Composable
private fun RoundAction(icon: ClaveIcon, description: String, enabled: Boolean, onClick: () -> Unit) {
    val t = Clave.colors.theme
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val fill = when {
        !enabled -> t.surface200
        pressed -> t.actionHover
        else -> t.action
    }
    Box(
        modifier = Modifier
            .size(Metrics.sendButton)
            .clip(CircleShape)
            .background(fill)
            .clickable(interactionSource = interaction, indication = null, enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, tint = if (enabled) t.actionForeground else t.textTertiary, size = Metrics.chatGlyph)
    }
}

/** The provider's mark: Claude keeps its colour, the others are drawn in ink, an unknown one is a dot. */
@Composable
fun ProviderMark(provider: String, modifier: Modifier = Modifier, size: Dp = Metrics.providerMark) {
    val c = Clave.colors
    val mark = when (provider) {
        "claude" -> ClaveIcon.LogoClaude
        "codex" -> ClaveIcon.LogoCodex
        "antigravity" -> ClaveIcon.LogoAntigravity
        "pi" -> ClaveIcon.LogoPi
        else -> null
    }
    if (mark == null) {
        Box(modifier.size(size), contentAlignment = Alignment.Center) { StatusDot(c.theme.textPrimary) }
        return
    }
    Icon(
        mark,
        contentDescription = provider,
        modifier = modifier,
        tint = if (provider == "claude") c.shared.brandClaude else c.theme.textPrimary,
        size = size,
    )
}
