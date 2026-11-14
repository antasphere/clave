package com.clave.ui.theme

import androidx.compose.ui.graphics.Color

/**
 * The desktop's group colours (session-types.ts `TERMINAL_COLOR_VALUES`): a group names one
 * of these or a `#rrggbb` of its own. The same hex in every theme, as on the desktop, where
 * the dot is drawn in the group's colour whatever the theme.
 */
private val GROUP_COLORS: Map<String, Long> = mapOf(
    "black" to 0xFF95979C,
    "green" to 0xFF4CB782,
    "teal" to 0xFF53B7C5,
    "blue" to 0xFF5E6AD2,
    "purple" to 0xFF8B95A8,
    "yellow" to 0xFFE8B931,
    "pink" to 0xFFDB8B4E,
    "red" to 0xFFD45461,
)

/** A group's colour as the desktop resolves it (`resolveColorHex`); null for none or a name it does not know. */
fun groupColorOf(name: String?): Color? {
    if (name.isNullOrEmpty()) return null
    GROUP_COLORS[name]?.let { return Color(it) }
    val hex = name.removePrefix("#")
    if (!name.startsWith("#") || (hex.length != 6 && hex.length != 8)) return null
    val value = hex.toLongOrNull(16) ?: return null
    return Color(if (hex.length == 6) 0xFF000000 or value else value)
}
