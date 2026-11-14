package com.clave.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.clave.core.chat.toolPreview
import com.clave.core.contract.RiskLevel
import com.clave.ui.components.ButtonKind
import com.clave.ui.components.ClaveButton
import com.clave.ui.components.ClaveIconButton
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveIcon
import com.clave.ui.theme.ClaveTypography
import com.clave.ui.theme.Icon
import com.clave.ui.theme.Metrics
import com.clave.ui.theme.shadow
import com.clave.ui.theme.withAlpha

/** A button a thumb finds: the desktop's control, 48 tall on the phone's prompt. */
val ThumbHeight: Dp = 48.dp

/**
 * The request the agent waits on, docked above the composer: the request in the reader's
 * words, the host's reading of what it does, its command or change as code, and the options.
 * [count] is how many wait in all; this is the first of them.
 */
@Immutable
data class PromptView(
    val id: String,
    val title: String,
    val target: String? = null,
    val detail: String? = null,
    val code: String? = null,
    /** "bash", "diff", or null for plain text. */
    val language: String? = null,
    val level: RiskLevel? = null,
    val levelLabel: String? = null,
    val sentence: String? = null,
    val mismatch: Boolean = false,
    val note: String? = null,
    val options: List<Pair<String, String>> = emptyList(),
    val count: Int = 1,
)

/** An option id that refuses, the desktop's `isDeny`. */
internal fun isDenyOption(id: String): Boolean =
    Regex("deny|decline|cancel|reject|abort", RegexOption.IGNORE_CASE).containsMatchIn(id)

/** The options in the desktop's order: refusals first, the allowing ones after, the first (the provider's default) last. */
internal fun orderedOptions(options: List<Pair<String, String>>): List<Pair<String, String>> {
    val denies = options.filter { isDenyOption(it.first) }
    val allows = options.filterNot { isDenyOption(it.first) }
    return denies + allows.drop(1).reversed() + allows.take(1)
}

/** The level's words with its glyph for the three that change something; never green. */
@Composable
fun RiskPill(level: RiskLevel?, label: String, modifier: Modifier = Modifier) {
    val c = Clave.colors
    val t = c.theme
    val (icon, ink) = when (level) {
        RiskLevel.Irreversible -> ClaveIcon.ExclamationTriangle to c.shared.destructive
        RiskLevel.Outside -> ClaveIcon.GlobeAlt to c.shared.warning
        RiskLevel.Project -> ClaveIcon.PencilSquare to t.textSecondary
        else -> null to t.textTertiary
    }
    Row(
        modifier
            .clip(RoundedCornerShape(Metrics.controlSmRadius))
            .background(t.surface100)
            .padding(horizontal = Metrics.space(2), vertical = Metrics.space(1)),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Metrics.space(1)),
    ) {
        if (icon != null) Icon(icon, null, tint = ink, size = Metrics.controlXsIcon)
        BasicText(label, style = ClaveTypography.type(Metrics.textXs, FontWeight.Medium).copy(color = t.textPrimary))
    }
}

/**
 * Code as the chat draws it: monospace on surface-100, scrolled sideways rather than wrapped;
 * a diff's added lines on a green wash and removed ones on a red one, a command after "$ ".
 * The copy button puts the whole text on the clipboard.
 */
@Composable
fun CodeBlock(
    text: String,
    language: String?,
    modifier: Modifier = Modifier,
    maxHeight: Dp? = null,
    copyable: Boolean = true,
) {
    val c = Clave.colors
    val t = c.theme
    val clipboard = LocalClipboardManager.current
    val style = ClaveTypography.mono(Metrics.textXs).copy(color = t.textSecondary)
    val lines = text.split("\n")
    Box(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Metrics.radiusMd))
            .background(t.surface100)
            .testTag("code-block"),
    ) {
        val bounded = if (maxHeight != null) Modifier.heightIn(max = maxHeight).verticalScroll(rememberScrollState()) else Modifier
        Box(bounded.horizontalScroll(rememberScrollState()).padding(Metrics.space(2))) {
            Column(Modifier.width(IntrinsicSize.Max)) {
                lines.forEachIndexed { index, line ->
                    val wash = when {
                        language != "diff" -> Color.Transparent
                        line.startsWith("+") -> c.shared.success.withAlpha(0.16f)
                        line.startsWith("-") -> c.shared.destructive.withAlpha(0.16f)
                        else -> Color.Transparent
                    }
                    val shown = if (language == "bash" && index == 0) "$ $line" else line
                    BasicText(
                        shown.ifEmpty { " " },
                        modifier = Modifier.fillMaxWidth().background(wash).padding(end = if (copyable) 28.dp else 0.dp),
                        style = if (wash != Color.Transparent) style.copy(color = t.textPrimary) else style,
                        softWrap = false,
                    )
                }
            }
        }
        if (copyable) {
            ClaveIconButton(
                icon = ClaveIcon.ClipboardDocument,
                onClick = { clipboard.setText(AnnotatedString(text)) },
                contentDescription = "Copy code",
                size = Metrics.controlXsHeight,
                modifier = Modifier.align(Alignment.TopEnd),
            )
        }
    }
}

