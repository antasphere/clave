package com.clave.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import com.clave.core.chat.QuestionReply
import com.clave.core.chat.Shaped
import com.clave.core.chat.answersAsPermission
import com.clave.core.chat.isRefusalOption
import com.clave.core.chat.shapeClarification
import com.clave.core.chat.shapePermission
import com.clave.core.chat.shapeSecret
import com.clave.core.contract.PendingRequest
import com.clave.core.contract.RequestKind
import com.clave.core.contract.RequestResponse
import com.clave.core.contract.SecretAction
import com.clave.ui.components.Badge
import com.clave.ui.components.ButtonKind
import com.clave.ui.components.ClaveButton
import com.clave.ui.components.ClaveIconButton
import com.clave.ui.components.ClaveTextField
import com.clave.ui.components.EmptyState
import com.clave.ui.components.Notice
import com.clave.ui.components.NoticeKind
import com.clave.ui.components.PaneHeader
import com.clave.ui.components.ScreenScaffold
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveIcon
import com.clave.ui.theme.ClaveTypography
import com.clave.ui.theme.Icon
import com.clave.ui.theme.Metrics
import com.clave.ui.theme.shadow

/**
 * A machine's pending requests (decision 8 of the spec): the server owns them and their
 * first-valid-answer rule, the phone lists them. [busy] holds the ids being resolved;
 * [notices] a sentence per id the caller sets after a refused resolve ("Answered elsewhere
 * first: this request is settled."). [unavailable] is a server that keeps no list.
 */
@Immutable
data class RequestsScreenState(
    val machineName: String?,
    val loading: Boolean,
    val unavailable: Boolean,
    val error: String?,
    val pending: List<PendingRequest>,
    val busy: Set<String>,
    val notices: Map<String, String>,
)

/** The word a request's kind is badged with. */
internal fun requestKindWord(kind: RequestKind): String = when (kind) {
    RequestKind.Permission -> "Permission"
    RequestKind.Clarification -> "Question"
    RequestKind.Secret -> "Secret"
}

/** Where a secret goes once sent, said before it is typed. */
internal fun secretActionText(action: SecretAction): String = when (action) {
    is SecretAction.Run -> "Runs ${action.command} in ${action.cwd} as ${action.envVar}"
    is SecretAction.EnvFile -> "Written to ${action.file} as ${action.key}"
}

