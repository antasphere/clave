package com.clave.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.clave.ui.R

/** Appearance → Theme on the desktop; on the phone the system's scheme may decide. */
enum class Appearance(val id: String, val label: String) {
    System("system", "Match the system"),
    Dark("dark", "Dark"),
    Light("light", "Light"),
    Coffee("coffee", "Coffee"),
    Charcoal("charcoal", "Charcoal");

    companion object {
        /** A stored value read back; anything unknown falls back to the system, never a crash. */
        fun of(id: String?): Appearance = entries.firstOrNull { it.id == id } ?: System
    }
}

/** The key the preference is stored under, the same as the prototype's so a migration reads it. */
const val APPEARANCE_KEY = "clave.appearance"

/** The theme an appearance resolves to: "Match the system" is dark unless the system is light. */
fun themeFor(appearance: Appearance, systemDark: Boolean): ThemeName = when (appearance) {
    Appearance.System -> if (systemDark) ThemeName.Dark else ThemeName.Light
    Appearance.Dark -> ThemeName.Dark
    Appearance.Light -> ThemeName.Light
    Appearance.Coffee -> ThemeName.Coffee
    Appearance.Charcoal -> ThemeName.Charcoal
}

/** A colour at another alpha: the desktop's color-mix toward transparent. */
fun Color.withAlpha(alpha: Float): Color = copy(alpha = alpha)

/** One theme's roles, the shared inks, and what the phone derives from them. */
@Immutable
data class ClaveColors(
    val theme: ThemeColors,
    val shared: SharedColors,
    /** The hairline edge of a raised control (`--raised-control-shadow`'s ring). */
    val edge: Color,
    /** A dark ground (dark, charcoal): the status bar's text goes light. */
    val isDark: Boolean,
)

private const val EDGE_ALPHA = 0.16f

/** Whether a theme is drawn on a dark ground. */
fun ThemeName.isDark(): Boolean = this == ThemeName.Dark || this == ThemeName.Charcoal

/** The colours of a theme, without Compose: the swatches and the tests build them directly. */
fun claveColorsFor(name: ThemeName): ClaveColors {
    val dark = name.isDark()
    return ClaveColors(
        theme = Tokens.colors(name),
        shared = Tokens.shared,
        edge = (if (dark) Color.White else Color.Black).withAlpha(EDGE_ALPHA),
        isDark = dark,
    )
}

/**
 * The desktop's control spec (28 : 8 : 6 : 13 : 6) scaled once for a thumb, and every
 * other number the screens use, so no component carries a literal size.
 */
object Metrics {
    // The control: 36 tall, 10 sides, 6 icon gap, 13 label, 8 corner, a 16 glyph.
    val controlHeight = 36.dp
    val controlPadding = 10.dp
    val controlGap = 6.dp
    val controlText = 13.sp
    val controlRadius = 8.dp
    val controlIcon = 16.dp

    // One size down, as a control inside a frame on the desktop.
    val controlSmHeight = 32.dp
    val controlSmPadding = 8.dp
    val controlSmText = 12.sp
    val controlSmRadius = 7.dp
    val controlSmIcon = 14.dp

    // A row-level affordance (the desktop's 20px box).
    val controlXsHeight = 28.dp
    val controlXsIcon = 14.dp

    // `.input-field`: the desktop's 32px field, a touch step taller.
    val fieldHeight = 40.dp
    val fieldPadding = 12.dp
    val fieldRadius = 8.dp
    val fieldText = 14.sp

    // The corners.
    val radiusSm = 3.dp
    val radiusMd = 4.dp
    val radiusControl = 8.dp
    val radiusLg = 8.dp
    val radiusXl = 13.dp
    val radiusXxl = 16.dp

    /** `--spacing`, 4dp. */
    fun space(n: Float): Dp = (4f * n).dp
    fun space(n: Int): Dp = space(n.toFloat())

    /** The page's horizontal gutter: the column padding the desktop gives a pane's content. */
    val gutter = 16.dp

    // The type scale the desktop's classes use.
    val textXs = 12.sp
    val textSm = 14.sp
    val textBase = 16.sp
    val textLg = 18.sp
    val textControl = 13.sp
    val textMeta = 11.sp
    val textBadge = 10.sp

    /** The chat view's code size: text-sm less a quarter spacing. */
    val codeSize = 13.sp
    /** The chat's glyph: 3.5 spacings. */
    val chatGlyph = 14.dp

    // Line heights, as ratios of the size the way the stylesheet writes them.
    const val proseLineHeight = 1.5f
    const val headingLineHeight = 1.35f
    const val userTurnLineHeight = 1.6f

