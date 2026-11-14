/**
 * The one rule for whether an answer fits a hosted form's question, ported from the
 * contract's `input-kinds.ts` (`answerProblem`): the words the card shows under a field, null
 * when the answer fits. The server judges again; this only spares the person a refusal.
 */
package com.clave.core.chat

import com.clave.core.contract.AgentQuestion
import com.clave.core.contract.FormAnswer
import com.clave.core.contract.InputKind

private val GITHUB_LOGIN = Regex("^(?!-)(?!.*--)[A-Za-z0-9-]{1,39}(?<!-)$")
private val EMAIL = Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$")
private val DATE = Regex("^\\d{4}-\\d{2}-\\d{2}$")
private val NUMBER = Regex("^-?\\d+(\\.\\d+)?$")
private val WINDOWS_PATH = Regex("^[A-Za-z]:[\\\\/]")

private fun bound(n: Double): String = if (n == Math.floor(n)) n.toLong().toString() else n.toString()

fun answerProblem(question: AgentQuestion, value: FormAnswer?): String? {
    val kind = question.kind
    val empty = when (value) {
        null -> true
        is FormAnswer.Text -> value.value.isBlank()
        is FormAnswer.Choices -> value.values.all { it.isBlank() }
    }
    if (empty) return if (question.optional == true) null else "An answer is needed"
    if (kind == null) return null
    if (kind == InputKind.Choice) {
        val picked = when (value) {
            is FormAnswer.Text -> listOf(value.value)
            is FormAnswer.Choices -> value.values
            null -> emptyList()
        }
        if (question.multiSelect != true && picked.size > 1) return "Choose one"
        if (question.optionsOnly != true) return null
        val labels = question.options.map { it.label }.toSet()
        return if (picked.all { it in labels }) null else "Choose among the options"
    }
    if (value is FormAnswer.Choices) return "One answer is expected"
    val v = (value as FormAnswer.Text).value.trim()
    return when (kind) {
        InputKind.Email -> if (EMAIL.matches(v)) null else "This is not an e-mail address"
        InputKind.Url -> {
            val uri = try {
                java.net.URI(v)
            } catch (_: java.net.URISyntaxException) {
                null
            }
            when {
                uri?.scheme == null || uri.host == null -> "This is not a web address"
                uri.scheme == "http" || uri.scheme == "https" -> null
                else -> "A web address starts with https://"
            }
        }
        InputKind.GithubLogin -> if (GITHUB_LOGIN.matches(v)) null else "A GitHub login is letters, digits and hyphens"
        InputKind.Number -> {
            if (!NUMBER.matches(v)) return "This is not a number"
            val n = v.toDouble()
            val min = question.min
            val max = question.max
            when {
                min != null && n < min -> "At least ${bound(min)}"
                max != null && n > max -> "At most ${bound(max)}"
                else -> null
            }
        }
        InputKind.Date -> {
            if (!DATE.matches(v)) return "A date, as YYYY-MM-DD"
            try {
                java.time.LocalDate.parse(v)
                null
            } catch (_: java.time.format.DateTimeParseException) {
                "This is not a date"
            }
        }
        InputKind.File, InputKind.Folder ->
            if (v.startsWith("/") || WINDOWS_PATH.containsMatchIn(v) || v.startsWith("~")) null else "A full path, from the root of the disk"
        InputKind.Link -> if (v == "done") null else "Open the link, then confirm"
        else -> null
    }
}

/** A hosted multi-select answers with the labels as a list; every other question with one line. */
fun answersAsLists(question: AgentQuestion): Boolean = question.kind == InputKind.Choice && question.multiSelect == true
