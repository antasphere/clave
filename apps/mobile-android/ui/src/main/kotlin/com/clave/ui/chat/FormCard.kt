package com.clave.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import com.clave.core.chat.answerProblem
import com.clave.core.chat.answersAsLists
import com.clave.core.chat.questionKey
import com.clave.core.contract.AgentQuestion
import com.clave.core.contract.FormAnswer
import com.clave.core.contract.InputKind
import com.clave.ui.components.ButtonKind
import com.clave.ui.components.Chip
import com.clave.ui.components.ClaveButton
import com.clave.ui.components.ClaveTextField
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveIcon
import com.clave.ui.theme.ClaveTypography
import com.clave.ui.theme.Icon
import com.clave.ui.theme.Metrics
import com.clave.ui.theme.shadow

/** One question's state on the card: the options picked and the person's own words. */
private data class FormField(val picked: List<String> = emptyList(), val words: String = "")

/** The field a draft or a default starts from: a list is picks; a line is a pick when it is one of the options. */
private fun fieldOf(q: AgentQuestion, start: FormAnswer?): FormField {
    val labels = q.options.map { it.label }
    return when (start) {
        is FormAnswer.Choices -> FormField(picked = start.values.filter { it in labels }, words = start.values.filterNot { it in labels }.joinToString(", "))
        is FormAnswer.Text -> if (start.value in labels) FormField(picked = listOf(start.value)) else FormField(words = start.value)
        null -> q.default?.let { fieldOf(q, FormAnswer.Text(it)) } ?: FormField()
    }
}

/** What a field answers: a hosted multi-select its labels as a list (and the own words), any other one line. */
private fun answerOf(q: AgentQuestion, field: FormField): FormAnswer {
    val words = field.words.trim()
    if (answersAsLists(q)) return FormAnswer.Choices(field.picked + listOfNotNull(words.ifEmpty { null }))
    if (q.kind == null && q.multiSelect == true) {
        // A provider's own multi-select answers with one string, the labels joined.
        return FormAnswer.Text((field.picked + listOfNotNull(words.ifEmpty { null })).joinToString(", "))
    }
    return FormAnswer.Text(words.ifEmpty { field.picked.firstOrNull().orEmpty() })
}

private fun keyboardOf(kind: InputKind?): KeyboardOptions = when (kind) {
    InputKind.Email -> KeyboardOptions(keyboardType = KeyboardType.Email)
    InputKind.Url, InputKind.Link -> KeyboardOptions(keyboardType = KeyboardType.Uri)
    InputKind.Number -> KeyboardOptions(keyboardType = KeyboardType.Decimal)
    InputKind.Date -> KeyboardOptions(keyboardType = KeyboardType.Number)
    else -> KeyboardOptions.Default
}

