/**
 * What the phone's forms send back for a pending request, shaped the way the server's
 * `PendingRequests.validate` reads it: a permission answers with one of its option ids,
 * plus the answers when the request asked questions and the option is `answer`; a
 * clarification answers every question under its key, `q.id ?: q.question`, none empty; a
 * secret answers its value, which travels in the resolve body and nowhere else; a dismissal
 * answers nothing. A multi-select question joins the picked labels with `, `. Ported from
 * `apps/mobile/src/requests/answers.ts`.
 */
package com.clave.core.chat

import com.clave.core.contract.AgentQuestion
import com.clave.core.contract.PendingRequest
import com.clave.core.contract.RequestKind
import com.clave.core.contract.RequestResponse

fun questionKey(q: AgentQuestion): String = q.id ?: q.question

/** What the reader chose for one question: picked option labels, a free answer. */
data class QuestionReply(val picked: List<String>, val other: String? = null)

sealed interface Shaped {
    data class Ok(val response: RequestResponse) : Shaped
    data class Problem(val problem: String) : Shaped
}

sealed interface ShapedAnswers {
    data class Ok(val answers: Map<String, String>) : ShapedAnswers
    data class Problem(val problem: String) : ShapedAnswers
}

/** The text of one question's reply: the labels joined, or the free answer. */
fun answerText(q: AgentQuestion, reply: QuestionReply?): String {
    if (reply == null) return ""
    val other = reply.other?.trim() ?: ""
    val picked = if (q.multiSelect == true) reply.picked else reply.picked.take(1)
    val parts = picked + (if (other.isNotEmpty()) listOf(other) else emptyList())
    return parts.joinToString(", ").trim()
}

fun shapeAnswers(questions: List<AgentQuestion>, replies: Map<String, QuestionReply>): ShapedAnswers {
    val answers = linkedMapOf<String, String>()
    for (q in questions) {
        val key = questionKey(q)
        val text = answerText(q, replies[key])
        if (text.isEmpty()) return ShapedAnswers.Problem("Answer \"${q.header ?: q.question}\" first.")
        answers[key] = text
    }
    return ShapedAnswers.Ok(answers)
}

fun shapePermission(request: PendingRequest, optionId: String, replies: Map<String, QuestionReply> = emptyMap()): Shaped {
    if (request.options?.any { it.id == optionId } != true) return Shaped.Problem("That option is not one of this request.")
    val questions = request.questions
    if (!questions.isNullOrEmpty() && optionId == "answer") {
        return when (val shaped = shapeAnswers(questions, replies)) {
            is ShapedAnswers.Problem -> Shaped.Problem(shaped.problem)
            is ShapedAnswers.Ok -> Shaped.Ok(RequestResponse.Permission(optionId, shaped.answers))
        }
    }
    return Shaped.Ok(RequestResponse.Permission(optionId))
}

fun shapeClarification(request: PendingRequest, replies: Map<String, QuestionReply>): Shaped =
    when (val shaped = shapeAnswers(request.questions ?: emptyList(), replies)) {
        is ShapedAnswers.Problem -> Shaped.Problem(shaped.problem)
        is ShapedAnswers.Ok -> Shaped.Ok(RequestResponse.Clarification(shaped.answers))
    }

fun shapeSecret(value: String): Shaped =
    if (value.isEmpty()) Shaped.Problem("Enter the secret first.") else Shaped.Ok(RequestResponse.Secret(value))

val dismissal: RequestResponse = RequestResponse.Dismiss

/** A request the server holds under a provider's id (a native prompt of the agent) answers
 *  like a permission even when its kind is clarification. */
fun answersAsPermission(request: PendingRequest): Boolean =
    request.kind == RequestKind.Permission || request.providerRequestId != null