/**
 * The requests, one card each, the desktop's prompt dock cards: a permission answers with
 * one of its options, a question with its form, a secret with its value, and any of them
 * can be dismissed. Every answer is shaped by the core before it leaves; a problem (a
 * question left blank, an empty secret) is said under the card and nothing is sent. The
 * replies and the secret live in the screen, per request, and are never logged.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun RequestsScreen(
    state: RequestsScreenState,
    onResolve: (requestId: String, response: RequestResponse) -> Unit,
    onRefresh: () -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    ScreenScaffold(
        modifier = modifier,
        header = { PaneHeader(title = "Requests", subtitle = state.machineName, onBack = onBack) },
    ) { padding ->
        PullToRefreshBox(isRefreshing = state.loading, onRefresh = onRefresh, modifier = Modifier.fillMaxSize()) {
            Column(
                Modifier
                    .fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(padding)
                    .padding(horizontal = Metrics.gutter, vertical = Metrics.space(4)),
                verticalArrangement = Arrangement.spacedBy(Metrics.space(3)),
            ) {
                // A request answered elsewhere leaves the list; its sentence stays a while.
                val ids = state.pending.map { it.id }.toSet()
                state.notices.filterKeys { it !in ids }.forEach { (_, text) -> Notice(text) }
                if (state.error != null) Notice(state.error, kind = NoticeKind.Destructive)
                if (state.unavailable) Notice("This machine does not list its requests; answer them in the chat.")
                state.pending.forEach { request ->
                    key(request.id) {
                        RequestCard(
                            request = request,
                            busy = request.id in state.busy,
                            notice = state.notices[request.id],
                            onResolve = { onResolve(request.id, it) },
                        )
                    }
                }
                if (state.pending.isEmpty()) {
                    when {
                        state.loading -> Loading()
                        state.unavailable -> Unit
                        else -> EmptyState(
                            ClaveIcon.InboxStack,
                            "Nothing is waiting for you",
                            text = "A tool to allow or a question to answer lands here.",
                        )
                    }
                }
            }
        }
    }
}

/** One request on the raised card; its controls rest while it is being resolved. */
@Composable
private fun RequestCard(
    request: PendingRequest,
    busy: Boolean,
    notice: String?,
    onResolve: (RequestResponse) -> Unit,
) {
    val c = Clave.colors
    val t = c.theme
    val shape = RoundedCornerShape(Metrics.radiusXl)
    val replies = remember(request.id) { mutableStateMapOf<String, QuestionReply>() }
    var secret by remember(request.id) { mutableStateOf("") }
    var shown by remember(request.id) { mutableStateOf(false) }
    var problem by remember(request.id) { mutableStateOf<String?>(null) }
    val enabled = !busy
    fun submit(shaped: Shaped) {
        when (shaped) {
            is Shaped.Problem -> problem = shaped.problem
            is Shaped.Ok -> {
                problem = null
                onResolve(shaped.response)
                secret = ""
            }
        }
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .shadow(Clave.shadows.raised, shape)
            .clip(shape)
            .background(t.surfaceRaised)
            .border(Metrics.hairline, t.borderSubtle, shape)
            .padding(horizontal = Metrics.space(3.5f), vertical = Metrics.space(3)),
        verticalArrangement = Arrangement.spacedBy(Metrics.space(2)),
    ) {
        Badge(requestKindWord(request.kind))
        BasicText(
            request.description,
            style = ClaveTypography.type(Metrics.textSm, lineHeight = Metrics.proseLineHeight).copy(color = t.textPrimary),
        )
        val detail = request.detail
        if (!detail.isNullOrBlank()) {
            BasicText(
                detail,
                style = ClaveTypography.type(Metrics.textXs, lineHeight = Metrics.proseLineHeight).copy(color = t.textTertiary),
            )
        }
        if (notice != null) Notice(notice)
        val questions = request.questions.orEmpty()
        when {
            request.kind == RequestKind.Secret -> {
                val action = request.action
                if (action != null) {
                    BasicText(
                        secretActionText(action),
                        style = ClaveTypography.mono(Metrics.textXs).copy(color = t.textSecondary),
                    )
                }
                BasicText("The secret", style = ClaveTypography.type(Metrics.textXs).copy(color = t.textSecondary))
                ClaveTextField(
                    value = secret,
                    onValueChange = { secret = it },
                    enabled = enabled,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                    visualTransformation = if (shown) VisualTransformation.None else PasswordVisualTransformation(),
                    modifier = Modifier.fillMaxWidth().semantics { contentDescription = "The secret" },
                    trailing = {
                        ClaveIconButton(
                            if (shown) ClaveIcon.EyeSlash else ClaveIcon.Eye,
                            onClick = { shown = !shown },
                            contentDescription = if (shown) "Hide the secret" else "Show the secret",
                            size = Metrics.controlSmHeight,
                        )
                    },
                )
                BasicText(
                    "Stays on the phone until you send it",
                    style = ClaveTypography.type(Metrics.textXs).copy(color = t.textTertiary),
                )
                Actions {
                    ClaveButton("Dismiss", onClick = { onResolve(RequestResponse.Dismiss) }, kind = ButtonKind.Ghost, enabled = enabled)
                    Spacer(Modifier.weight(1f))
                    ClaveButton("Send the secret", onClick = { submit(shapeSecret(secret)) }, kind = ButtonKind.Primary, enabled = enabled)
                }
            }
            answersAsPermission(request) -> {
                if (questions.isNotEmpty()) {
                    QuestionForm(
                        questions,
                        replies,
                        onChange = { k, r -> replies[k] = r },
                        secretKeys = request.secretQuestions.orEmpty().toSet(),
                        enabled = enabled,
                    )
                }
                val options = request.options.orEmpty()
                val denies = options.filter(::isRefusalOption)
                val allows = options.filterNot(::isRefusalOption)
                Actions {
                    denies.forEach { o ->
                        ClaveButton(o.label, onClick = { submit(shapePermission(request, o.id, replies)) }, enabled = enabled)
                    }
                    ClaveButton("Dismiss", onClick = { onResolve(RequestResponse.Dismiss) }, kind = ButtonKind.Ghost, enabled = enabled)
                    Spacer(Modifier.weight(1f))
                    (allows.drop(1).reversed() + allows.take(1)).forEach { o ->
                        ClaveButton(
                            o.label,
                            onClick = { submit(shapePermission(request, o.id, replies)) },
                            kind = if (o == allows.first()) ButtonKind.Primary else ButtonKind.Secondary,
                            enabled = enabled,
                        )
                    }
                }
            }
            else -> {
                QuestionForm(
                    questions,
                    replies,
                    onChange = { k, r -> replies[k] = r },
                    secretKeys = request.secretQuestions.orEmpty().toSet(),
                    enabled = enabled,
                )
                Actions {
                    ClaveButton("Dismiss", onClick = { onResolve(RequestResponse.Dismiss) }, kind = ButtonKind.Ghost, enabled = enabled)
                    Spacer(Modifier.weight(1f))
                    ClaveButton("Answer", onClick = { submit(shapeClarification(request, replies)) }, kind = ButtonKind.Primary, enabled = enabled)
                }
            }
        }
        val said = problem
        if (said != null) {
            // The red is the triangle's; the sentence takes the secondary ink, readable in every theme.
            Row(horizontalArrangement = Arrangement.spacedBy(Metrics.space(2)), verticalAlignment = Alignment.Top) {
                Icon(ClaveIcon.ExclamationTriangle, contentDescription = null, tint = c.shared.destructive, size = Metrics.chatGlyph)
                BasicText(
                    said,
                    style = ClaveTypography.type(Metrics.textXs, lineHeight = Metrics.proseLineHeight).copy(color = c.theme.textSecondary),
                )
            }
        }
    }
}

/** A card's row of answers: refusals and "Dismiss" on the left, the one verb last on the right. */
@Composable
private fun Actions(content: @Composable RowScope.() -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(top = Metrics.space(1)),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Metrics.controlGap),
        content = content,
    )
}
