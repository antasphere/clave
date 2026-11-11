package com.clave.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import com.clave.core.devices.PairingState
import com.clave.ui.components.ButtonKind
import com.clave.ui.components.ClaveButton
import com.clave.ui.components.Notice
import com.clave.ui.components.NoticeKind
import com.clave.ui.components.PaneHeader
import com.clave.ui.components.ScreenScaffold
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveTypography
import com.clave.ui.theme.Metrics

/** What is left of a pairing's window, as "m:ss", never below zero. */
internal fun expiresIn(expiresAt: Long, now: Long): String {
    val seconds = maxOf(0L, expiresAt - now) / 1000
    return "%d:%02d".format(seconds / 60, seconds % 60)
}

/**
 * The pairing, one state at a time in words: asking, waiting for the owner to approve on
 * the Mac (with the time left), approved, refused, lapsed, cancelled, or failed in the
 * enrollment's own sentence. Nothing is retried on its own: a settled state that is not an
 * approval offers "Try again", and the wait can be cancelled.
 */
@Composable
fun PairingScreen(
    machineName: String,
    state: PairingState?,
    now: Long,
    onCancel: () -> Unit,
    onRetry: () -> Unit,
    onDone: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val t = Clave.colors.theme
    val body = ClaveTypography.type(Metrics.textSm, lineHeight = Metrics.proseLineHeight).copy(color = t.textPrimary)
    val caption = ClaveTypography.type(Metrics.textXs, lineHeight = Metrics.proseLineHeight).copy(color = t.textTertiary)
    ScreenScaffold(
        modifier = modifier,
        header = { PaneHeader(title = "Pair with $machineName", onBack = onBack) },
    ) { padding ->
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(padding)
                .padding(horizontal = Metrics.gutter, vertical = Metrics.space(6))
                .semantics { liveRegion = LiveRegionMode.Polite },
            verticalArrangement = Arrangement.spacedBy(Metrics.space(3)),
        ) {
            when (state) {
                null, PairingState.Requesting -> {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Metrics.space(2))) {
                        SmallSpinner()
                        BasicText("Asking $machineName to pair…", style = body)
                    }
                }
                is PairingState.Waiting -> {
                    BasicText(
                        "Waiting for your approval. On $machineName, open Settings → Mobile and approve this phone.",
                        style = body,
                    )
                    BasicText("Expires in ${expiresIn(state.expiresAt, now)}", style = caption)
                }
                is PairingState.Approved -> {
                    BasicText("Paired with ${state.record.serverName}.", style = body)
                    ClaveButton("Open workspaces", onClick = onDone, kind = ButtonKind.Primary)
                }
                PairingState.Refused -> BasicText("$machineName refused this phone.", style = body)
                PairingState.Expired -> BasicText("The request expired before it was approved.", style = body)
                PairingState.Cancelled -> BasicText("Cancelled.", style = body)
                is PairingState.Failed -> {
                    Notice(state.message, kind = NoticeKind.Destructive)
                    if (state.check != null) BasicText("Check: ${state.check}", style = caption)
                }
            }
            when (state) {
                null, PairingState.Requesting, is PairingState.Waiting ->
                    ClaveButton("Cancel", onClick = onCancel, kind = ButtonKind.Secondary)
                PairingState.Refused, PairingState.Expired, PairingState.Cancelled, is PairingState.Failed ->
                    ClaveButton("Try again", onClick = onRetry, kind = ButtonKind.Primary)
                is PairingState.Approved -> Unit
            }
        }
    }
}
