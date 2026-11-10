package com.clave.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveIcon
import com.clave.ui.theme.ClaveTypography
import com.clave.ui.theme.Icon
import com.clave.ui.theme.Metrics

/**
 * `.pane-header`: the one row at the top of every pane on the desktop and of every screen
 * here. It takes the status-bar inset itself, so it is safe outside a [ScreenScaffold] too;
 * inside one the inset is already consumed and nothing doubles. The row is 44 tall at
 * least and grows with the text, so at a large font scale the title and the subtitle each
 * keep their whole line (ellipsised, never cut) rather than being clipped to the row.
 */
@Composable
fun PaneHeader(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    onBack: (() -> Unit)? = null,
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
            if (onBack != null) {
                ClaveIconButton(icon = ClaveIcon.ArrowLeft, onClick = onBack, contentDescription = "Back")
            }
            Column(
                Modifier
                    .weight(1f)
                    .padding(start = if (onBack == null) Metrics.space(3) else Metrics.space(1)),
            ) {
                BasicText(
                    text = title,
                    modifier = Modifier.semantics { heading() },
                    style = ClaveTypography.type(Metrics.textSm, FontWeight.Medium).copy(color = t.textPrimary),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (subtitle != null) {
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

/**
 * The sidebar row: 36 tall at least, the gutter on both sides; a row that opens somewhere
 * says so with the chevron unless it brings its own trailing control.
 */
@Composable
fun ListRow(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    leading: (@Composable () -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
    onClick: (() -> Unit)? = null,
    selected: Boolean = false,
) {
    val t = Clave.colors.theme
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val fill = when {
        selected -> t.surface200
        pressed -> t.surface100
        else -> Color.Transparent
    }
    val click = if (onClick != null) {
        Modifier.clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick)
    } else {
        Modifier
    }
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(fill)
            .then(click)
            .semantics { this.selected = selected }
            .heightIn(min = Metrics.rowMinHeight)
            .padding(horizontal = Metrics.gutter, vertical = Metrics.space(2)),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Metrics.space(3)),
    ) {
        if (leading != null) leading()
        Column(Modifier.weight(1f)) {
            BasicText(
                text = title,
                style = ClaveTypography.type(Metrics.textControl).copy(color = t.textPrimary),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle != null) {
                BasicText(
                    text = subtitle,
                    style = ClaveTypography.type(Metrics.textXs, lineHeight = Metrics.proseLineHeight).copy(color = t.textTertiary),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        when {
            trailing != null -> trailing()
            onClick != null -> Icon(ClaveIcon.ChevronRight, contentDescription = null, tint = t.textTertiary)
        }
    }
}

/** A section's label: the desktop's 11px, tracked out, tertiary, in sentence case. */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    BasicText(
        text = text,
        modifier = modifier
            .padding(horizontal = Metrics.gutter, vertical = Metrics.space(2))
            .semantics { heading() },
        style = ClaveTypography.type(Metrics.textMeta).copy(
            color = Clave.colors.theme.textTertiary,
            letterSpacing = Metrics.labelTracking,
        ),
    )
}

/** A hairline between blocks (`--rule-color`, the one repeating-list hairline). */
@Composable
fun Rule(modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().height(Metrics.hairline).background(Clave.colors.theme.rule))
}

enum class NoticeKind { Info, Warning, Destructive }

/** A notice's one way forward. */
data class NoticeAction(val label: String, val onClick: () -> Unit)

/**
 * An inline banner inside the content, never over the status bar: surface-100 on the large
 * corner; the kind is told by the glyph's ink so the text stays readable in every theme.
 */
@Composable
fun Notice(
    text: String,
    modifier: Modifier = Modifier,
    kind: NoticeKind = NoticeKind.Info,
    action: NoticeAction? = null,
) {
    val c = Clave.colors
    val t = c.theme
    val ink = when (kind) {
        NoticeKind.Info -> t.textTertiary
        NoticeKind.Warning -> c.shared.warning
        NoticeKind.Destructive -> c.shared.destructive
    }
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Metrics.radiusLg))
            .background(t.surface100)
            .semantics { if (kind != NoticeKind.Info) liveRegion = LiveRegionMode.Polite }
            .padding(horizontal = Metrics.space(3), vertical = Metrics.space(2.5f)),
        horizontalArrangement = Arrangement.spacedBy(Metrics.space(2)),
        verticalAlignment = Alignment.Top,
    ) {
        if (kind == NoticeKind.Info) {
            Box(Modifier.size(Metrics.chatGlyph), contentAlignment = Alignment.Center) { StatusDot(ink) }
        } else {
            Icon(ClaveIcon.ExclamationTriangle, contentDescription = null, tint = ink, size = Metrics.chatGlyph)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Metrics.space(1))) {
            BasicText(
                text = text,
                style = ClaveTypography.type(Metrics.textControl, lineHeight = Metrics.proseLineHeight).copy(
                    // The hue is the triangle's: the destructive red reads at 2.97:1 to 3.22:1 on
                    // this surface in the light themes, the primary ink at 12:1 and more.
                    color = if (kind == NoticeKind.Destructive) t.textPrimary else t.textSecondary,
                ),
            )
            if (action != null) {
                BasicText(
                    text = action.label,
                    modifier = Modifier.clickable(role = Role.Button, onClick = action.onClick),
                    style = ClaveTypography.type(Metrics.textControl, lineHeight = Metrics.proseLineHeight).copy(
                        color = t.textPrimary,
                        textDecoration = TextDecoration.Underline,
                    ),
                )
            }
        }
    }
}

