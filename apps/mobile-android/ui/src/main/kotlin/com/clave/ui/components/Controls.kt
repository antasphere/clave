package com.clave.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsFocusedAsState
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveIcon
import com.clave.ui.theme.ClaveTypography
import com.clave.ui.theme.Icon
import com.clave.ui.theme.Metrics
import com.clave.ui.theme.Reachability
import com.clave.ui.theme.SessionStatus
import com.clave.ui.theme.ThemeColors
import com.clave.ui.theme.shadow
import com.clave.ui.theme.withAlpha

/**
 * The two colour roles decide the kinds: a verb is ink (Primary, the action fill), the
 * neutral partner is the raised surface (Secondary); Ghost and Destructive carry no fill so
 * a row of them never competes with the one verb.
 */
enum class ButtonKind {
    /** The action fill with the action-foreground label: the one verb of a view. */
    Primary,
    /** Surface-50, the edge hairline and the raised shadow: the neutral partner. */
    Secondary,
    /** No fill, primary ink: a quiet choice beside the others. */
    Ghost,
    /** No fill; the label in the primary ink, readable in every theme, and the danger on a
     *  warning triangle in the destructive hue beside it (its own cue unless an icon is given):
     *  the red as 13 sp words read at 2.97:1 to 3.94:1 on the light grounds. The label names
     *  the action. */
    Destructive,
}

/**
 * `.btn-*` at the control metrics: 36 tall, 10 sides, 6 gap, a 13 label, an 8 corner. A
 * [busy] button is at work on its tap: a spinner takes its glyph's place and it takes no
 * other tap until it is done.
 */
