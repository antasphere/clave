package com.clave.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import org.junit.Assert.assertEquals
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * The committed Tokens.kt against the desktop's stylesheet, re-read here the way
 * scripts/generate-tokens.mjs reads it: a drift between the two fails the build instead of
 * shipping a phone in last month's colours.
 */
class TokensParityTest {
    private val themeRoles = linkedMapOf(
        "surface0" to "surface-0", "surface50" to "surface-50", "surface100" to "surface-100",
        "surface200" to "surface-200", "surface300" to "surface-300", "surface400" to "surface-400",
        "surfaceRaised" to "surface-raised", "border" to "border-color", "borderSubtle" to "border-subtle-color",
        "textPrimary" to "text-primary", "textSecondary" to "text-secondary", "textTertiary" to "text-tertiary",
        "accent" to "accent", "accentHover" to "accent-hover", "action" to "action", "actionHover" to "action-hover",
        "actionForeground" to "action-foreground", "sidebarItemText" to "sidebar-item-text",
        "sidebarIconColor" to "sidebar-icon-color", "selectedRing" to "selected-ring", "scrim" to "scrim-color",
        "gitWorktree" to "git-worktree",
    )
    private val sharedRoles = linkedMapOf(
        "destructive" to "color-destructive", "success" to "color-success", "warning" to "color-warning",
        "statusWorking" to "color-status-working", "statusReady" to "color-status-ready",
        "statusWaiting" to "color-status-waiting", "statusInactive" to "color-status-inactive",
        "switchKnob" to "color-switch-knob", "brandClaude" to "brand-claude", "gitModified" to "color-git-modified",
        "gitIncoming" to "color-git-incoming", "termCwd" to "color-term-cwd", "termModel" to "color-term-model",
        "termMode" to "color-term-mode",
    )

    private fun stylesheet(): File? = listOf("../../../packages/ui/src/tokens.css", "../../../../packages/ui/src/tokens.css")
        .map(::File)
        .firstOrNull { it.exists() }

    private data class Block(val selector: String, val body: String)

    private fun blocks(css: String): List<Block> =
        Regex("([^{}]+)\\{([^{}]*)\\}").findAll(css).map { Block(it.groupValues[1].trim(), it.groupValues[2]) }.toList()

    private fun declarations(body: String): Map<String, String> {
        val map = LinkedHashMap<String, String>()
        for (line in body.split(';')) {
            val i = line.indexOf(':')
            if (i < 0) continue
            val name = line.substring(0, i).trim()
            if (!name.startsWith("--")) continue
            map[name.substring(2)] = line.substring(i + 1).trim()
        }
        return map
    }

    private fun clamp01(x: Double) = x.coerceIn(0.0, 1.0)
    // JavaScript's Math.round rounds halves up; so does roundToInt.
    private fun to255(x: Double) = (clamp01(x) * 255).roundToInt()

    private fun oklchToRgb(lightness: Double, chroma: Double, hueDeg: Double): IntArray {
        val h = hueDeg * PI / 180
        val a = chroma * cos(h)
        val b = chroma * sin(h)
        val l_ = lightness + 0.3963377774 * a + 0.2158037573 * b
        val m_ = lightness - 0.1055613458 * a - 0.0638541728 * b
        val s_ = lightness - 0.0894841775 * a - 1.291485548 * b
        val l = l_ * l_ * l_
        val m = m_ * m_ * m_
        val s = s_ * s_ * s_
        val r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
        val g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
        val bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
        fun gamma(c: Double): Double {
            val v = clamp01(c)
            return if (v <= 0.0031308) 12.92 * v else 1.055 * v.pow(1 / 2.4) - 0.055
        }
        return intArrayOf(to255(gamma(r)), to255(gamma(g)), to255(gamma(bl)), 255)
    }

