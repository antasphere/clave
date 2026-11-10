package com.clave.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicText
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.clave.ui.components.StatusWord
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveTypography
import com.clave.ui.theme.Metrics
import com.clave.ui.theme.Reachability

/**
 * The few pieces every screen repeats, so a list waiting for its first answer and the
 * machine's reachability read the same on each.
 */

/** A list still waiting for its first answer: the spinner in the accent, centred. */
@Composable
internal fun Loading(modifier: Modifier = Modifier) {
    Box(
        modifier
            .fillMaxWidth()
            .padding(vertical = Metrics.space(8))
            .semantics { contentDescription = "Loading" },
        contentAlignment = Alignment.Center,
    ) {
        CircularProgressIndicator(color = Clave.colors.theme.accent)
    }
}

/** A spinner at a row's glyph size, for one item at work inside a list. */
@Composable
internal fun SmallSpinner(modifier: Modifier = Modifier) {
    CircularProgressIndicator(
        modifier = modifier.size(Metrics.controlSmIcon),
        color = Clave.colors.theme.accent,
        strokeWidth = Metrics.focusRing,
    )
}

/** "Machine" and whether it answers: apart from any session's state, never folded in. */
@Composable
internal fun MachineReachabilityRow(reachability: Reachability, modifier: Modifier = Modifier) {
    Row(
        modifier.padding(horizontal = Metrics.gutter, vertical = Metrics.space(2)),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Metrics.space(2)),
    ) {
        BasicText("Machine", style = ClaveTypography.type(Metrics.textXs).copy(color = Clave.colors.theme.textTertiary))
        StatusWord(reachability)
    }
}
