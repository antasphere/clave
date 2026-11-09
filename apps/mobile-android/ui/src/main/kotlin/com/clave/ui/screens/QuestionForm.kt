package com.clave.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.withStyle
import com.clave.core.chat.QuestionReply
import com.clave.core.chat.questionKey
import com.clave.core.contract.AgentQuestion
import com.clave.ui.components.ClaveTextField
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveIcon
import com.clave.ui.theme.ClaveTypography
import com.clave.ui.theme.Icon
import com.clave.ui.theme.Metrics

/**
 * The form of an agent's questions, shared by a request card and a chat's prompt: each
 * question with its options (one pick, or any with `multiSelect`) and a free answer under
 * "Other". It holds nothing itself: [replies] are the caller's, keyed by [questionKey], and
 * every change goes out through [onChange], to be shaped by the core on submit. A key in
 * [secretKeys] marks a free answer that is a secret, masked as typed.
 */
@Composable
fun QuestionForm(
    questions: List<AgentQuestion>,
    replies: Map<String, QuestionReply>,
    onChange: (key: String, reply: QuestionReply) -> Unit,
    modifier: Modifier = Modifier,
    secretKeys: Set<String> = emptySet(),
    enabled: Boolean = true,
) {
    val t = Clave.colors.theme
    val meta = SpanStyle(fontSize = Metrics.textXs, fontWeight = FontWeight.Normal, color = t.textTertiary)
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Metrics.space(4))) {
        questions.forEachIndexed { index, q ->
            val key = questionKey(q)
            val reply = replies[key] ?: QuestionReply(picked = emptyList())
            val multi = q.multiSelect == true
            Column(verticalArrangement = Arrangement.spacedBy(Metrics.space(2))) {
                Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(Metrics.space(2))) {
                    if (questions.size > 1) {
                        BasicText(
                            "${index + 1}/${questions.size}",
                            modifier = Modifier
                                .clip(CircleShape)
                                .background(t.surface100)
                                .padding(horizontal = Metrics.space(1.5f), vertical = Metrics.space(0.25f)),
                            style = ClaveTypography.type(Metrics.textXs).copy(color = t.textSecondary),
                        )
                    }
                    BasicText(
                        buildAnnotatedString {
                            append(q.question)
                            if (q.header != null) withStyle(meta) { append("  ${q.header}") }
                            if (multi) withStyle(meta) { append("  Choose any") }
                        },
                        modifier = Modifier.weight(1f),
                        style = ClaveTypography.type(Metrics.textControl, FontWeight.Medium, Metrics.proseLineHeight)
                            .copy(color = t.textPrimary),
                    )
                }
                Column {
                    q.options.forEach { option ->
                        val picked = option.label in reply.picked
                        OptionRow(
                            label = option.label,
                            hint = option.description,
                            selected = picked,
                            multi = multi,
                            enabled = enabled,
                            onClick = {
                                val next = when {
                                    multi && picked -> reply.picked - option.label
                                    multi -> reply.picked + option.label
                                    else -> listOf(option.label)
                                }
                                onChange(key, reply.copy(picked = next))
                            },
                        )
                    }
                    val other = reply.other.orEmpty()
                    val secret = key in secretKeys
                    OptionRow(label = "Other", selected = other.isNotBlank(), multi = multi, enabled = enabled, onClick = null) {
                        ClaveTextField(
                            value = other,
                            onValueChange = { onChange(key, reply.copy(other = it)) },
                            placeholder = "Type your own answer",
                            singleLine = secret,
                            enabled = enabled,
                            keyboardOptions = if (secret) KeyboardOptions(keyboardType = KeyboardType.Password) else KeyboardOptions.Default,
                            visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
                            // Named by its purpose, not its placeholder: TalkBack says "Your own answer".
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(top = Metrics.space(1))
                                .semantics { contentDescription = "Your own answer" },
                        )
                    }
                }
            }
        }
    }
}

/**
 * One choice of a question, the desktop prompt dock's option: a full-width row at the
 * control's height, the box (any) or the ring (one) carrying the pick in the accent. With
 * [content], the row's body is that content (the "Other" field) and the row itself takes no tap.
 */
@Composable
private fun OptionRow(
    label: String,
    selected: Boolean,
    multi: Boolean,
    enabled: Boolean,
    onClick: (() -> Unit)?,
    hint: String? = null,
    content: (@Composable () -> Unit)? = null,
) {
    val t = Clave.colors.theme
    val click = when {
        onClick == null -> Modifier
        multi -> Modifier.toggleable(value = selected, enabled = enabled, role = Role.Checkbox, onValueChange = { onClick() })
        else -> Modifier.selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick)
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .alpha(if (enabled) 1f else Metrics.disabledAlpha)
            .clip(RoundedCornerShape(Metrics.controlRadius))
            .then(click)
            .heightIn(min = Metrics.controlHeight)
            .padding(horizontal = Metrics.space(1), vertical = Metrics.space(1.5f)),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(Metrics.space(2.5f)),
    ) {
        val shape = if (multi) RoundedCornerShape(Metrics.radiusSm) else CircleShape
        Box(
            Modifier
                .padding(top = Metrics.space(0.5f))
                .size(Metrics.controlIcon)
                .clip(shape)
                .background(if (selected) t.accent else Color.Transparent)
                .border(Metrics.hairline, if (selected) t.accent else t.border, shape),
            contentAlignment = Alignment.Center,
        ) {
            if (selected) Icon(ClaveIcon.Check, contentDescription = null, tint = Clave.colors.shared.switchKnob, size = Metrics.controlXsIcon)
        }
        Column(Modifier.weight(1f)) {
            BasicText(label, style = ClaveTypography.type(Metrics.textControl, lineHeight = Metrics.proseLineHeight).copy(color = t.textPrimary))
            if (!hint.isNullOrBlank()) {
                BasicText(hint, style = ClaveTypography.type(Metrics.textXs, lineHeight = Metrics.proseLineHeight).copy(color = t.textTertiary))
            }
            if (content != null) content()
        }
    }
}