    /** A CSS colour literal as r, g, b, a255, with the script's exact rules. */
    private fun parseColor(value: String, name: String): IntArray {
        val v = value.trim()
        Regex("^#([0-9a-f]{6})$", RegexOption.IGNORE_CASE).find(v)?.let {
            val n = it.groupValues[1].toInt(16)
            return intArrayOf((n shr 16) and 255, (n shr 8) and 255, n and 255, 255)
        }
        Regex("^#([0-9a-f]{3})$", RegexOption.IGNORE_CASE).find(v)?.let {
            val d = it.groupValues[1].map { c -> "$c$c".toInt(16) }
            return intArrayOf(d[0], d[1], d[2], 255)
        }
        Regex("^rgba?\\(\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*,\\s*([\\d.]+)\\s*(?:,\\s*([\\d.]+)\\s*)?\\)$", RegexOption.IGNORE_CASE)
            .find(v)?.let {
                val g = it.groupValues
                val alpha = if (g[4].isEmpty()) 255 else to255(g[4].toDouble())
                return intArrayOf(g[1].toDouble().roundToInt(), g[2].toDouble().roundToInt(), g[3].toDouble().roundToInt(), alpha)
            }
        Regex("^rgba?\\(\\s*([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s*(?:/\\s*([\\d.]+%?)\\s*)?\\)$", RegexOption.IGNORE_CASE)
            .find(v)?.let {
                val g = it.groupValues
                val a = g[4]
                val alpha = when {
                    a.isEmpty() -> 1.0
                    a.endsWith("%") -> a.dropLast(1).toDouble() / 100
                    else -> a.toDouble()
                }
                return intArrayOf(g[1].toDouble().roundToInt(), g[2].toDouble().roundToInt(), g[3].toDouble().roundToInt(), to255(alpha))
            }
        Regex("^oklch\\(\\s*([\\d.]+%?)\\s+([\\d.]+)\\s+([\\d.]+)\\s*\\)$", RegexOption.IGNORE_CASE).find(v)?.let {
            val g = it.groupValues
            val l = if (g[1].endsWith("%")) g[1].dropLast(1).toDouble() / 100 else g[1].toDouble()
            return oklchToRgb(l, g[2].toDouble(), g[3].toDouble())
        }
        throw AssertionError("tokens.css: --$name is not a colour literal the phone can read: $v")
    }

    private fun argb(c: IntArray): Int = (c[3] shl 24) or (c[0] shl 16) or (c[1] shl 8) or c[2]

    private fun hex(argb: Int) = "0x%08X".format(argb)

    private fun assertColor(where: String, expected: IntArray, actual: Color) =
        assertEquals(where, hex(argb(expected)), hex(actual.toArgb()))

    /** A role of a generated data class by its name: a Color is stored as its packed long. */
    private fun role(target: Any, key: String): Color {
        val field = target.javaClass.getDeclaredField(key).apply { isAccessible = true }
        return Color(field.getLong(target).toULong())
    }

    @Test
    fun everyRoleMatchesTheStylesheet() {
        val file = stylesheet()
        assumeTrue("packages/ui/src/tokens.css is not reachable from the module", file != null)
        val css = file!!.readText().replace(Regex("/\\*[\\s\\S]*?\\*/"), "")
        val all = blocks(css)
        val shared = declarations(all.first { it.selector == "@theme" }.body)
        val themes = mapOf(
            "dark" to Tokens.dark, "light" to Tokens.light, "coffee" to Tokens.coffee, "charcoal" to Tokens.charcoal,
        )
        var checked = 0
        for ((theme, colors) in themes) {
            val block = all.first {
                if (theme == "dark") it.selector.contains(":root") && it.selector.contains("[data-theme=\"dark\"]")
                else it.selector == "[data-theme=\"$theme\"]"
            }
            val decls = declarations(block.body)
            for ((key, prop) in themeRoles) {
                val value = decls[prop] ?: throw AssertionError("the $theme theme has no --$prop")
                assertColor("$theme.$key", parseColor(value, prop), role(colors, key))
                checked++
            }
            val rgb = decls.getValue("rule-rgb").split(Regex("\\s+")).map { it.toDouble().roundToInt() }
            val alpha = to255(decls.getValue("rule-alpha").toDouble())
            assertColor("$theme.rule", intArrayOf(rgb[0], rgb[1], rgb[2], alpha), colors.rule)
            checked++
        }
        for ((key, prop) in sharedRoles) {
            val value = shared[prop] ?: throw AssertionError("@theme has no --$prop")
            assertColor("shared.$key", parseColor(value, prop), role(Tokens.shared, key))
            checked++
        }
        assertEquals(4 * (themeRoles.size + 1) + sharedRoles.size, checked)
        assertEquals(shared.getValue("font-weight-medium").toInt(), Tokens.FONT_WEIGHT_MEDIUM)
        assertEquals(400, Tokens.FONT_WEIGHT_MEDIUM)
    }

    @Test
    fun theTestCoversEveryGeneratedRole() {
        // A role added to the generator but not here would otherwise go unchecked.
        fun fields(type: Class<*>) = type.declaredFields
            .filter { !java.lang.reflect.Modifier.isStatic(it.modifiers) }
            .map { it.name }
            .toSet()
        assertEquals(themeRoles.keys + "rule", fields(ThemeColors::class.java))
        assertEquals(sharedRoles.keys, fields(SharedColors::class.java))
    }
}
