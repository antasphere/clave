package com.clave.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import com.clave.ui.chat.ProviderMark
import com.clave.ui.components.ClaveIconButton
import com.clave.ui.components.ClaveTextField
import com.clave.ui.components.ListRow
import com.clave.ui.components.Notice
import com.clave.ui.components.NoticeKind
import com.clave.ui.components.SectionLabel
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveIcon
import com.clave.ui.theme.ClaveTypography
import com.clave.ui.theme.Icon
import com.clave.ui.theme.Metrics

/** A workspace the quick composer can start in. */
@Immutable
data class WorkspaceChoice(val id: String, val name: String)

/** A chat profile the quick composer can start on: its provider draws the mark. */
@Immutable
data class ProfileChoice(val id: String, val name: String, val provider: String)

/**
 * The quick composer: what is typed, where it starts (a workspace) and on what (a chat
 * profile), each a chip that opens its list. [hint] says why Send waits (no workspace yet, the
 * profiles still loading); [error] is the server's own sentence when it would not start.
 */
@Immutable
data class QuickComposerState(
    val text: String,
    val workspace: WorkspaceChoice?,
    val profile: ProfileChoice?,
    val workspaces: List<WorkspaceChoice>,
    val profiles: List<ProfileChoice>,
    val starting: Boolean = false,
    val error: String? = null,
    val hint: String? = null,
) {
    /** One tap sends: text, a workspace and a profile, and no start already under way. */
    val canSend: Boolean get() = text.isNotBlank() && workspace != null && profile != null && !starting
}

private enum class Picker { Workspace, Profile }

/** The test tag of the composer's field, for the tests that type into it. */
const val QUICK_COMPOSER_FIELD: String = "quick-composer-field"

