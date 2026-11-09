// Generated from packages/ui/src/tokens.css by apps/mobile-android/scripts/generate-tokens.mjs.
// Do not edit: run the script again; TokensParityTest fails when this file no longer matches the stylesheet.
package com.clave.ui.theme

import androidx.compose.ui.graphics.Color

enum class ThemeName(val id: String) {
    Dark("dark"),
    Light("light"),
    Coffee("coffee"),
    Charcoal("charcoal");

    companion object {
        fun of(id: String?): ThemeName? = entries.firstOrNull { it.id == id }
    }
}

/** The colour roles of one theme, as the desktop names them. */
data class ThemeColors(
    val surface0: Color,
    val surface50: Color,
    val surface100: Color,
    val surface200: Color,
    val surface300: Color,
    val surface400: Color,
    val surfaceRaised: Color,
    val border: Color,
    val borderSubtle: Color,
    val textPrimary: Color,
    val textSecondary: Color,
    val textTertiary: Color,
    val accent: Color,
    val accentHover: Color,
    val action: Color,
    val actionHover: Color,
    val actionForeground: Color,
    val sidebarItemText: Color,
    val sidebarIconColor: Color,
    val selectedRing: Color,
    val scrim: Color,
    val gitWorktree: Color,
    val rule: Color,
)

/** The roles every theme shares, from the @theme block. */
data class SharedColors(
    val destructive: Color,
    val success: Color,
    val warning: Color,
    val statusWorking: Color,
    val statusReady: Color,
    val statusWaiting: Color,
    val statusInactive: Color,
    val switchKnob: Color,
    val brandClaude: Color,
    val gitModified: Color,
    val gitIncoming: Color,
    val termCwd: Color,
    val termModel: Color,
    val termMode: Color,
)

object Tokens {
    val dark = ThemeColors(
        surface0 = Color(0xFF0E0D0C),
        surface50 = Color(0xFF161513),
        surface100 = Color(0xFF1D1C19),
        surface200 = Color(0xFF262420),
        surface300 = Color(0xFF2F2C28),
        surface400 = Color(0xFF38352F),
        surfaceRaised = Color(0xFF161513),
        border = Color(0x1AFFFFFF),
        borderSubtle = Color(0x0FFFFFFF),
        textPrimary = Color(0xF2FFFFFF),
        textSecondary = Color(0x99FFFFFF),
        textTertiary = Color(0x78FFFFFF),
        accent = Color(0xFF5AA2F7),
        accentHover = Color(0xFF78B4F9),
        action = Color(0xFFF1F0EE),
        actionHover = Color(0xFFD7D6D4),
        actionForeground = Color(0xFF0E0D0C),
        sidebarItemText = Color(0xC7FFFFFF),
        sidebarIconColor = Color(0x99FFFFFF),
        selectedRing = Color(0x1F000000),
        scrim = Color(0x66000000),
        gitWorktree = Color(0xFFA78BFA),
        rule = Color(0x0BFFFFFF),
    )
    val light = ThemeColors(
        surface0 = Color(0xFFFBFBF9),
        surface50 = Color(0xFFF5F4F2),
        surface100 = Color(0xFFEEEDEB),
        surface200 = Color(0xFFE4E3E0),
        surface300 = Color(0xFFD7D6D3),
        surface400 = Color(0xFFC9C8C5),
        surfaceRaised = Color(0xFFFFFFFF),
        border = Color(0x1A000000),
        borderSubtle = Color(0x0D000000),
        textPrimary = Color(0xFF1B1B18),
        textSecondary = Color(0xFF5C5C56),
        textTertiary = Color(0xFF70706A),
        accent = Color(0xFF1F5FCF),
        accentHover = Color(0xFF1A51B1),
        action = Color(0xFF1B1B18),
        actionHover = Color(0xFF353532),
        actionForeground = Color(0xFFFBFBF9),
        sidebarItemText = Color(0xFF45453F),
        sidebarIconColor = Color(0xFF6C6C65),
        selectedRing = Color(0x1F000000),
        scrim = Color(0x401B1B18),
        gitWorktree = Color(0xFF7C3AED),
        rule = Color(0x06000000),
    )
    val coffee = ThemeColors(
        surface0 = Color(0xFFF5F1EB),
        surface50 = Color(0xFFEEEBE5),
        surface100 = Color(0xFFE8E4DD),
        surface200 = Color(0xFFDDD9D1),
        surface300 = Color(0xFFD0CBC3),
        surface400 = Color(0xFFC3BDB4),
        surfaceRaised = Color(0xFFFCFAF7),
        border = Color(0x26786450),
        borderSubtle = Color(0x14786450),
        textPrimary = Color(0xFF1B1610),
        textSecondary = Color(0xFF5D574F),
        textTertiary = Color(0xFF6D6660),
        accent = Color(0xFF1F5BC4),
        accentHover = Color(0xFF1A4EA8),
        action = Color(0xFF1B1610),
        actionHover = Color(0xFF34302A),
        actionForeground = Color(0xFFF5F1EB),
        sidebarItemText = Color(0xFF4D4840),
        sidebarIconColor = Color(0xFF756E66),
        selectedRing = Color(0x1F000000),
        scrim = Color(0x402B2218),
        gitWorktree = Color(0xFF7C3AED),
        rule = Color(0x0E786450),
    )
    val charcoal = ThemeColors(
        surface0 = Color(0xFF2B2722),
        surface50 = Color(0xFF34302C),
        surface100 = Color(0xFF3E3A35),
        surface200 = Color(0xFF4C4743),
        surface300 = Color(0xFF5A5651),
        surface400 = Color(0xFF6A6560),
        surfaceRaised = Color(0xFF34302C),
        border = Color(0x1AFFF3E8),
        borderSubtle = Color(0x0FFFF3E8),
        textPrimary = Color(0xFFEFECE9),
        textSecondary = Color(0xFFB8B4B0),
        textTertiary = Color(0xFF9C9893),
        accent = Color(0xFF78B0F5),
        accentHover = Color(0xFF93C0F7),
        action = Color(0xFFEFECE9),
        actionHover = Color(0xFFD9D5D2),
        actionForeground = Color(0xFF2B2722),
        sidebarItemText = Color(0xFFC7C3C0),
        sidebarIconColor = Color(0xFF9F9A96),
        selectedRing = Color(0x12FFF3E8),
        scrim = Color(0x7518120D),
        gitWorktree = Color(0xFFA78BFA),
        rule = Color(0x0BFFF3E8),
    )
    val shared = SharedColors(
        destructive = Color(0xFFEF4444),
        success = Color(0xFF22C55E),
        warning = Color(0xFFF59E0B),
        statusWorking = Color(0xFF3B82F6),
        statusReady = Color(0xFF22C55E),
        statusWaiting = Color(0xFFF59E0B),
        statusInactive = Color(0xFF6B7280),
        switchKnob = Color(0xFFFFFFFF),
        brandClaude = Color(0xFFD97757),
        gitModified = Color(0xFFA78BFA),
        gitIncoming = Color(0xFF38BDF8),
        termCwd = Color(0xFF009FAC),
        termModel = Color(0xFF9B61EA),
        termMode = Color(0xFFC38148),
    )
    const val FONT_WEIGHT_MEDIUM = 400

    fun colors(name: ThemeName): ThemeColors = when (name) {
        ThemeName.Dark -> dark
        ThemeName.Light -> light
        ThemeName.Coffee -> coffee
        ThemeName.Charcoal -> charcoal
    }
}
