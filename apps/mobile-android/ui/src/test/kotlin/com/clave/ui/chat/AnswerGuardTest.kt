package com.clave.ui.chat

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AnswerGuardTest {
    @Test
    fun aRequestJustShownIgnoresTapsUntilItHasSettled() {
        val guard = AnswerGuard(shownAt = 1_000)
        assertFalse(guard.admit(1_000))
        assertFalse(guard.admit(1_000 + PROMPT_SETTLE_MILLIS - 1))
        assertTrue(guard.admit(1_000 + PROMPT_SETTLE_MILLIS))
    }

    @Test
    fun aDoubleTapIsOneAnswer() {
        val guard = AnswerGuard(shownAt = 0)
        assertTrue(guard.admit(5_000))
        assertFalse(guard.admit(5_080))
        // A tap well after the first (its answer refused, say) goes again.
        assertTrue(guard.admit(5_000 + PROMPT_SETTLE_MILLIS))
    }
}
