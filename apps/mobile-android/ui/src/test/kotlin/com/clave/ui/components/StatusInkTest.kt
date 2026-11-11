package com.clave.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import com.clave.ui.theme.Reachability
import com.clave.ui.theme.SessionStatus
import com.clave.ui.theme.ThemeName
import com.clave.ui.theme.Tokens
import kotlin.math.max
import kotlin.math.min
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * A state said in words is small text (12 sp): WCAG's 4.5:1 for normal text applies. The words
 * take [statusWordInk]; the states' hues stay the dots' and are the shared tokens, unchanged.
 */
class StatusInkTest {
    /** WCAG 2's contrast ratio of [ink], composited over the opaque [surface], against it. */
    private fun contrast(ink: Color, surface: Color): Double {
        val a = ink.compositeOver(surface).luminance().toDouble()
        val b = surface.luminance().toDouble()
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    @Test
    fun `the ratio is WCAG's, and the shared hues as words fail on the light themes`() {
        assertEquals(21.0, contrast(Color.Black, Color.White), 0.01)
        assertEquals(1.0, contrast(Color(0xFF777777), Color(0xFF777777)), 1e-9)
        // The figures the visual review measured at 9140214d, recomputed here: why the hue left the word.
        assertEquals(1.91, contrast(Tokens.shared.statusWaiting, Tokens.coffee.surface0), 0.005)
        assertEquals(2.07, contrast(Tokens.shared.statusWaiting, Tokens.light.surface0), 0.005)
        assertEquals(3.07, contrast(Tokens.shared.statusInactive, Tokens.charcoal.surface0), 0.005)
    }

    @Test
    fun `a state said in words reads at 4·5 to 1 or more on every surface its row sits on, in every theme`() {
        for (name in ThemeName.entries) {
            val t = Tokens.colors(name)
            // At rest a row sits on the screen (surface0) or a card (surface50, raised); pressed, on surface100.
            val surfaces = listOf("surface0" to t.surface0, "surface50" to t.surface50, "surface100" to t.surface100, "surfaceRaised" to t.surfaceRaised)
            for ((surface, color) in surfaces) {
                val ratio = contrast(statusWordInk(t), color)
                assertTrue("$name, the status words on $surface: %.2f:1".format(ratio), ratio >= 4.5)
            }
        }
    }

    @Test
    fun `the hues stay the dots', the shared tokens unchanged`() {
        val s = Tokens.shared
        assertEquals(s.statusReady, SessionStatus.Finished.color(s))
        assertEquals(s.statusWaiting, SessionStatus.Waiting.color(s))
        assertEquals(s.statusWorking, SessionStatus.Working.color(s))
        assertEquals(s.statusInactive, SessionStatus.Idle.color(s))
        assertEquals(s.destructive, SessionStatus.Error.color(s))
        assertEquals(s.statusReady, Reachability.Reachable.color(s))
        assertEquals(s.destructive, Reachability.Refused.color(s))
        for (name in ThemeName.entries) {
            val ink = statusWordInk(Tokens.colors(name))
            for (hue in listOf(s.statusReady, s.statusWaiting, s.statusWorking, s.statusInactive, s.destructive)) {
                assertTrue("$name: the words are never drawn in a state's hue", ink != hue)
            }
        }
    }
}