@Composable
fun ClaveButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    kind: ButtonKind = ButtonKind.Secondary,
    icon: ClaveIcon? = null,
    enabled: Boolean = true,
    busy: Boolean = false,
) {
    val c = Clave.colors
    val t = c.theme
    val shape = RoundedCornerShape(Metrics.controlRadius)
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val fill = when (kind) {
        ButtonKind.Primary -> if (pressed) t.actionHover else t.action
        ButtonKind.Secondary -> if (pressed) t.surface100 else t.surface50
        ButtonKind.Ghost, ButtonKind.Destructive -> if (pressed) t.surface100 else Color.Transparent
    }
    val animatedFill by animateColorAsState(fill, tween(Metrics.pressMillis), label = "button fill")
    val ink = if (kind == ButtonKind.Primary) t.actionForeground else t.textPrimary
    val cue = icon ?: if (kind == ButtonKind.Destructive) ClaveIcon.ExclamationTriangle else null
    val cueTint = if (kind == ButtonKind.Destructive) c.shared.destructive else ink
    val raised = if (kind == ButtonKind.Secondary) {
        Modifier.shadow(Clave.shadows.raised, shape).border(Metrics.hairline, c.edge, shape)
    } else {
        Modifier
    }
    Row(
        modifier = modifier
            .alpha(if (enabled) 1f else Metrics.disabledAlpha)
            .then(raised)
            .clip(shape)
            .background(animatedFill)
            .clickable(
                interactionSource = interaction,
                indication = null,
                enabled = enabled && !busy,
                role = Role.Button,
                onClick = onClick,
            )
            .height(Metrics.controlHeight)
            .padding(horizontal = Metrics.controlPadding),
        horizontalArrangement = Arrangement.spacedBy(Metrics.controlGap, Alignment.CenterHorizontally),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (busy) {
            CircularProgressIndicator(Modifier.size(Metrics.controlSmIcon), color = ink, strokeWidth = Metrics.focusRing)
        } else if (cue != null) {
            Icon(cue, contentDescription = null, tint = cueTint, size = Metrics.controlIcon)
        }
        BasicText(
            text = label,
            style = ClaveTypography.type(Metrics.controlText).copy(color = ink),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/**
 * `.btn-icon`: a fixed square, the glyph tertiary at rest and primary under a press on the
 * surface-200 fill; `active` is a state, so it wears the accent.
 */
@Composable
fun ClaveIconButton(
    icon: ClaveIcon,
    onClick: () -> Unit,
    contentDescription: String,
    modifier: Modifier = Modifier,
    size: Dp = Metrics.controlHeight,
    active: Boolean = false,
    enabled: Boolean = true,
    tint: Color? = null,
) {
    val t = Clave.colors.theme
    val small = size < Metrics.controlHeight
    val shape = RoundedCornerShape(if (small) Metrics.controlSmRadius else Metrics.controlRadius)
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val fill = when {
        active -> t.accent.withAlpha(Metrics.activeWashAlpha)
        pressed && enabled -> t.surface200
        else -> Color.Transparent
    }
    val ink = tint ?: when {
        active -> t.accent
        pressed && enabled -> t.textPrimary
        else -> t.textTertiary
    }
    Box(
        modifier = modifier
            .size(size)
            .alpha(if (enabled) 1f else Metrics.disabledAlpha)
            .clip(shape)
            .background(fill)
            .clickable(
                interactionSource = interaction,
                indication = null,
                enabled = enabled,
                role = Role.Button,
                onClick = onClick,
            )
            .semantics {
                this.contentDescription = contentDescription
                selected = active
            },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, contentDescription = null, tint = ink, size = if (small) Metrics.controlSmIcon else Metrics.controlIcon)
    }
}

/**
 * A chip at the small control's height on surface-200; selected is a state, so the ring is
 * the accent. `onRemove` gives an attachment chip its own way out.
 */
@Composable
fun Chip(
    label: String,
    modifier: Modifier = Modifier,
    selected: Boolean = false,
    onClick: (() -> Unit)? = null,
    icon: ClaveIcon? = null,
    onRemove: (() -> Unit)? = null,
) {
    val c = Clave.colors
    val t = c.theme
    val shape = RoundedCornerShape(Metrics.controlSmRadius)
    val ring = if (selected) Modifier.border(Metrics.focusRing, t.accent, shape) else Modifier
    val click = when {
        onClick == null -> Modifier
        else -> Modifier.toggleable(value = selected, role = Role.Checkbox, onValueChange = { onClick() })
    }
    Row(
        modifier = modifier
            .heightIn(min = Metrics.controlSmHeight)
            .clip(shape)
            .background(t.surface200)
            .then(ring)
            .then(click)
            .padding(start = Metrics.controlSmPadding, end = if (onRemove != null) 0.dp else Metrics.controlSmPadding),
        horizontalArrangement = Arrangement.spacedBy(Metrics.controlGap),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) Icon(icon, contentDescription = null, tint = t.textTertiary, size = Metrics.controlSmIcon)
        BasicText(
            text = label,
            modifier = Modifier.weight(1f, fill = false),
            style = ClaveTypography.type(Metrics.controlSmText).copy(color = t.textPrimary),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (onRemove != null) {
            ClaveIconButton(
                icon = ClaveIcon.XMark,
                onClick = onRemove,
                contentDescription = "Remove $label",
                size = Metrics.controlSmHeight,
            )
        }
    }
}

/** `.pane-status-dot`: a state as colour; working breathes so the eye finds it. */
@Composable
fun StatusDot(color: Color, modifier: Modifier = Modifier, pulsing: Boolean = false, size: Dp = Metrics.statusDot) {
    val alpha = if (pulsing) {
        val transition = rememberInfiniteTransition(label = "status pulse")
        val value by transition.animateFloat(
            initialValue = 1f,
            targetValue = Metrics.pulseLowAlpha,
            animationSpec = infiniteRepeatable(tween(Metrics.pulseMillis), RepeatMode.Reverse),
            label = "status pulse alpha",
        )
        value
    } else {
        1f
    }
    Box(modifier.size(size).alpha(alpha).clip(CircleShape).background(color))
}

/**
 * The ink of a state said in words: the theme's secondary text, which reads at 4.5:1 or more on
 * every surface a row sits on in the four themes (StatusInkTest holds it). The state's hue is
 * its dot's alone: 12 sp words in the shared status hues fell to 1.91:1 on the light themes.
 */
fun statusWordInk(theme: ThemeColors): Color = theme.textSecondary

/** `.status-text`: a state said in words at the end of a row, in the readable ink. */
@Composable
fun StatusWord(label: String, modifier: Modifier = Modifier) {
    BasicText(
        text = label,
        modifier = modifier,
        style = ClaveTypography.type(Metrics.textXs).copy(color = statusWordInk(Clave.colors.theme)),
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

/** A state with its own dot, where the row has none: the dot in the state's canonical hue, the
 *  word in the readable ink. */
@Composable
fun StatusWord(label: String, dot: Color, modifier: Modifier = Modifier) {
    Row(
        modifier,
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Metrics.space(1)),
    ) {
        StatusDot(dot)
        StatusWord(label)
    }
}

/** A session's state in the sidebar's words; the session row carries the state's dot itself. */
@Composable
fun StatusWord(status: SessionStatus, modifier: Modifier = Modifier) = StatusWord(status.label, modifier)

/** A machine's reachability: the dot in the state's hue, then the word. */
@Composable
fun StatusWord(reachability: Reachability, modifier: Modifier = Modifier) =
    StatusWord(reachability.label, reachability.color(Clave.colors.shared), modifier)

/** `.badge.badge-muted`: a quiet fact beside a title, on one line, ellipsised when it runs out. */
@Composable
fun Badge(text: String, modifier: Modifier = Modifier) {
    val t = Clave.colors.theme
    BasicText(
        text = text,
        modifier = modifier
            .clip(RoundedCornerShape(Metrics.radiusSm))
            .background(t.surface200)
            .padding(horizontal = Metrics.space(1.5f), vertical = Metrics.space(0.5f)),
        style = ClaveTypography.type(Metrics.textBadge).copy(color = t.textTertiary),
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

/** `.switch`: the accent track when on (a state), surface-300 off, the white knob. */
@Composable
fun ClaveSwitch(checked: Boolean, onCheckedChange: (Boolean) -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val c = Clave.colors
    val track by animateColorAsState(
        if (checked) c.theme.accent else c.theme.surface300,
        tween(Metrics.pressMillis),
        label = "switch track",
    )
    Box(
        modifier = modifier
            .size(Metrics.switchWidth, Metrics.switchHeight)
            .alpha(if (enabled) 1f else Metrics.disabledAlpha)
            .clip(CircleShape)
            .background(track)
            .toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onCheckedChange)
            .padding(Metrics.switchKnobInset),
        contentAlignment = if (checked) Alignment.CenterEnd else Alignment.CenterStart,
    ) {
        Box(
            Modifier
                .size(Metrics.switchHeight - Metrics.switchKnobInset * 2)
                .clip(CircleShape)
                .background(c.shared.switchKnob),
        )
    }
}

/**
 * `.input-field` for a thumb: 40 tall, 12 sides, an 8 corner, 14sp on surface-50 inside the
 * border hairline; focus is a state, so the ring turns accent.
 */
@Composable
fun ClaveTextField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    singleLine: Boolean = true,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    enabled: Boolean = true,
    trailing: (@Composable () -> Unit)? = null,
    /** A secret is masked as typed: pass the password transformation. */
    visualTransformation: VisualTransformation = VisualTransformation.None,
) {
    val t = Clave.colors.theme
    val shape = RoundedCornerShape(Metrics.fieldRadius)
    val interaction = remember { MutableInteractionSource() }
    val focused by interaction.collectIsFocusedAsState()
    val style = ClaveTypography.type(Metrics.fieldText).copy(color = t.textPrimary)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        modifier = modifier.defaultMinSize(minHeight = Metrics.fieldHeight),
        enabled = enabled,
        singleLine = singleLine,
        textStyle = style,
        keyboardOptions = keyboardOptions,
        visualTransformation = visualTransformation,
        cursorBrush = SolidColor(t.accent),
        interactionSource = interaction,
        decorationBox = { inner ->
            Row(
                modifier = Modifier
                    .clip(shape)
                    .background(t.surface50)
                    .border(if (focused) Metrics.focusRing else Metrics.hairline, if (focused) t.accent else t.border, shape)
                    .defaultMinSize(minHeight = Metrics.fieldHeight)
                    .padding(start = Metrics.fieldPadding, end = if (trailing != null) Metrics.space(1) else Metrics.fieldPadding),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(Modifier.weight(1f).padding(vertical = Metrics.space(2))) {
                    if (value.isEmpty() && placeholder != null) {
                        // One line, ellipsised: a long placeholder at a large font scale ends in
                        // an ellipsis rather than being cut mid-letter by the field's edge.
                        BasicText(
                            placeholder,
                            style = style.copy(color = t.textTertiary),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    inner()
                }
                if (trailing != null) trailing()
            }
        },
    )
}