/** The reading inside a card: the level, the sentence, a mismatch, or one quiet note. */
@Composable
fun PermissionReadingView(
    level: RiskLevel?,
    levelLabel: String?,
    sentence: String?,
    mismatch: Boolean,
    note: String?,
    modifier: Modifier = Modifier,
) {
    val c = Clave.colors
    val t = c.theme
    if (levelLabel == null && sentence == null && note == null) return
    Column(modifier.semantics { liveRegion = LiveRegionMode.Polite }, verticalArrangement = Arrangement.spacedBy(Metrics.space(1.5f))) {
        if (levelLabel != null) RiskPill(level, levelLabel)
        if (sentence != null) {
            BasicText(sentence, style = ClaveTypography.type(Metrics.textControl, lineHeight = Metrics.proseLineHeight).copy(color = t.textPrimary))
        }
        if (mismatch) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Metrics.space(1))) {
                Icon(ClaveIcon.ExclamationTriangle, null, tint = c.shared.warning, size = Metrics.controlXsIcon)
                BasicText("Not what you asked for", style = ClaveTypography.type(Metrics.textXs, FontWeight.Medium).copy(color = t.textPrimary))
            }
        }
        if (note != null) {
            BasicText(note, style = ClaveTypography.type(Metrics.textXs).copy(color = t.textTertiary))
        }
    }
}

/**
 * The docked permission card: answered here, in the chat, with buttons a thumb finds. Two
 * options share one row, refusal left and the verb right; more stack, the provider's default
 * last, nearest the thumb.
 */
@Composable
fun PermissionPrompt(view: PromptView, onAnswer: (optionId: String) -> Unit, modifier: Modifier = Modifier) {
    val t = Clave.colors.theme
    val shape = RoundedCornerShape(Metrics.radiusXl)
    Column(
        modifier
            .fillMaxWidth()
            .shadow(Clave.shadows.raised, shape)
            .clip(shape)
            .background(t.surfaceRaised)
            .border(Metrics.hairline, t.borderSubtle, shape)
            .padding(horizontal = Metrics.space(3.5f), vertical = Metrics.space(3))
            .testTag("permission-prompt"),
        verticalArrangement = Arrangement.spacedBy(Metrics.space(2)),
    ) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(Metrics.space(2))) {
            Icon(ClaveIcon.ShieldCheck, null, tint = t.textSecondary, size = Metrics.controlIcon)
            BasicText(
                view.title,
                modifier = Modifier.weight(1f),
                style = ClaveTypography.type(Metrics.textSm, FontWeight.Medium, Metrics.proseLineHeight).copy(color = t.textPrimary),
            )
            if (view.count > 1) {
                BasicText("1 of ${view.count} waiting", style = ClaveTypography.type(Metrics.textXs).copy(color = t.textTertiary))
            }
        }
        if (!view.target.isNullOrBlank()) {
            BasicText(
                view.target,
                style = ClaveTypography.mono(Metrics.textXs).copy(color = t.textTertiary),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        PermissionReadingView(view.level, view.levelLabel, view.sentence, view.mismatch, view.note)
        if (!view.detail.isNullOrBlank()) {
            BasicText(view.detail, style = ClaveTypography.type(Metrics.codeSize, lineHeight = Metrics.proseLineHeight).copy(color = t.textSecondary))
        }
        if (view.code != null) CodeBlock(view.code, view.language, maxHeight = 180.dp)
        val ordered = orderedOptions(view.options)
        val primary = view.options.firstOrNull { !isDenyOption(it.first) }?.first
        if (ordered.size <= 2) {
            Row(Modifier.fillMaxWidth().padding(top = Metrics.space(1)), horizontalArrangement = Arrangement.spacedBy(Metrics.controlGap)) {
                ordered.forEach { (id, label) ->
                    ClaveButton(
                        label,
                        onClick = { onAnswer(id) },
                        kind = if (id == primary) ButtonKind.Primary else ButtonKind.Secondary,
                        modifier = Modifier.weight(1f).heightIn(min = ThumbHeight),
                    )
                }
            }
        } else {
            Column(Modifier.fillMaxWidth().padding(top = Metrics.space(1)), verticalArrangement = Arrangement.spacedBy(Metrics.controlGap)) {
                ordered.forEach { (id, label) ->
                    ClaveButton(
                        label,
                        onClick = { onAnswer(id) },
                        kind = if (id == primary) ButtonKind.Primary else ButtonKind.Secondary,
                        modifier = Modifier.fillMaxWidth().heightIn(min = ThumbHeight),
                    )
                }
            }
        }
    }
}

/** One section of an opened tool: its label, its text, and how it reads ("bash", "diff", a file's extension). */
@Immutable
data class ToolSectionView(val label: String, val text: String, val language: String? = null)

private val DIFF_LINE = Regex("^[-+] ", RegexOption.MULTILINE)

/** A section handed over without a language: a change written as one reads as a diff. */
internal fun guessLanguage(text: String): String? = if (DIFF_LINE.containsMatchIn(text)) "diff" else null

/**
 * A section's first lines (8 lines or 2000 characters, the desktop's preview), the rest one
 * tap away: opening a call never pours a whole output into the column.
 */
@Composable
fun ToolSection(section: ToolSectionView, modifier: Modifier = Modifier) {
    val t = Clave.colors.theme
    var full by rememberSaveable(section.text) { mutableStateOf(false) }
    val preview = toolPreview(section.text)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(Metrics.space(1))) {
        BasicText(section.label, style = ClaveTypography.type(Metrics.textXs).copy(color = t.textTertiary))
        CodeBlock(if (full) section.text else preview.text, section.language)
        if (preview.truncated) {
            BasicText(
                if (full) "Show less" else "Show all",
                modifier = Modifier
                    .heightIn(min = Metrics.controlXsHeight)
                    .clickable(role = Role.Button) { full = !full }
                    .padding(vertical = Metrics.space(1)),
                style = ClaveTypography.type(Metrics.textXs, FontWeight.Medium).copy(color = t.textSecondary),
            )
        }
    }
}
