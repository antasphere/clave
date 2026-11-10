package com.clave.core.chat

import com.clave.core.contract.AgentQuestion
import com.clave.core.contract.AgentQuestionOption
import com.clave.core.contract.IdLabel
import com.clave.core.contract.PendingRequest
import com.clave.core.contract.RequestKind
import com.clave.core.contract.RequestResponse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AnswersTest {
    private val permission = PendingRequest(
        id = "p",
        sessionId = "s",
        kind = RequestKind.Permission,
        description = "Run ls?",
        createdAt = 1,
        options = listOf(IdLabel("allow-once", "Allow once"), IdLabel("deny", "Deny")),
    )
    private val questions = PendingRequest(
        id = "q",
        sessionId = "s",
        kind = RequestKind.Clarification,
        description = "Two questions",
        createdAt = 1,
        providerRequestId = "native-3",
        options = listOf(IdLabel("answer", "Answer"), IdLabel("deny", "Skip")),
        questions = listOf(
            AgentQuestion(
                id = "colour",
                question = "Which colour?",
                options = listOf(AgentQuestionOption("Red"), AgentQuestionOption("Blue")),
                multiSelect = true,
            ),
            AgentQuestion(question = "Why?", options = listOf(AgentQuestionOption("Because"))),
        ),
    )

    @Test
    fun `a permission answers with one of its options and nothing else`() {
        assertEquals(Shaped.Ok(RequestResponse.Permission("allow-once")), shapePermission(permission, "allow-once"))
        assertTrue(shapePermission(permission, "allow-always") is Shaped.Problem)
    }

    @Test
    fun `a native question answers like a permission with the answers keyed by id or text`() {
        assertTrue(answersAsPermission(questions))
        assertTrue(answersAsPermission(permission))
        assertFalse(answersAsPermission(questions.copy(providerRequestId = null)))
        val shaped = shapePermission(
            questions,
            "answer",
            mapOf(
                "colour" to QuestionReply(listOf("Red", "Blue"), other = "and a bit of green"),
                "Why?" to QuestionReply(listOf("Because")),
            ),
        )
        assertEquals(
            Shaped.Ok(RequestResponse.Permission("answer", mapOf("colour" to "Red, Blue, and a bit of green", "Why?" to "Because"))),
            shaped,
        )
    }

    @Test
    fun `a missing answer names the question and sends nothing`() {
        assertEquals(
            Shaped.Problem("Answer \"Why?\" first."),
            shapePermission(questions, "answer", mapOf("colour" to QuestionReply(listOf("Red")))),
        )
        assertEquals(Shaped.Ok(RequestResponse.Permission("deny")), shapePermission(questions, "deny"))
    }

    @Test
    fun `a single choice keeps one pick, a free answer alone counts`() {
        val q = questions.questions!![1]
        assertEquals("Because", answerText(q, QuestionReply(listOf("Because", "Other"))))
        assertEquals("typed", answerText(q, QuestionReply(emptyList(), other = "  typed  ")))
        assertEquals("", answerText(q, null))
        assertEquals("Why?", questionKey(q))
    }

    @Test
    fun `a clarification without a provider id answers as a clarification`() {
        val plain = questions.copy(providerRequestId = null, options = null)
        assertEquals(
            Shaped.Ok(RequestResponse.Clarification(mapOf("colour" to "Blue", "Why?" to "x"))),
            shapeClarification(
                plain,
                mapOf("colour" to QuestionReply(listOf("Blue")), "Why?" to QuestionReply(emptyList(), other = "x")),
            ),
        )
    }

    @Test
    fun `a secret travels as its value and never empty`() {
        assertTrue(shapeSecret("") is Shaped.Problem)
        assertEquals(Shaped.Ok(RequestResponse.Secret("shh")), shapeSecret("shh"))
        assertEquals(RequestResponse.Dismiss, dismissal)
    }
}
