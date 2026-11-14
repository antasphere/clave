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
