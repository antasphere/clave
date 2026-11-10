package com.clave.ui.screens

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.clave.ui.chat.AssistantProse
import com.clave.ui.chat.ToolRow
import com.clave.ui.chat.ToolStatus
import com.clave.ui.chat.UserTurn
import com.clave.ui.components.ListRow
import com.clave.ui.components.PaneHeader
import com.clave.ui.components.ScreenScaffold
import com.clave.ui.components.SectionLabel
import com.clave.ui.theme.Appearance
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveIcon
import com.clave.ui.theme.ClaveTypography
import com.clave.ui.theme.Icon
import com.clave.ui.theme.Metrics
import com.clave.ui.theme.ThemeColors
import com.clave.ui.theme.Tokens
import com.clave.ui.theme.themeFor

/**
 * Appearance: the desktop's four themes plus the phone's "Match the system", each row with a
 * swatch painted in that theme's own tokens, so the choice is seen before it is made.
 */
@Composable
fun AppearanceScreen(
    appearance: Appearance,
    onAppearance: (Appearance) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val t = Clave.colors.theme
    ScreenScaffold(
        modifier = modifier,
        header = { PaneHeader(title = "Appearance", subtitle = "Theme", onBack = onBack) },
    ) { padding ->
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(padding)
                .padding(vertical = Metrics.space(4)),
        ) {
            SectionLabel("Theme")
            BasicText(
                text = "The desktop's four themes. Matching the system picks dark or light with the phone.",
                modifier = Modifier.padding(horizontal = Metrics.gutter).padding(bottom = Metrics.space(2)),
                style = ClaveTypography.type(Metrics.textXs, lineHeight = Metrics.proseLineHeight).copy(color = t.textSecondary),
            )
            Appearance.entries.forEach { option ->
                val selected = option == appearance
                ListRow(
                    title = option.label,
                    selected = false,
                    onClick = { onAppearance(option) },
                    modifier = Modifier.semantics {
                        contentDescription = if (selected) "${option.label}, selected" else option.label
                    },
                    leading = { Swatch(option, selected) },
                    trailing = {
                        if (selected) {
                            Icon(ClaveIcon.Check, contentDescription = null, tint = t.accent, size = Metrics.chatGlyph)
                        } else {
                            Spacer(Modifier.size(Metrics.chatGlyph))
                        }
                    },
                )
            }
            Spacer(Modifier.height(Metrics.space(6)))
            SectionLabel("Preview")
            AppearancePreviewStrip(Modifier.padding(horizontal = Metrics.gutter))
        }
    }
}

/** The swatch: surface-0 ground, a surface-50 chrome strip, a text line and the accent dot. */
@Composable
private fun Swatch(appearance: Appearance, selected: Boolean) {
    val t = Clave.colors.theme
    val shape = RoundedCornerShape(Metrics.radiusMd)
    val ring = if (selected) Modifier.border(Metrics.focusRing, t.accent, shape) else Modifier.border(Metrics.hairline, t.border, shape)
    val halves: List<ThemeColors> = if (appearance == Appearance.System) {
        listOf(Tokens.dark, Tokens.light)
    } else {
        listOf(Tokens.colors(themeFor(appearance, systemDark = true)))
    }
    Canvas(
        Modifier
            .size(Metrics.swatchWidth, Metrics.swatchHeight)
            .clip(shape)
            .then(ring),
    ) {
        val part = size.width / halves.size
        halves.forEachIndexed { i, colors ->
            clipRect(left = part * i, right = part * (i + 1)) { paintSwatch(colors) }
        }
    }
}

private fun DrawScope.paintSwatch(colors: ThemeColors) {
    val chrome = Metrics.swatchChrome.toPx()
    val pad = Metrics.space(1.5f).toPx()
    val line = Metrics.swatchLine.toPx()
    val dot = Metrics.swatchDot.toPx()
    drawRect(colors.surface0)
    drawRect(colors.surface50, size = Size(size.width, chrome))
    drawRoundRect(
        colors.textPrimary,
        topLeft = Offset(pad, chrome + pad),
        size = Size(Metrics.swatchLineWidth.toPx(), line),
        cornerRadius = CornerRadius(line / 2),
    )
    drawCircle(colors.accent, radius = dot / 2, center = Offset(pad + dot / 2, size.height - pad - dot / 2))
}

/**
 * A short exchange in the current theme: a user turn, an answer, a tool row. It is a picture
 * of the theme, not a conversation, so to TalkBack it is one description and offers nothing
 * to press: its children's words and the tool row's toggle are cleared from the semantics.
 */
@Composable
fun AppearancePreviewStrip(modifier: Modifier = Modifier) {
    var open by remember { mutableStateOf(false) }
    Column(
        modifier
            .fillMaxWidth()
            .clearAndSetSemantics { contentDescription = "A preview of the theme" },
        verticalArrangement = Arrangement.spacedBy(Metrics.space(3)),
    ) {
        UserTurn(text = "Can you tidy up the README before the release?")
        AssistantProse(
            markdown = "Sure. I will **rewrite the introduction** and keep the `npm install` steps as they are.",
        )
        ToolRow(
            summary = "Edited",
            hint = "README.md",
            status = ToolStatus.Complete,
            expanded = open,
            onToggle = { open = !open },
            kind = "edit",
            sections = listOf("Change" to "- Clave is a desktop app\n+ Clave runs agent sessions as tabs"),
        )
    }
}

