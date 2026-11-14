package com.clave.core.chat

import com.clave.core.contract.AgentQuestion
import com.clave.core.contract.AgentQuestionOption
import com.clave.core.contract.FormAnswer
import com.clave.core.contract.InputKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class FormsTest {
    private fun q(kind: InputKind?, vararg options: String, optional: Boolean? = null, multi: Boolean? = null, only: Boolean? = null, min: Double? = null, max: Double? = null) =
        AgentQuestion(question = "Q", options = options.map { AgentQuestionOption(it) }, kind = kind, optional = optional, multiSelect = multi, optionsOnly = only, min = min, max = max)

    private fun t(v: String) = FormAnswer.Text(v)

    @Test
    fun `an empty answer fits only an optional question`() {
        assertEquals("An answer is needed", answerProblem(q(InputKind.Text), t("  ")))
        assertNull(answerProblem(q(InputKind.Text, optional = true), null))
        assertNull(answerProblem(q(null), t("anything")))
    }

    @Test
    fun `each kind says what to type`() {
        assertEquals("This is not an e-mail address", answerProblem(q(InputKind.Email), t("luca@")))
        assertNull(answerProblem(q(InputKind.Email), t("luca@antasphere.com")))
        assertEquals("A web address starts with https://", answerProblem(q(InputKind.Url), t("ftp://x.com")))
        assertEquals("This is not a web address", answerProblem(q(InputKind.Url), t("hello")))
        assertNull(answerProblem(q(InputKind.Url), t("https://x.com/a")))
        assertEquals("A GitHub login is letters, digits and hyphens", answerProblem(q(InputKind.GithubLogin), t("-bad")))
        assertNull(answerProblem(q(InputKind.GithubLogin), t("luca-a")))
        assertEquals("This is not a number", answerProblem(q(InputKind.Number), t("3a")))
        assertEquals("At least 1", answerProblem(q(InputKind.Number, min = 1.0), t("0")))
        assertEquals("At most 9", answerProblem(q(InputKind.Number, max = 9.0), t("10")))
        assertEquals("A date, as YYYY-MM-DD", answerProblem(q(InputKind.Date), t("14/11/2026")))
        assertEquals("This is not a date", answerProblem(q(InputKind.Date), t("2026-02-30")))
        assertNull(answerProblem(q(InputKind.Date), t("2026-11-14")))
        assertEquals("A full path, from the root of the disk", answerProblem(q(InputKind.Folder), t("src")))
        assertNull(answerProblem(q(InputKind.File), t("~/notes.md")))
        assertEquals("Open the link, then confirm", answerProblem(q(InputKind.Link), t("yes")))
        assertNull(answerProblem(q(InputKind.Link), t("done")))
        assertEquals("One answer is expected", answerProblem(q(InputKind.Text), FormAnswer.Choices(listOf("a"))))
    }

    @Test
    fun `a choice takes one, several when allowed, and its options alone when closed`() {
        assertEquals("Choose one", answerProblem(q(InputKind.Choice, "a", "b"), FormAnswer.Choices(listOf("a", "b"))))
        assertNull(answerProblem(q(InputKind.Choice, "a", "b", multi = true), FormAnswer.Choices(listOf("a", "b"))))
        assertEquals("Choose among the options", answerProblem(q(InputKind.Choice, "a", only = true), t("z")))
        assertNull(answerProblem(q(InputKind.Choice, "a"), t("my own words")))
        assertEquals(true, answersAsLists(q(InputKind.Choice, multi = true)))
        assertEquals(false, answersAsLists(q(null, multi = true)))
    }
}