/**
 * Type, tap Send: a new chat starts in the chosen workspace on the chosen profile and opens
 * with the message sent. The two chips open their lists in a sheet; the profile list ends on
 * "More options", the full launch form (terminals too). [autoFocus] puts the cursor in the
 * field with the keyboard up, once per visit of the screen, so typing is the first thing the
 * person does and a return from the chat does not raise the keyboard again.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QuickComposer(
    state: QuickComposerState,
    onTextChange: (String) -> Unit,
    onSend: () -> Unit,
    onPickWorkspace: (String) -> Unit,
    onPickProfile: (String) -> Unit,
    onMoreOptions: () -> Unit,
    modifier: Modifier = Modifier,
    autoFocus: Boolean = false,
) {
    val c = Clave.colors
    val t = c.theme
    val shape = RoundedCornerShape(Metrics.radiusXl)
    var picker by rememberSaveable { mutableStateOf<Picker?>(null) }
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    // Once per screen visit: a return from the chat keeps this saved, so the keyboard stays down.
    var focusedOnce by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(autoFocus) {
        if (autoFocus && !focusedOnce) {
            focusedOnce = true
            focus.requestFocus()
            keyboard?.show()
        }
    }
    Column(
        modifier
            .fillMaxWidth()
            .clip(shape)
            .background(t.surface50)
            .border(Metrics.hairline, t.border, shape)
            .padding(Metrics.space(2)),
        verticalArrangement = Arrangement.spacedBy(Metrics.space(2)),
    ) {
        ClaveTextField(
            value = state.text,
            onValueChange = onTextChange,
            modifier = Modifier.fillMaxWidth().heightIn(min = Metrics.space(16)).focusRequester(focus).testTag(QUICK_COMPOSER_FIELD),
            placeholder = state.profile?.let { "Message ${it.name.removeSuffix(" (chat)")}" } ?: "Start a new chat",
            singleLine = false,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            enabled = !state.starting,
        )
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Metrics.space(2)),
        ) {
            Row(
                Modifier.weight(1f),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Metrics.space(2)),
            ) {
                PickerChip(
                    label = state.workspace?.name ?: "No workspace",
                    description = "Workspace: ${state.workspace?.name ?: "none"}",
                    leading = { Icon(ClaveIcon.Folder, contentDescription = null, tint = t.textTertiary, size = Metrics.controlSmIcon) },
                    enabled = state.workspaces.isNotEmpty() && !state.starting,
                    onClick = { picker = Picker.Workspace },
                    modifier = Modifier.weight(1f, fill = false),
                )
                PickerChip(
                    label = state.profile?.name ?: "No agent",
                    description = "Agent: ${state.profile?.name ?: "none"}",
                    leading = { state.profile?.let { ProviderMark(it.provider, size = Metrics.controlSmIcon) } },
                    enabled = !state.starting,
                    onClick = { picker = Picker.Profile },
                    modifier = Modifier.weight(1f, fill = false),
                )
            }
            if (state.starting) {
                Box(Modifier.size(Metrics.controlHeight), contentAlignment = Alignment.Center) { SmallSpinner() }
            } else {
                ClaveIconButton(
                    icon = ClaveIcon.ArrowUp,
                    onClick = onSend,
                    contentDescription = "Send",
                    active = state.canSend,
                    enabled = state.canSend,
                )
            }
        }
        val line = state.error ?: state.hint
        if (line != null) {
            Notice(line, kind = if (state.error != null) NoticeKind.Destructive else NoticeKind.Info)
        }
    }

    when (picker) {
        Picker.Workspace -> ChoiceSheet(title = "Workspace", onDismiss = { picker = null }) {
            state.workspaces.forEach { w ->
                ListRow(
                    title = w.name,
                    leading = { Icon(ClaveIcon.Folder, contentDescription = null, tint = t.textTertiary) },
                    trailing = { if (w.id == state.workspace?.id) Icon(ClaveIcon.Check, contentDescription = "Chosen", tint = t.accent) },
                    selected = w.id == state.workspace?.id,
                    onClick = {
                        picker = null
                        onPickWorkspace(w.id)
                    },
                )
            }
        }
        Picker.Profile -> ChoiceSheet(title = "Agent", onDismiss = { picker = null }) {
            state.profiles.forEach { p ->
                ListRow(
                    title = p.name,
                    leading = { ProviderMark(p.provider, size = Metrics.controlIcon) },
                    trailing = { if (p.id == state.profile?.id) Icon(ClaveIcon.Check, contentDescription = "Chosen", tint = t.accent) },
                    selected = p.id == state.profile?.id,
                    onClick = {
                        picker = null
                        onPickProfile(p.id)
                    },
                )
            }
            ListRow(
                title = "More options",
                subtitle = "Every saved profile, terminals too",
                leading = { Icon(ClaveIcon.EllipsisHorizontal, contentDescription = null, tint = t.textTertiary) },
                onClick = {
                    picker = null
                    onMoreOptions()
                },
            )
        }
        null -> Unit
    }
}

/** A chip that opens a list: the small control's height on surface-200, a chevron saying it opens. */
@Composable
private fun PickerChip(
    label: String,
    description: String,
    leading: @Composable () -> Unit,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val t = Clave.colors.theme
    val shape = RoundedCornerShape(Metrics.controlSmRadius)
    Row(
        modifier = modifier
            .heightIn(min = Metrics.controlSmHeight)
            .clip(shape)
            .background(t.surface200)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics(mergeDescendants = true) { contentDescription = description }
            .padding(horizontal = Metrics.controlSmPadding),
        horizontalArrangement = Arrangement.spacedBy(Metrics.controlGap),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        leading()
        BasicText(
            text = label,
            modifier = Modifier.weight(1f, fill = false),
            style = ClaveTypography.type(Metrics.controlSmText).copy(color = t.textPrimary),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        Icon(ClaveIcon.ChevronDown, contentDescription = null, tint = t.textTertiary, size = Metrics.controlSmIcon)
    }
}

/** A list to pick one from, in a sheet over the screen. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ChoiceSheet(title: String, onDismiss: () -> Unit, content: @Composable () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = Clave.colors.theme.surfaceRaised) {
        Column(Modifier.verticalScroll(rememberScrollState()).navigationBarsPadding().padding(bottom = Metrics.space(4))) {
            SectionLabel(title)
            content()
        }
    }
}