    // Lines and rings.
    val hairline = 1.dp
    val focusRing = 1.5.dp
    val quoteBar = 2.dp
    val labelTracking = 0.4.sp

    // The pane header and the rows.
    val paneHeaderHeight = 44.dp
    val rowMinHeight = 36.dp
    val statusDot = 6.dp

    // Markdown.
    val listMarkerWidth = 16.dp
    val codePadding = 12.dp
    val tableCellPadding = 8.dp
    val tableCellMaxWidth = 240.dp
    val imageMaxHeight = 320.dp
    val imagePlaceholderHeight = 120.dp

    // Chat.
    val userTurnInset = 48.dp
    val userTurnPaddingX = 14.dp
    val userTurnPaddingY = 10.dp
    val providerMark = 14.dp
    val sendButton = 32.dp
    val composerMinLines = 1
    val composerMaxLines = 6

    // The empty state's tile.
    val emptyTile = 48.dp
    val emptyIcon = 22.dp

    // The switch: a track one control-xs tall, the knob inset by two.
    val switchWidth = 44.dp
    val switchHeight = 26.dp
    val switchKnobInset = 3.dp

    // The appearance swatch.
    val swatchWidth = 44.dp
    val swatchHeight = 32.dp
    val swatchChrome = 8.dp
    val swatchLine = 2.dp
    val swatchLineWidth = 18.dp
    val swatchDot = 6.dp

    // Shadows: the desktop's raised and overlay drops.
    val raisedShadowRadius = 6.dp
    val raisedShadowOffset = 2.dp
    val overlayShadowRadius = 8.dp
    val overlayShadowOffset = 3.dp

    // Opacities and timings.
    const val disabledAlpha = 0.4f
    const val activeWashAlpha = 0.12f
    const val pulseLowAlpha = 0.4f
    const val restingChevronAlpha = 0.6f
    const val pulseMillis = 1250
    const val spinMillis = 1000
    const val pressMillis = 120

    /** The preview canvas, a phone's width (annotation arguments must be constants). */
    const val PREVIEW_WIDTH_DP = 360
    const val PREVIEW_HEIGHT_DP = 800
}

/** One drop: the ink, how much of it, how far it spreads and falls. */
@Immutable
data class ShadowSpec(val color: Color, val alpha: Float, val radius: Dp, val offsetY: Dp)

/** `--raised-shadow` (the composer, the prompt dock) and `--overlay-shadow` (a floating control). */
@Immutable
data class ClaveShadows(val raised: ShadowSpec, val overlay: ShadowSpec)

private data class ShadowInk(val color: Color, val raised: Float, val overlay: Float)

/** Each theme's shadow ink and opacities, the prototype's `SHADOW_INK`. */
private val SHADOW_INK: Map<ThemeName, ShadowInk> = mapOf(
    ThemeName.Dark to ShadowInk(Color(0xFF000000), 0.3f, 0.24f),
    ThemeName.Light to ShadowInk(Color(0xFF000000), 0.05f, 0.07f),
    ThemeName.Coffee to ShadowInk(Color(0xFF3C2D1E), 0.06f, 0.08f),
    ThemeName.Charcoal to ShadowInk(Color(0xFF090604), 0.34f, 0.34f),
)

fun claveShadowsFor(name: ThemeName): ClaveShadows {
    val ink = SHADOW_INK.getValue(name)
    return ClaveShadows(
        raised = ShadowSpec(ink.color, ink.raised, Metrics.raisedShadowRadius, Metrics.raisedShadowOffset),
        overlay = ShadowSpec(ink.color, ink.overlay, Metrics.overlayShadowRadius, Metrics.overlayShadowOffset),
    )
}

/** Draws a drop behind the element in the given shape. */
fun Modifier.shadow(spec: ShadowSpec, shape: Shape): Modifier = dropShadow(
    shape = shape,
    shadow = Shadow(
        radius = spec.radius,
        color = spec.color,
        offset = DpOffset(0.dp, spec.offsetY),
        alpha = spec.alpha,
    ),
)

/** Geist Sans at the three weights the desktop loads; the desktop's `font-medium` is 400. */
object ClaveTypography {
    val geist = FontFamily(
        Font(R.font.geist_regular, FontWeight.Normal),
        Font(R.font.geist_medium, FontWeight.Medium),
        Font(R.font.geist_semibold, FontWeight.SemiBold),
    )
    val mono: FontFamily = FontFamily.Monospace

    /** The desktop's `font-medium`, which resolves to 400 there and here. */
    val desktopMedium = FontWeight(Tokens.FONT_WEIGHT_MEDIUM)

