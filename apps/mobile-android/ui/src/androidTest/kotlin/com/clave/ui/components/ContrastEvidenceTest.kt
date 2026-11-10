package com.clave.ui.components

import android.graphics.Bitmap
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.clave.ui.screens.writeEvidenceDir
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveTheme
import com.clave.ui.theme.Reachability
import com.clave.ui.theme.SessionStatus
import com.clave.ui.theme.ThemeName
import com.clave.ui.theme.Tokens
import java.io.File
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The small words that say a state or a danger, measured on the device as drawn: in each theme,
 * every status and reachability word alone, and the destructive notice. The background is a
 * capture's most frequent colour, the ink the pixel farthest from it in luminance (a glyph's
 * stem, fully covered at this density); 12 sp is normal text, so 4.5:1 or more.
 */
@RunWith(AndroidJUnit4::class)
class ContrastEvidenceTest {
    @get:Rule
    val rule = createComposeRule()

    private fun lum(argb: Int): Double = Color(argb).luminance().toDouble()

    private fun drawnContrast(bitmap: Bitmap): Double {
        val pixels = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        val ground = pixels.toList().groupingBy { it }.eachCount().maxByOrNull { it.value }!!.key
        val lg = lum(ground)
        return pixels.maxOf { (max(lum(it), lg) + 0.05) / (min(lum(it), lg) + 0.05) }
    }

    @Test
    fun everyStatusWordAndTheDestructiveNoticeReadAtFourPointFiveOnTheDevice() {
        var theme by mutableStateOf(ThemeName.Dark)
        var word by mutableStateOf(SessionStatus.Waiting.label)
        rule.setContent {
            ClaveTheme(theme) {
                Column(Modifier.background(Clave.colors.theme.surface0).padding(12.dp)) {
                    Box(Modifier.testTag("word").padding(6.dp)) { StatusWord(word) }
                    Notice("The machine refused the request.", Modifier.testTag("notice"), kind = NoticeKind.Destructive)
                }
            }
        }
        val words = SessionStatus.entries.map { it.label } + Reachability.entries.map { it.label }
        val notes = StringBuilder()
        val under = mutableListOf<String>()
        for (name in ThemeName.entries) {
            theme = name
            for (label in words) {
                word = label
                rule.waitForIdle()
                val ratio = drawnContrast(rule.onNodeWithTag("word").captureToImage().asAndroidBitmap())
                notes.appendLine("$name status word \"$label\": %.2f:1".format(ratio))
                if (ratio < 4.5) under += "$name \"$label\" %.2f:1".format(ratio)
            }
            val notice = drawnContrast(rule.onNodeWithTag("notice").captureToImage().asAndroidBitmap())
            notes.appendLine("$name destructive notice text: %.2f:1".format(notice))
            if (notice < 4.5) under += "$name destructive notice %.2f:1".format(notice)
        }
        File(writeEvidenceDir(), "contrast.txt").writeText(notes.toString())
        assertTrue("words under 4.5:1 as drawn: $under", under.isEmpty())
    }

    /**
     * The destructive button as drawn, on its resting ground (surface0) and its pressed fill
     * (surface100), in each theme: its label, read with the red cue's pixels set aside, at 4.5:1 or
     * more; the warning triangle in the destructive hue present beside it.
     */
    @Test
    fun theDestructiveButtonLabelReadsAndItsRedCueStaysOnTheDevice() {
        var theme by mutableStateOf(ThemeName.Dark)
        var pressedGround by mutableStateOf(false)
        rule.setContent {
            ClaveTheme(theme) {
                val t = Clave.colors.theme
                Box(Modifier.background(if (pressedGround) t.surface100 else t.surface0).padding(12.dp).testTag("button")) {
                    ClaveButton("Forget this machine", onClick = {}, kind = ButtonKind.Destructive)
                }
            }
        }
        val red = Tokens.shared.destructive.toArgb()
        fun nearRed(p: Int) = abs(((p shr 16) and 255) - ((red shr 16) and 255)) + abs(((p shr 8) and 255) - ((red shr 8) and 255)) + abs((p and 255) - (red and 255)) <= 24
        val notes = StringBuilder()
        val under = mutableListOf<String>()
        for (name in ThemeName.entries) {
            for (pressedFill in listOf(false, true)) {
                theme = name
                pressedGround = pressedFill
                rule.waitForIdle()
                val bitmap = rule.onNodeWithTag("button").captureToImage().asAndroidBitmap()
                val pixels = IntArray(bitmap.width * bitmap.height)
                bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
                val ground = pixels.toList().groupingBy { it }.eachCount().maxByOrNull { it.value }!!.key
                val lg = lum(ground)
                val label = pixels.filterNot(::nearRed).maxOf { (max(lum(it), lg) + 0.05) / (min(lum(it), lg) + 0.05) }
                val cue = pixels.count(::nearRed)
                val where = if (pressedFill) "pressed fill" else "resting ground"
                notes.appendLine("$name destructive button on its $where: label %.2f:1, red cue pixels %d".format(label, cue))
                if (label < 4.5) under += "$name $where label %.2f:1".format(label)
                if (cue < 20) under += "$name $where red cue missing ($cue pixels)"
            }
        }
        File(writeEvidenceDir(), "contrast-button.txt").writeText(notes.toString())
        assertTrue("the destructive button as drawn: $under", under.isEmpty())
    }
}
