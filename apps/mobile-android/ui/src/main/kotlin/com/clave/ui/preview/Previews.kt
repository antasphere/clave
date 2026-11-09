package com.clave.ui.preview

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.tooling.preview.PreviewParameter
import androidx.compose.ui.tooling.preview.PreviewParameterProvider
import com.clave.ui.chat.ApprovalCard
import com.clave.ui.chat.AssistantProse
import com.clave.ui.chat.Composer
import com.clave.ui.chat.PromptDock
import com.clave.ui.chat.ProviderMark
import com.clave.ui.chat.ToolRow
import com.clave.ui.chat.ToolStatus
import com.clave.ui.chat.UserTurn
import com.clave.ui.screens.AppearanceScreen
import com.clave.ui.theme.Appearance
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveTheme
import com.clave.ui.theme.Metrics
import com.clave.ui.theme.ThemeName

/** The phone-sized canvas every design-system preview draws on; the theme comes from the parameter. */
@Preview(name = "Clave", showBackground = true, widthDp = Metrics.PREVIEW_WIDTH_DP, heightDp = Metrics.PREVIEW_HEIGHT_DP)
annotation class ThemePreviews

/** The four themes, so each preview renders once per theme. */
class ThemeNameProvider : PreviewParameterProvider<ThemeName> {
    override val values: Sequence<ThemeName> = ThemeName.entries.asSequence()
}

private fun appearanceOf(theme: ThemeName): Appearance = Appearance.of(theme.id)

@ThemePreviews
@Composable
private fun AppearanceScreenPreview(@PreviewParameter(ThemeNameProvider::class) theme: ThemeName) {
    ClaveTheme(theme) {
        AppearanceScreen(appearance = appearanceOf(theme), onAppearance = {}, onBack = {})
    }
}

@ThemePreviews
@Composable
private fun ChatPrimitivesPreview(@PreviewParameter(ThemeNameProvider::class) theme: ThemeName) {
    ClaveTheme(theme) {
        Column(
            Modifier
                .fillMaxWidth()
                .background(Clave.colors.theme.surface0)
                .padding(Metrics.gutter),
            verticalArrangement = Arrangement.spacedBy(Metrics.space(3)),
        ) {
            UserTurn("Run the tests and fix what fails.", attachmentLabels = listOf("failing-test.log"))
            ProviderMark("claude")
            AssistantProse(
                "Two failures, both in `parser.kt`:\n\n- the empty table\n- a trailing link\n\n| Test | Result |\n|:--|--:|\n| tables | failed |\n| links | failed |",
                streaming = true,
            )
            ToolRow("Ran", "./gradlew test", ToolStatus.Running, expanded = false, onToggle = {}, kind = "command")
            ToolRow(
                "Read",
                "parser.kt",
                ToolStatus.Failed,
                expanded = true,
                onToggle = {},
                failures = 1,
                kind = "read",
                sections = listOf("Output" to "File not found: parser.kt"),
            )
            ApprovalCard(
                title = "Allow Claude to run a command?",
                target = "./gradlew test",
                options = listOf("deny" to "Deny", "allow" to "Allow", "allow_always" to "Always allow"),
                onAnswer = { _, _ -> },
            )
            PromptDock(count = 2, label = "Claude is waiting for your approval", onOpen = {})
            Composer(
                text = "",
                onTextChange = {},
                onSend = {},
                onStop = {},
                onAttach = {},
                working = true,
                attachments = listOf("screenshot.png"),
                deliveryMark = "Delivered to the desktop",
            )
        }
    }
}
