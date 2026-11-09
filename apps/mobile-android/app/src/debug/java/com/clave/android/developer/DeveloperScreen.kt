package com.clave.android.developer

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import com.clave.android.AppServices
import com.clave.android.ui.ClaveViewModel
import com.clave.ui.components.ButtonKind
import com.clave.ui.components.ClaveButton
import com.clave.ui.components.ClaveTextField
import com.clave.ui.components.Notice
import com.clave.ui.components.NoticeKind
import com.clave.ui.components.PaneHeader
import com.clave.ui.components.ScreenScaffold
import com.clave.ui.components.SectionLabel
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveTypography
import com.clave.ui.theme.Metrics
import kotlinx.coroutines.launch

/**
 * The developer's connection, development builds only: a standalone Clave server on this
 * network by its address and token (what the server prints at start), and the sign-in issuer
 * a local test provider stands in for. Saving the issuer rebuilds the sign-in on it; the
 * core's issuer rule decides what is accepted and its refusal is said here.
 */
@Composable
fun DeveloperScreen(services: AppServices, viewModel: ClaveViewModel, onBack: () -> Unit) {
    val t = Clave.colors.theme
    val label = ClaveTypography.type(Metrics.textXs).copy(color = t.textSecondary)
    val caption = ClaveTypography.type(Metrics.textXs, lineHeight = Metrics.proseLineHeight).copy(color = t.textTertiary)
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    var name by remember { mutableStateOf("Developer machine") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var issuer by remember { mutableStateOf("") }
    var issuerNote by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { issuer = DevelopmentIssuer.read(services.kv).orEmpty() }
    ScreenScaffold(
        header = { PaneHeader(title = "Developer connection", subtitle = "Development builds only", onBack = onBack) },
    ) { padding ->
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(padding)
                .padding(vertical = Metrics.space(4)),
            verticalArrangement = Arrangement.spacedBy(Metrics.space(6)),
        ) {
            Column(
                Modifier.fillMaxWidth().padding(horizontal = Metrics.gutter),
                verticalArrangement = Arrangement.spacedBy(Metrics.space(2)),
            ) {
                BasicText("Server address", style = label)
                ClaveTextField(
                    value = url,
                    onValueChange = { url = it },
                    placeholder = "http://127.0.0.1:47201",
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                    modifier = Modifier.fillMaxWidth(),
                )
                BasicText("Server token", style = label)
                // A plain field, not a masked one: the token is the developer's own local server's,
                // and an automated check types into it; this screen exists in development builds only.
                ClaveTextField(value = token, onValueChange = { token = it }, modifier = Modifier.fillMaxWidth())
                BasicText("Name", style = label)
                ClaveTextField(value = name, onValueChange = { name = it }, modifier = Modifier.fillMaxWidth())
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    ClaveButton(
                        label = if (busy) "Connecting…" else "Connect",
                        kind = ButtonKind.Primary,
                        enabled = !busy && url.isNotBlank() && token.isNotBlank(),
                        onClick = {
                            busy = true
                            error = null
                            viewModel.addDeveloperMachine(
                                url = url,
                                token = token.trim(),
                                name = name.trim().ifEmpty { "Developer machine" },
                                onDone = {
                                    busy = false
                                    onBack()
                                },
                                onError = {
                                    busy = false
                                    error = it
                                },
                            )
                        },
                    )
                }
                error?.let { Notice(it, kind = NoticeKind.Destructive) }
            }
            Column {
                SectionLabel("Sign-in issuer (test provider)")
                Column(
                    Modifier.fillMaxWidth().padding(horizontal = Metrics.gutter),
                    verticalArrangement = Arrangement.spacedBy(Metrics.space(2)),
                ) {
                    ClaveTextField(
                        value = issuer,
                        onValueChange = {
                            issuer = it
                            issuerNote = null
                        },
                        placeholder = "http://127.0.0.1:47203",
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                        modifier = Modifier.fillMaxWidth(),
                    )
                    BasicText("Blank is the Antasphere hub. Only https, or http to 127.0.0.1, is accepted.", style = caption)
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                        ClaveButton(
                            label = if (saving) "Saving…" else "Save",
                            kind = ButtonKind.Secondary,
                            enabled = !saving,
                            onClick = {
                                val refusal = DevelopmentIssuer.refusal(issuer)
                                issuerNote = refusal
                                if (refusal == null) {
                                    saving = true
                                    scope.launch {
                                        try {
                                            DevelopmentIssuer.write(services.kv, issuer)
                                            services.rebuildAuth()
                                        } finally {
                                            saving = false
                                        }
                                    }
                                }
                            },
                        )
                    }
                    issuerNote?.let { Notice(it, kind = NoticeKind.Destructive) }
                }
            }
        }
    }
}