    /** A text style in Geist: the size, the weight and the line height as a ratio. */
    fun type(
        size: TextUnit,
        weight: FontWeight = FontWeight.Normal, // the desktop's medium is 400
        lineHeight: Float? = null,
    ): TextStyle = TextStyle(
        fontFamily = geist,
        fontWeight = weight,
        fontSize = size,
        lineHeight = if (lineHeight == null) TextUnit.Unspecified else size * lineHeight,
    )

    fun mono(size: TextUnit, lineHeight: Float = Metrics.proseLineHeight): TextStyle =
        TextStyle(fontFamily = mono, fontSize = size, lineHeight = size * lineHeight)
}

val LocalClaveColors = staticCompositionLocalOf { claveColorsFor(ThemeName.Dark) }
val LocalClaveShadows = staticCompositionLocalOf { claveShadowsFor(ThemeName.Dark) }
val LocalThemeName = staticCompositionLocalOf { ThemeName.Dark }

/** The theme the composition wears, read from anywhere below [ClaveTheme]. */
object Clave {
    val colors: ClaveColors
        @Composable get() = LocalClaveColors.current
    val shadows: ClaveShadows
        @Composable get() = LocalClaveShadows.current
    val themeName: ThemeName
        @Composable get() = LocalThemeName.current
    val metrics: Metrics get() = Metrics
    val typography: ClaveTypography get() = ClaveTypography
}

/** Material's roles from the tokens, so the few Material widgets used inherit the theme. */
private fun colorSchemeOf(c: ClaveColors): ColorScheme {
    val t = c.theme
    val s = c.shared
    val base = if (c.isDark) darkColorScheme() else lightColorScheme()
    return base.copy(
        primary = t.accent,
        onPrimary = s.switchKnob,
        primaryContainer = t.surface100,
        onPrimaryContainer = t.textPrimary,
        secondary = t.action,
        onSecondary = t.actionForeground,
        secondaryContainer = t.surface200,
        onSecondaryContainer = t.textPrimary,
        tertiary = t.accent,
        onTertiary = s.switchKnob,
        background = t.surface0,
        onBackground = t.textPrimary,
        surface = t.surface50,
        onSurface = t.textPrimary,
        surfaceVariant = t.surface100,
        onSurfaceVariant = t.textSecondary,
        surfaceTint = t.surface50,
        surfaceBright = t.surfaceRaised,
        surfaceDim = t.surface0,
        surfaceContainerLowest = t.surface0,
        surfaceContainerLow = t.surface50,
        surfaceContainer = t.surface100,
        surfaceContainerHigh = t.surface200,
        surfaceContainerHighest = t.surface300,
        inverseSurface = t.action,
        inverseOnSurface = t.actionForeground,
        inversePrimary = t.accentHover,
        error = s.destructive,
        onError = s.switchKnob,
        errorContainer = t.surface100,
        onErrorContainer = s.destructive,
        outline = t.border,
        outlineVariant = t.borderSubtle,
        scrim = t.scrim,
    )
}

/** Material's type scale, every style moved onto Geist. */
private val materialTypography: Typography = Typography().let { m ->
    fun TextStyle.geist() = copy(fontFamily = ClaveTypography.geist)
    Typography(
        displayLarge = m.displayLarge.geist(), displayMedium = m.displayMedium.geist(),
        displaySmall = m.displaySmall.geist(), headlineLarge = m.headlineLarge.geist(),
        headlineMedium = m.headlineMedium.geist(), headlineSmall = m.headlineSmall.geist(),
        titleLarge = m.titleLarge.geist(), titleMedium = m.titleMedium.geist(),
        titleSmall = m.titleSmall.geist(), bodyLarge = m.bodyLarge.geist(),
        bodyMedium = m.bodyMedium.geist(), bodySmall = m.bodySmall.geist(),
        labelLarge = m.labelLarge.geist(), labelMedium = m.labelMedium.geist(),
        labelSmall = m.labelSmall.geist(),
    )
}

/** The appearance under the system's scheme, provided to everything below. */
@Composable
fun ClaveTheme(appearance: Appearance, content: @Composable () -> Unit) {
    ClaveTheme(theme = themeFor(appearance, isSystemInDarkTheme()), content = content)
}

/** One named theme: the previews and the appearance swatches paint a theme other than the app's. */
@Composable
fun ClaveTheme(theme: ThemeName, content: @Composable () -> Unit) {
    val colors = remember(theme) { claveColorsFor(theme) }
    val shadows = remember(theme) { claveShadowsFor(theme) }
    val scheme = remember(theme) { colorSchemeOf(colors) }
    CompositionLocalProvider(
        LocalClaveColors provides colors,
        LocalClaveShadows provides shadows,
        LocalThemeName provides theme,
    ) {
        MaterialTheme(colorScheme = scheme, typography = materialTypography, content = content)
    }
}