/**
 * A question the agent asks, or a hosted form, inline in the transcript: one question at a
 * time ("2 of 3"), each drawn for its kind (a choice as chips, several when it allows them, the
 * person's own words beside unless it is closed to its options; a text, an e-mail, a number, a
 * date, a path as a field with the matching keyboard; a link as Open and the button that says
 * the person is back), the agent's draft and its notes shown, and each answer checked by the
 * contract's rule before it goes. [options] are the request's: the refusals (Skip) sit left.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun FormCard(
    title: String,
    questions: List<AgentQuestion>,
    options: List<Pair<String, String>>,
    onAnswer: (optionId: String, answers: Map<String, FormAnswer>) -> Unit,
    modifier: Modifier = Modifier,
    draft: Map<String, FormAnswer> = emptyMap(),
    notes: Map<String, String> = emptyMap(),
    answered: String? = null,
    onLink: (String) -> Unit = {},
) {
    val c = Clave.colors
    val t = c.theme
    val shape = RoundedCornerShape(Metrics.radiusXl)
    val fields = remember(questions) {
        mutableStateMapOf<String, FormField>().apply { questions.forEach { put(questionKey(it), fieldOf(it, draft[questionKey(it)])) } }
    }
    // A draft the agent fills later lands in a field the person has not touched.
    val touched = remember(questions) { mutableStateMapOf<String, Boolean>() }
    LaunchedEffect(questions, draft) {
        questions.forEach { q ->
            val key = questionKey(q)
            if (touched[key] != true) fields[key] = fieldOf(q, draft[key])
        }
    }
    var step by remember(questions) { mutableIntStateOf(0) }
    var problem by remember(questions) { mutableStateOf<String?>(null) }
    val q = questions.getOrNull(step.coerceIn(0, (questions.size - 1).coerceAtLeast(0)))
    fun edit(key: String, field: FormField) {
        touched[key] = true
        fields[key] = field
        problem = null
    }
    Column(
        modifier
            .fillMaxWidth()
            .shadow(Clave.shadows.raised, shape)
            .clip(shape)
            .background(t.surfaceRaised)
            .border(Metrics.hairline, t.borderSubtle, shape)
            .padding(horizontal = Metrics.space(3.5f), vertical = Metrics.space(3))
            .testTag("form-card"),
        verticalArrangement = Arrangement.spacedBy(Metrics.space(2)),
    ) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(Metrics.space(2))) {
            BasicText(
                title,
                modifier = Modifier.weight(1f),
                style = ClaveTypography.type(Metrics.textControl, FontWeight.Medium, Metrics.proseLineHeight).copy(color = t.textPrimary),
            )
            if (questions.size > 1 && answered == null) {
                BasicText("${step + 1} of ${questions.size}", style = ClaveTypography.type(Metrics.textXs).copy(color = t.textTertiary))
            }
        }
        if (answered != null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Metrics.space(1.5f))) {
                Icon(ClaveIcon.Check, null, tint = t.textTertiary, size = Metrics.chatGlyph)
                BasicText(answered, style = ClaveTypography.type(Metrics.codeSize).copy(color = t.textTertiary))
            }
            return@Column
        }
        if (q != null) {
            val key = questionKey(q)
            val field = fields[key] ?: FormField()
            if (q.header != null) BasicText(q.header!!, style = ClaveTypography.type(Metrics.textMeta).copy(color = t.textTertiary))
            BasicText(q.question, style = ClaveTypography.type(Metrics.textSm, lineHeight = Metrics.proseLineHeight).copy(color = t.textPrimary))
            if (!q.hint.isNullOrBlank()) {
                BasicText(q.hint!!, style = ClaveTypography.type(Metrics.textXs, lineHeight = Metrics.proseLineHeight).copy(color = t.textTertiary))
            }
            when {
                q.kind == InputKind.Link -> Row(horizontalArrangement = Arrangement.spacedBy(Metrics.controlGap)) {
                    val url = q.url
                    if (url != null) ClaveButton("Open", onClick = { onLink(url) }, icon = ClaveIcon.Link, modifier = Modifier.heightIn(min = ThumbHeight))
                    val back = field.words == "done"
                    ClaveButton(
                        q.confirm ?: "I'm back",
                        onClick = { edit(key, FormField(words = "done")) },
                        kind = if (back) ButtonKind.Primary else ButtonKind.Secondary,
                        icon = if (back) ClaveIcon.Check else null,
                        modifier = Modifier.heightIn(min = ThumbHeight),
                    )
                }
                else -> {
                    if (q.options.isNotEmpty()) {
                        val multi = q.multiSelect == true
                        FlowRow(
                            horizontalArrangement = Arrangement.spacedBy(Metrics.space(1.5f)),
                            verticalArrangement = Arrangement.spacedBy(Metrics.space(1.5f)),
                        ) {
                            q.options.forEach { option ->
                                val chosen = option.label in field.picked
                                Chip(
                                    label = option.label,
                                    selected = chosen,
                                    modifier = Modifier.heightIn(min = Metrics.controlHeight),
                                    onClick = {
                                        val picked = when {
                                            chosen -> field.picked - option.label
                                            multi -> field.picked + option.label
                                            else -> listOf(option.label)
                                        }
                                        // A single pick replaces the own words, as choosing does on the desktop.
                                        edit(key, field.copy(picked = picked, words = if (multi || chosen) field.words else ""))
                                    },
                                )
                            }
                        }
                        q.options.firstOrNull { it.label in field.picked && !it.description.isNullOrBlank() }?.let {
                            BasicText(it.description!!, style = ClaveTypography.type(Metrics.textXs).copy(color = t.textTertiary))
                        }
                    }
                    val ownWords = q.options.isEmpty() || q.optionsOnly != true
                    if (ownWords) {
                        ClaveTextField(
                            value = field.words,
                            onValueChange = { edit(key, field.copy(words = it, picked = if (q.multiSelect == true) field.picked else emptyList())) },
                            placeholder = q.placeholder ?: when {
                                q.options.isNotEmpty() -> "Type your own answer"
                                q.kind == InputKind.Date -> "YYYY-MM-DD"
                                q.kind == InputKind.File || q.kind == InputKind.Folder -> "/full/path"
                                else -> "Your answer"
                            },
                            singleLine = q.kind != InputKind.LongText && q.kind != null,
                            keyboardOptions = keyboardOf(q.kind),
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            }
            notes[key]?.let { BasicText(it, style = ClaveTypography.type(Metrics.textXs).copy(color = t.textSecondary)) }
            problem?.let {
                Row(
                    Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Metrics.space(1)),
                ) {
                    Icon(ClaveIcon.ExclamationTriangle, null, tint = c.shared.destructive, size = Metrics.controlXsIcon)
                    BasicText(it, style = ClaveTypography.type(Metrics.textXs).copy(color = t.textPrimary))
                }
            }
        }
        val denies = options.filter { isDenyOption(it.first) }
        val primary = options.firstOrNull { it.first == "answer" } ?: ("answer" to "Send")
        val last = step >= questions.size - 1
        Row(
            Modifier.fillMaxWidth().padding(top = Metrics.space(1)),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Metrics.controlGap),
        ) {
            denies.forEach { (id, label) ->
                ClaveButton(label, onClick = { onAnswer(id, emptyMap()) }, modifier = Modifier.heightIn(min = ThumbHeight))
            }
            Spacer(Modifier.weight(1f))
            if (step > 0) ClaveButton("Back", onClick = { step -= 1; problem = null }, kind = ButtonKind.Ghost, modifier = Modifier.heightIn(min = ThumbHeight))
            ClaveButton(
                if (last) primary.second else "Next",
                kind = ButtonKind.Primary,
                modifier = Modifier.heightIn(min = ThumbHeight),
                onClick = {
                    val answers = questions.associate { each -> questionKey(each) to answerOf(each, fields[questionKey(each)] ?: FormField()) }
                    if (!last && q != null) {
                        val wrong = answerProblem(q, answers[questionKey(q)])
                        if (wrong != null) problem = wrong else step += 1
                        return@ClaveButton
                    }
                    val failing = questions.indexOfFirst { answerProblem(it, answers[questionKey(it)]) != null }
                    if (failing >= 0) {
                        step = failing
                        problem = answerProblem(questions[failing], answers[questionKey(questions[failing])])
                    } else {
                        // An optional question left empty is not sent.
                        onAnswer(primary.first, answers.filterValues { it != FormAnswer.Text("") && it != FormAnswer.Choices(emptyList()) })
                    }
                },
            )
        }
    }
}
