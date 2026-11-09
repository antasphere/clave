package com.clave.ui.screens

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import com.clave.core.contract.LaunchProfileView
import com.clave.ui.chat.ProviderMark
import com.clave.ui.components.Badge
import com.clave.ui.components.EmptyState
import com.clave.ui.components.ListRow
import com.clave.ui.components.Notice
import com.clave.ui.components.NoticeKind
import com.clave.ui.components.PaneHeader
import com.clave.ui.components.ScreenScaffold
import com.clave.ui.components.SectionLabel
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveIcon
import com.clave.ui.theme.ClaveTypography
import com.clave.ui.theme.Metrics

/**
 * The launch form: the saved profiles of the source machine (the main one, decision 7) run
 * on the target. [starting] is the id of the profile being started, [refusal] the server's
 * own sentence when it would not start one.
 */
@Immutable
data class LaunchScreenState(
    val workspaceName: String?,
    val targetName: String?,
    val sourceName: String?,
    val profiles: List<LaunchProfileView>?,
    val error: String?,
    val starting: String?,
    val refusal: String?,
)

/** Where the profiles run and whose they are, the line under "Saved profiles". */
internal fun launchCaption(targetName: String?, sourceName: String?): String {
    val whose = if (sourceName != null && sourceName != targetName) "profiles of $sourceName" else "its own saved profiles"
    return listOfNotNull(targetName?.let { "Runs on $it" }, whose).joinToString(" · ")
}

/**
 * Start a session from a saved profile. One start at a time: while a profile starts, every
 * row is dimmed and takes no tap, and the starting one shows a spinner. A refusal is shown
 * in the server's words, never rephrased.
 */
@Composable
fun LaunchScreen(
    state: LaunchScreenState,
    onStart: (LaunchProfileView) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val t = Clave.colors.theme
    ScreenScaffold(
        modifier = modifier,
        header = {
            PaneHeader(
                title = "Start a session",
                subtitle = state.workspaceName?.let { "in $it" },
                onBack = onBack,
            )
        },
    ) { padding ->
        Column(
            Modifier
                .verticalScroll(rememberScrollState())
                .padding(padding)
                .padding(vertical = Metrics.space(4)),
        ) {
            if (state.refusal != null) {
                Notice(
                    state.refusal,
                    kind = NoticeKind.Destructive,
                    modifier = Modifier.padding(horizontal = Metrics.gutter).padding(bottom = Metrics.space(3)),
                )
            }
            SectionLabel("Saved profiles")
            BasicText(
                launchCaption(state.targetName, state.sourceName),
                modifier = Modifier.padding(horizontal = Metrics.gutter).padding(bottom = Metrics.space(2)),
                style = ClaveTypography.type(Metrics.textXs, lineHeight = Metrics.proseLineHeight).copy(color = t.textTertiary),
            )
            val profiles = state.profiles
            val busy = state.starting != null
            when {
                !profiles.isNullOrEmpty() -> profiles.forEach { p ->
                    val chat = isChatProfile(p)
                    ListRow(
                        title = p.name,
                        subtitle = "${p.family.wire} · ${if (chat) "chat" else "terminal"} · ${p.command.joinToString(" ")}",
                        modifier = if (busy) Modifier.alpha(Metrics.disabledAlpha) else Modifier,
                        leading = { ProviderMark(p.family.wire, size = Metrics.controlIcon) },
                        trailing = when {
                            state.starting == p.id -> ({ SmallSpinner() })
                            chat -> ({ Badge("Chat") })
                            else -> null
                        },
                        onClick = if (busy) null else ({ onStart(p) }),
                    )
                }
                state.error != null -> Notice(
                    state.error,
                    kind = NoticeKind.Destructive,
                    modifier = Modifier.padding(horizontal = Metrics.gutter),
                )
                profiles == null -> Loading()
                else -> EmptyState(
                    ClaveIcon.BookOpen,
                    "No saved profile",
                    text = "Save one on ${state.sourceName ?: "the main machine"}, in Settings → Agents.",
                )
            }
        }
    }
}