/** `.chat-empty`: the icon on its tile, a title, a line under it. */
@Composable
fun EmptyState(
    icon: ClaveIcon,
    title: String,
    modifier: Modifier = Modifier,
    text: String? = null,
    action: (@Composable () -> Unit)? = null,
) {
    val t = Clave.colors.theme
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = Metrics.space(4), vertical = Metrics.space(8)),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Metrics.space(3)),
    ) {
        Box(
            Modifier
                .size(Metrics.emptyTile)
                .clip(RoundedCornerShape(Metrics.radiusXxl))
                .background(t.surface100),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = t.textTertiary, size = Metrics.emptyIcon)
        }
        BasicText(
            text = title,
            style = ClaveTypography.type(Metrics.textSm).copy(color = t.textPrimary, textAlign = TextAlign.Center),
        )
        if (text != null) {
            BasicText(
                text = text,
                style = ClaveTypography.type(Metrics.textXs, lineHeight = Metrics.proseLineHeight)
                    .copy(color = t.textTertiary, textAlign = TextAlign.Center),
            )
        }
        if (action != null) action()
    }
}

/**
 * A screen: surface-0 edge to edge, the header under the status bar, the content between,
 * and the bottom slot (the composer) above both the navigation bar and the keyboard.
 * `insets` defaults to the safe-drawing area, which includes the IME; the `imePadding`
 * after it only adds what is not already consumed, so the composer is lifted once. The
 * activity must draw edge to edge with `adjustResize` for the IME inset to arrive at all.
 * Without a bottom slot the content receives the bottom inset as padding instead.
 */
@Composable
fun ScreenScaffold(
    header: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    bottom: (@Composable () -> Unit)? = null,
    insets: WindowInsets = WindowInsets.safeDrawing,
    content: @Composable (PaddingValues) -> Unit,
) {
    val t = Clave.colors.theme
    Column(modifier.fillMaxSize().background(t.surface0)) {
        Box(Modifier.windowInsetsPadding(insets.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))) {
            header()
        }
        val sides = insets.only(WindowInsetsSides.Horizontal)
        Box(Modifier.weight(1f).fillMaxWidth().windowInsetsPadding(sides)) {
            val padding = if (bottom == null) insets.only(WindowInsetsSides.Bottom).asPaddingValues() else PaddingValues()
            content(padding)
        }
        if (bottom != null) {
            Box(
                Modifier
                    .fillMaxWidth()
                    .windowInsetsPadding(insets.only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal))
                    .imePadding(),
            ) {
                bottom()
            }
        }
    }
}
