package com.clave.core.chat

import com.clave.core.contract.IdLabel
import com.clave.core.contract.SessionEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ApprovalsTest {
    private fun permission(answer: String? = null, answeredElsewhere: Boolean = false) = Entry.Permission(
        request = SessionEvent.PermissionRequest(
            id = "p",
            description = "Allow?",
            toolName = "Bash",
            options = listOf(IdLabel("allow", "Allow"), IdLabel("deny", "Deny")),
        ),
        answer = answer,
        answeredElsewhere = answeredElsewhere,
        at = 0,
    )

    @Test
    fun `reads a Codex command approval in the reader words`() {
        assertEquals(
            ApprovalDescription("Run a command", "npm test"),
            describeApproval(
                SessionEvent.PermissionRequest(
                    id = "c",
                    description = "x",
                    toolName = "item/commandExecution/requestApproval",
                    input = j("""{"command":["npm","test"]}"""),
                    options = emptyList(),
                ),
            ),
        )
    }

    @Test
    fun `says a decision in words and knows a refusal`() {
        val entry = permission()
        assertEquals("Allow", decisionWord(entry.request, "allow"))
        assertTrue(refused(entry.request, "deny"))
        assertFalse(refused(entry.request, "allow"))
        assertTrue(
            refused(
                entry.request.copy(options = listOf(IdLabel("""{"permissions":{}}""", "Deny extra permissions"))),
                """{"permissions":{}}""",
            ),
        )
    }

    @Test
    fun `folds only an allowed, answered, tool-named approval into a run`() {
        assertTrue(settledApproval(permission(answer = "allow")))
        assertFalse(settledApproval(permission(answer = "deny")))
        assertFalse(settledApproval(permission()))
        assertFalse(settledApproval(permission(answer = "allow", answeredElsewhere = true)))
        val question = permission(answer = "answer")
        assertTrue(isQuestion(question.request.copy(toolName = null)))
    }

    @Test
    fun `summarises a run by what was allowed`() {
        val a = permission(answer = "allow")
        assertEquals(ApprovalRunSummary("Allowed 2 requests", "Bash ×2"), approvalRunSummary(listOf(a, a)))
    }
}
