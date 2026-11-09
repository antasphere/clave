package com.clave.ui.theme

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ThemeTest {
    @Test
    fun matchingTheSystemIsDarkUnlessTheSystemIsLight() {
        assertEquals(ThemeName.Dark, themeFor(Appearance.System, systemDark = true))
        assertEquals(ThemeName.Light, themeFor(Appearance.System, systemDark = false))
    }

    @Test
    fun aChosenThemeIgnoresTheSystem() {
        for (dark in listOf(true, false)) {
            assertEquals(ThemeName.Dark, themeFor(Appearance.Dark, dark))
            assertEquals(ThemeName.Light, themeFor(Appearance.Light, dark))
            assertEquals(ThemeName.Coffee, themeFor(Appearance.Coffee, dark))
            assertEquals(ThemeName.Charcoal, themeFor(Appearance.Charcoal, dark))
        }
    }

    @Test
    fun theAppearanceLabelsAndKeyAreThePrototypes() {
        assertEquals(
            listOf("Match the system", "Dark", "Light", "Coffee", "Charcoal"),
            Appearance.entries.map { it.label },
        )
        assertEquals("clave.appearance", APPEARANCE_KEY)
        assertEquals(Appearance.Coffee, Appearance.of("coffee"))
        assertEquals(Appearance.System, Appearance.of("sepia"))
        assertEquals(Appearance.System, Appearance.of(null))
    }

    @Test
    fun theEdgeIsWhiteOnDarkGroundsAndBlackOnLightOnes() {
        for (name in listOf(ThemeName.Dark, ThemeName.Charcoal)) {
            val c = claveColorsFor(name)
            assertTrue(c.isDark)
            assertEquals(Color.White.copy(alpha = 0.16f), c.edge)
        }
        for (name in listOf(ThemeName.Light, ThemeName.Coffee)) {
            val c = claveColorsFor(name)
            assertFalse(c.isDark)
            assertEquals(Color.Black.copy(alpha = 0.16f), c.edge)
        }
    }

    @Test
    fun eachThemeWearsItsOwnTokens() {
        assertEquals(Tokens.coffee, claveColorsFor(ThemeName.Coffee).theme)
        assertEquals(Tokens.shared, claveColorsFor(ThemeName.Light).shared)
    }

    @Test
    fun sessionStatesHaveTheirWordsAndInks() {
        val s = Tokens.shared
        assertEquals(listOf("Working", "Waiting for you", "Idle", "Finished", "Error"), SessionStatus.entries.map { it.label })
        assertEquals(s.statusWorking, SessionStatus.Working.color(s))
        assertEquals(s.statusWaiting, SessionStatus.Waiting.color(s))
        assertEquals(s.statusInactive, SessionStatus.Idle.color(s))
        assertEquals(s.statusReady, SessionStatus.Finished.color(s))
        assertEquals(s.destructive, SessionStatus.Error.color(s))
        assertTrue(SessionStatus.Working.pulses)
        assertFalse(SessionStatus.Idle.pulses)
    }

    @Test
    fun reachabilityHasItsWordsAndInks() {
        val s = Tokens.shared
        assertEquals(listOf("Reachable", "Connecting", "Not reachable", "Token refused"), Reachability.entries.map { it.label })
        assertEquals(s.statusReady, Reachability.Reachable.color(s))
        assertEquals(s.statusWorking, Reachability.Connecting.color(s))
        assertEquals(s.statusInactive, Reachability.Unreachable.color(s))
        assertEquals(s.destructive, Reachability.Refused.color(s))
    }

    @Test
    fun shadowsCarryEachThemesInk() {
        assertEquals(0.3f, claveShadowsFor(ThemeName.Dark).raised.alpha, 0f)
        assertEquals(0.07f, claveShadowsFor(ThemeName.Light).overlay.alpha, 0f)
        assertEquals(Color(0xFF3C2D1E), claveShadowsFor(ThemeName.Coffee).raised.color)
        assertEquals(0.34f, claveShadowsFor(ThemeName.Charcoal).overlay.alpha, 0f)
    }
}
