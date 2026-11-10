package com.clave.ui.screens

import android.graphics.Bitmap
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.test.platform.app.InstrumentationRegistry
import com.clave.ui.theme.Appearance
import com.clave.ui.theme.ClaveTheme
import com.clave.ui.theme.ThemeName
import java.io.File

/** The eight screens the evidence paints, in the order a person meets them. */
enum class Screen { Machines, Pairing, Workspaces, Sessions, Launch, Requests, Chat, Appearance }

/** The title each screen's pane header carries with the samples. */
fun Screen.title(): String = when (this) {
    Screen.Machines -> "Machines"
    Screen.Pairing -> "Pair with Studio"
    Screen.Workspaces -> "Studio"
    Screen.Sessions -> Samples.sessions().workspaceName!!
    Screen.Launch -> "Start a session"
    Screen.Requests -> "Requests"
    Screen.Chat -> Samples.chat().title
    Screen.Appearance -> "Appearance"
}

/**
 * One screen with the samples, in one named theme, at one font scale; every callback a no-op
 * but the chat's [onLink], which a test passes to see which URL a link opened.
 */
@Composable
fun EvidenceScreen(
    which: Screen,
    theme: ThemeName,
    fontScale: Float,
    onLink: (String) -> Unit = {},
    chatReply: String = Samples.reply,
) {
    ClaveTheme(theme) {
        if (fontScale != 1f) {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale)) {
                Painted(which, theme, onLink, chatReply)
            }
        } else {
            Painted(which, theme, onLink, chatReply)
        }
    }
}

/** The appearance a person picked to see [theme]: the Appearance screen shows it selected. */
fun appearanceOf(theme: ThemeName): Appearance = Appearance.entries.single { it.id == theme.id }

@Composable
private fun Painted(which: Screen, theme: ThemeName, onLink: (String) -> Unit, chatReply: String) {
    when (which) {
        Screen.Machines -> MachinesScreen(
            state = Samples.machines(),
            onSignIn = {}, onSignOut = {}, onRelayUrlChange = {}, onConnectRelay = {}, onRefresh = {},
            onOpen = {}, onPair = {}, onMakeMain = {}, onForget = null, onAppearance = {},
        )
        Screen.Pairing -> PairingScreen(
            machineName = "Studio", state = Samples.pairing(), now = Samples.now,
            onCancel = {}, onRetry = {}, onDone = {}, onBack = {},
        )
        Screen.Workspaces -> WorkspacesScreen(Samples.workspaces(), onOpen = {}, onRequests = {}, onRefresh = {}, onBack = {})
        Screen.Sessions -> SessionsScreen(Samples.sessions(), onOpen = {}, onLaunch = {}, onRefresh = {}, onBack = {})
        Screen.Launch -> LaunchScreen(Samples.launch(), onStart = {}, onBack = {})
        Screen.Requests -> RequestsScreen(Samples.requests(), onResolve = { _, _ -> }, onRefresh = {}, onBack = {})
        Screen.Chat -> ChatScreen(
            state = Samples.chat(chatReply),
            onBack = {}, onRequests = {}, onLoadOlder = {}, onTextChange = {},
            onSend = {}, onStop = {}, onPickPhotos = {}, onTakePhoto = {}, onPickDocuments = {},
            onRemoveAttachment = {}, onAnswer = { _, _, _ -> }, onToggle = {},
            onResend = {}, onDiscard = {}, onLink = onLink,
        )
        // The picker shows the appearance of the theme it is painted in, as the app passes the current one.
        Screen.Appearance -> AppearanceScreen(appearanceOf(theme), onAppearance = {}, onBack = {})
    }
}

/** Writes a screenshot under the test app's external files, `evidence/<name>.png`, for the pull. */
fun writeEvidence(name: String, bitmap: Bitmap): File {
    val file = File(writeEvidenceDir(), "$name.png")
    file.outputStream().use { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) { "PNG write failed: $name" } }
    return file
}

/** The evidence folder on the device, created on first use. */
fun writeEvidenceDir(): File {
    val root = InstrumentationRegistry.getInstrumentation().targetContext.getExternalFilesDir(null)
        ?: error("no external files dir for the evidence")
    return File(root, "evidence").apply { mkdirs() }
}
