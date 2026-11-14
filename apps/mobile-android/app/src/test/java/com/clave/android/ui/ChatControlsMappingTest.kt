package com.clave.android.ui

import com.clave.core.chat.ContextUsageState
import com.clave.core.chat.Conversation
import com.clave.core.chat.Entry
import com.clave.core.chat.PermissionModeState
import com.clave.core.contract.EffortOption
import com.clave.core.contract.IdLabel
import com.clave.core.contract.ModelOption
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatControlsMappingTest {
    private val models = listOf(
        ModelOption("claude-opus-5-5", "Opus 5.5", hint = "Most capable",
            efforts = listOf(EffortOption("low", "Low"), EffortOption("high", "High")), defaultEffort = "high"),
        ModelOption("claude-haiku-4-5-20251001", "Haiku 4.5"),
    )

    @Test
    fun theRowNamesTheModelItsEffortTheModeAndTheContext() {
        val conversation = Conversation(
            model = "claude-opus-5-5",
            effort = "low",
            permissionMode = PermissionModeState("plan", listOf(IdLabel("default", "Ask"), IdLabel("plan", "Plan"))),
            contextUsage = ContextUsageState(250_000, null),
        )
        val view = chatControlsView("claude", conversation, ChatControlsState(models = models))
        assertEquals("Opus 5.5", view.model)
        assertEquals(listOf(true, false), view.models.map { it.selected })
        assertEquals("Low", view.effort)
        assertEquals(listOf("low", "high"), view.efforts.map { it.id })
        assertEquals("Plan", view.mode)
        assertEquals("plan", view.modes.single { it.selected }.id)
        // No window said yet: the model's own (1M for Opus 5.5).
        assertEquals("250k/1M", view.contextLabel)
        assertEquals(0.25f, view.contextRatio, 0.0001f)
    }

    @Test
    fun aChatWithoutAModelYetStillOffersThePickerAndNoMeter() {
        val view = chatControlsView("codex", Conversation(), ChatControlsState())
        assertEquals("…", view.model)
        assertNull(view.effort)
        assertNull(view.mode)
        assertNull(view.contextLabel)
    }

    @Test
    fun aPickShowsAtOnceUntilTheProviderSaysAWord() {
        val before = Conversation(model = "claude-opus-5-5")
        val picked = ChatControlsState(models = models, pendingModel = "claude-haiku-4-5-20251001", pendingFrom = "claude-opus-5-5")
        val waiting = chatControlsView("claude", before, picked)
        assertEquals("Haiku 4.5", waiting.model)
        assertTrue(waiting.modelPending)
        val confirmed = chatControlsView("claude", before.copy(model = "claude-haiku-4-5"), picked)
        assertEquals("Haiku 4.5", confirmed.model)
        assertFalse(confirmed.modelPending)
        val refused = chatControlsView("claude", before.copy(entries = listOf(Entry.Error("No such model", 1))), picked)
        assertEquals("Opus 5.5", refused.model)
        assertFalse(refused.modelPending)
    }

    @Test
    fun aRefusedSwitchIsSaidAsTheServerSaidIt() {
        val view = chatControlsView("claude", Conversation(), ChatControlsState(refusal = "A phone may not do this."))
        assertEquals("A phone may not do this.", view.refusal)
    }
}

class PromptViewMappingTest {
    private fun permission(id: String, tool: String = "Bash", answer: String? = null) = Entry.Permission(
        request = com.clave.core.contract.SessionEvent.PermissionRequest(
            id = id,
            description = "Run",
            options = listOf(IdLabel("deny", "Deny"), IdLabel("allow", "Allow")),
            toolName = tool,
            input = kotlinx.serialization.json.Json.parseToJsonElement("""{"command":"npm test"}"""),
        ),
        answer = answer,
        at = 1,
    )

    @Test
    fun theFirstWaitingPermissionIsDockedWithItsReadingAndTheQueueCount() {
        val conversation = Conversation(
            entries = listOf(permission("a", answer = "allow"), permission("b"), permission("c")),
            explained = mapOf(
                "b" to com.clave.core.contract.SessionEvent.PermissionExplained(
                    "b",
                    level = com.clave.core.contract.RiskLevel.Project,
                    sentence = "Runs the tests.",
                ),
            ),
        )
        val view = promptView("claude", conversation)!!
        assertEquals("b", view.id)
        assertEquals("Allow Claude to run a command?", view.title)
        assertEquals("npm test", view.code)
        assertEquals("bash", view.language)
        assertEquals("Changes files of the project", view.levelLabel)
        assertEquals("Runs the tests.", view.sentence)
        assertEquals(2, view.count)
        assertEquals(listOf("deny" to "Deny", "allow" to "Allow"), view.options)
    }

    @Test
    fun nothingIsDockedWhenNothingWaitsOrOnlyAQuestionDoes() {
        assertNull(promptView("claude", Conversation(entries = listOf(permission("a", answer = "allow")))))
        assertNull(promptView("claude", Conversation(entries = listOf(permission("q", tool = "")))))
    }
}

class WorkCardsMappingTest {
    @Test
    fun aCommandShowsItsCommandAndASubagentItsModel() {
        val conversation = Conversation(
            backgroundTasks = listOf(
                com.clave.core.contract.BackgroundTask("b1", com.clave.core.contract.BackgroundTaskKind.Shell, "Dev server", command = "npm run dev", startedAt = 5),
                com.clave.core.contract.BackgroundTask("a1", com.clave.core.contract.BackgroundTaskKind.Agent, "Review the parser", startedAt = 6, model = "claude-haiku-4-5-20251001"),
                com.clave.core.contract.BackgroundTask("o1", com.clave.core.contract.BackgroundTaskKind.Shell, "", command = "sleep 60", startedAt = 7),
            ),
        )
        val cards = workCards(conversation)
        assertEquals(listOf("Dev server", "Review the parser", "sleep 60"), cards.map { it.title })
        assertEquals(listOf(true, false, true), cards.map { it.shell })
        assertEquals("npm run dev", cards[0].detail)
        assertEquals("On Haiku 4.5", cards[1].detail)
        assertEquals(5L, cards[0].startedAt)
    }
}

class SlashCommandsMappingTest {
    @Test
    fun theComposerListsTheMatchingCommandsOnlyWhileASlashIsTyped() {
        val commands = listOf(com.clave.core.contract.CommandOption("compact", "Compact the context", "/compact "))
        assertEquals(listOf("compact"), slashCommands("/co", commands).map { it.name })
        assertEquals("/compact ", slashCommands("/", commands).single().insert)
        assertTrue(slashCommands("hello", commands).isEmpty())
    }
}

class ThumbnailsMappingTest {
    @Test
    fun aPictureChipShowsThePhonesCopyAndAnyOtherFileItsGlyph() {
        fun file(id: String, mime: String) = com.clave.core.contract.FileAttachment(
            id = id, path = "/s/$id", name = id, mimeType = mime, size = 1, delivery = com.clave.core.contract.FileDelivery.Reference,
        )
        val controls = ChatControlsState(thumbnails = mapOf("a" to "content://media/1"))
        assertEquals(listOf("content://media/1", null), attachmentThumbnails(listOf(file("a", "image/png"), file("b", "text/plain")), controls))
    }
}
