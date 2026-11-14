package com.clave.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.semantics.contentDescription
import com.clave.ui.theme.shadow
import kotlinx.coroutines.launch
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicText
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import com.clave.core.chat.Block
import com.clave.core.chat.Entry
import com.clave.core.chat.GroupStatus
import com.clave.core.chat.attachmentKind
import com.clave.core.chat.approvalRunSummary
import com.clave.core.chat.blockKey
import com.clave.core.chat.decisionWord
import com.clave.core.chat.describeApproval
import com.clave.core.chat.describeToolHead
import com.clave.core.chat.failureCount
import com.clave.core.chat.groupHint
import com.clave.core.chat.groupStatus
import com.clave.core.chat.isQuestion
import com.clave.core.chat.markerOf
import com.clave.core.chat.parseDelivery
import com.clave.core.chat.questionKey
import com.clave.core.chat.formAnswerText
import com.clave.core.chat.refused
import com.clave.core.chat.relativeTime
import com.clave.core.chat.toolGroupSummary
import com.clave.core.chat.toolHint
import com.clave.core.chat.toolLine
import com.clave.core.chat.toolPanel
import com.clave.core.contract.Attachment
import com.clave.core.contract.FormAnswer
import com.clave.core.contract.FileAttachment
import com.clave.core.contract.SessionAttachment
import com.clave.ui.chat.ApprovalCard
import com.clave.ui.chat.AssistantProse
import com.clave.ui.chat.ChatControlsView
import com.clave.ui.chat.ChatHeader
import com.clave.ui.chat.ChoiceSheet
import com.clave.ui.chat.Composer
import com.clave.ui.chat.ComposerStatusRow
import com.clave.ui.chat.ControlSheet
import com.clave.ui.chat.FormCard
import com.clave.ui.chat.PermissionPrompt
import com.clave.ui.chat.SlashCommandView
import com.clave.ui.chat.SlashMenu
import com.clave.ui.chat.PromptView
import com.clave.ui.chat.PromptDock
import com.clave.ui.chat.QuestionView
import com.clave.ui.chat.ToolRow
import com.clave.ui.chat.ToolSectionView
import com.clave.ui.chat.ToolStatus
import com.clave.ui.chat.UserTurn
import com.clave.ui.chat.WorkCardView
import com.clave.ui.chat.WorkCards
import com.clave.ui.components.EmptyState
import com.clave.ui.components.ListRow
import com.clave.ui.components.Notice
import com.clave.ui.components.NoticeAction
import com.clave.ui.components.NoticeKind
import com.clave.ui.components.ScreenScaffold
import com.clave.ui.theme.Clave
import com.clave.ui.theme.ClaveIcon
import com.clave.ui.theme.ClaveTypography
import com.clave.ui.theme.Icon
import com.clave.ui.theme.Metrics
import com.clave.ui.theme.Reachability
import com.clave.ui.theme.SessionStatus

/**
 * What the composer holds: the draft, its attachments by label, whether a send is in
 * flight, and the last delivery's mark ("Delivered to the desktop").
 */
@Immutable
data class ChatComposerState(
    val text: String,
    val attachments: List<String>,
    val sending: Boolean,
    val deliveryMark: String?,
)

/** A message whose delivery the phone could not confirm: the person decides, never the app. */
@Immutable
data class UnknownSendView(val text: String)

/**
 * One conversation as the chat draws it. [blocks] are the core's grouped transcript, oldest
 * first; [expanded] holds the block keys the reader opened; [now] is the caller's clock.
 */
@Immutable
data class ChatScreenState(
    val title: String,
    val machineName: String?,
    val provider: String,
    val blocks: List<Block>,
    val status: SessionStatus,
    val reachability: Reachability,
    val loaded: Boolean,
    val hasOlder: Boolean,
    val loadingOlder: Boolean,
    val error: String?,
    val ended: Boolean,
    val exitCode: Int?,
    val working: Boolean,
    val composer: ChatComposerState,
    val unknownSend: UnknownSendView?,
    val pendingRequests: Int,
    val pendingLabel: String?,
    val expanded: Set<String>,
    val now: Long,
    /** The composer's status: the model, its effort, the mode and the context meter. */
    val controls: ChatControlsView = ChatControlsView(),
    /** The first permission of this conversation still waiting, docked above the composer. */
    val prompt: PromptView? = null,
    /** The background work running now (subagents, commands), as cards above the composer. */
    val work: List<WorkCardView> = emptyList(),
    /** The commands matching the "/" being typed at the start of the composer. */
    val slashCommands: List<SlashCommandView> = emptyList(),
    /** Forms answered from this phone whose answer the conversation has not echoed yet. */
    val answeredHere: Set<String> = emptySet(),
)

/**
 * What the chat asks of its host beyond the transcript and the composer: the pickers under the
 * composer. A separate holder so a screen that does not offer one keeps its call short.
 */
@Immutable
data class ChatActions(
    /** A picker opened: the host reads the choices again (the models may have changed). */
    val onOpenControls: () -> Unit = {},
    val onPickModel: (String) -> Unit = {},
    val onPickEffort: (String) -> Unit = {},
    val onPickMode: (String) -> Unit = {},
    val onDismissRefusal: () -> Unit = {},
    /** Stop one background task by its id. */
    val onStopTask: (String) -> Unit = {},
    /** A question's answers as the form gives them, a multi-select as a list; null sends one line each through onAnswer. */
    val onAnswerForm: ((requestId: String, optionId: String, answers: Map<String, FormAnswer>) -> Unit)? = null,
)

/** An attachment as a chip says it: its marker ("[Image #1]") or its kind, then its name. */
internal fun attachmentLabel(a: Attachment): String = when (a) {
    is FileAttachment -> "${markerOf(a) ?: attachmentKind(a).word} ${a.name}"
    is SessionAttachment -> "${markerOf(a) ?: "Session"} ${a.name}"
}

/** The line above a message another tab sent: who sent it. Null for the person's own words. */
internal fun deliveredCaption(text: String): String? =
    parseDelivery(text)?.let { "${it.sender?.name ?: "Another agent"} · delivered" }

private fun toolStatusOf(tool: Entry.Tool): ToolStatus = when {
    !tool.complete -> ToolStatus.Running
    tool.failed -> ToolStatus.Failed
    else -> ToolStatus.Complete
}

private fun GroupStatus.toToolStatus(): ToolStatus = when (this) {
    GroupStatus.Running -> ToolStatus.Running
    GroupStatus.Failed -> ToolStatus.Failed
    GroupStatus.Complete -> ToolStatus.Complete
}

/** What an approval row says once nothing more is owed on it; null while it waits. */
internal fun approvalAnswered(entry: Entry.Permission): String? {
    val answer = entry.answer
    return when {
        answer == null && entry.answeredElsewhere -> "No longer awaiting an answer"
        answer == null -> null
        isQuestion(entry.request) -> if (refused(entry.request, answer)) "Skipped" else "Answered"
        else -> decisionWord(entry.request, answer)
    }
}

/**
 * One conversation, in the desktop chat view's shapes: the transcript newest at the bottom,
 * paged backwards as the reader scrolls up to the oldest message; the composer, the requests
 * dock and the delivery notices pinned above the keyboard. The machine's reachability is a
 * notice of its own, never folded into the session's state. A message whose delivery is
 * unknown is never sent again on its own: the reader picks "Send again" or "Discard".
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(
    state: ChatScreenState,
    onBack: () -> Unit,
    onRequests: () -> Unit,
    onLoadOlder: () -> Unit,
    onTextChange: (String) -> Unit,
    onSend: () -> Unit,
    onStop: () -> Unit,
    onPickPhotos: () -> Unit,
    onTakePhoto: () -> Unit,
    onPickDocuments: () -> Unit,
    onRemoveAttachment: (Int) -> Unit,
    onAnswer: (requestId: String, optionId: String, answers: Map<String, String>) -> Unit,
    onToggle: (blockKey: String) -> Unit,
    onResend: () -> Unit,
    onDiscard: () -> Unit,
    onLink: (String) -> Unit,
    modifier: Modifier = Modifier,
    actions: ChatActions = ChatActions(),
) {
    var attaching by remember { mutableStateOf(false) }
    var sheet by remember { mutableStateOf<ControlSheet?>(null) }
    ScreenScaffold(
        modifier = modifier,
        header = {
            ChatHeader(
                title = state.title,
                subtitle = listOfNotNull(state.machineName, state.status.label).joinToString(" · "),
                provider = state.provider,
                onBack = onBack,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
                actions = { RequestsAction(state.pendingRequests, onRequests) },
            )
        },
        bottom = {
            Column(
                Modifier.fillMaxWidth().padding(horizontal = Metrics.gutter).padding(bottom = Metrics.space(2)),
                verticalArrangement = Arrangement.spacedBy(Metrics.space(2)),
            ) {
                val unknown = state.unknownSend
                if (unknown != null) UnknownSendCard(unknown, onResend, onDiscard)
                if (state.ended) {
                    Notice("This session has ended" + (state.exitCode?.let { " (exit $it)" } ?: ""))
                }
                val prompt = state.prompt
                if (prompt != null && !state.ended) {
                    PermissionPrompt(prompt, onAnswer = { optionId -> onAnswer(prompt.id, optionId, emptyMap()) })
                } else {
                    PromptDock(state.pendingRequests, state.pendingLabel ?: "Waiting for your answer", onRequests)
                }
                if (!state.ended) WorkCards(state.work, onStop = actions.onStopTask)
                if (!state.ended) SlashMenu(state.slashCommands, onPick = { onTextChange(it.insert) })
                Composer(
                    text = state.composer.text,
                    onTextChange = onTextChange,
                    onSend = onSend,
                    onStop = onStop,
                    onAttach = { attaching = true },
                    working = state.working,
                    sending = state.composer.sending,
                    attachments = state.composer.attachments,
                    onRemoveAttachment = onRemoveAttachment,
                    deliveryMark = state.composer.deliveryMark,
                    placeholder = if (state.ended) "This session has ended" else "Write a message…",
                    enabled = !state.ended,
                    sendBlocked = state.unknownSend != null,
                )
                val refusal = state.controls.refusal
                if (refusal != null) {
                    Notice(refusal, kind = NoticeKind.Warning, action = NoticeAction("Dismiss", actions.onDismissRefusal))
                }
                ComposerStatusRow(
                    controls = state.controls,
                    enabled = !state.ended,
                    onOpen = {
                        actions.onOpenControls()
                        sheet = it
                    },
                )
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            val notices = Modifier.padding(horizontal = Metrics.gutter).padding(top = Metrics.space(2))
            when (state.reachability) {
                Reachability.Reachable -> Unit
                Reachability.Connecting, Reachability.Unreachable -> Notice(
                    "${state.reachability.label}: the machine is not answering right now.",
                    kind = NoticeKind.Warning,
                    modifier = notices,
                )
                Reachability.Refused -> Notice(
                    "Token refused: pair this phone with this machine again.",
                    kind = NoticeKind.Destructive,
                    modifier = notices,
                )
            }
            if (state.error != null) Notice(state.error, kind = NoticeKind.Destructive, modifier = notices)
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when {
                    state.blocks.isEmpty() && !state.loaded -> Loading()
                    state.blocks.isEmpty() -> EmptyState(
                        ClaveIcon.ChatBubbleLeftRight,
                        "Start a conversation",
                        text = "Ask a question or describe what you want to build.",
                    )
                    else -> Transcript(state, onLoadOlder, onAnswer, onToggle, onLink, actions.onAnswerForm)
                }
            }
        }
    }
    when (sheet) {
        ControlSheet.Model -> ChoiceSheet(
            title = "Model",
            choices = state.controls.models,
            onPick = actions.onPickModel,
            onDismiss = { sheet = null },
            loading = state.controls.modelsLoading,
            emptyText = "This agent offers no other model.",
        )
        ControlSheet.Effort -> ChoiceSheet("Effort", state.controls.efforts, actions.onPickEffort, { sheet = null })
        ControlSheet.Mode -> ChoiceSheet("Permission mode", state.controls.modes, actions.onPickMode, { sheet = null })
        null -> Unit
    }
    if (attaching) {
        AttachSheet(
            onDismiss = { attaching = false },
            onPickPhotos = onPickPhotos,
            onTakePhoto = onTakePhoto,
            onPickDocuments = onPickDocuments,
        )
    }
}

/**
 * The transcript, upside down so the newest sits at the bottom and the keyboard pushes it
 * up. Reaching the oldest block asks for the page before it, once per arrival there.
 */
@Composable
private fun Transcript(
    state: ChatScreenState,
    onLoadOlder: () -> Unit,
    onAnswer: (requestId: String, optionId: String, answers: Map<String, String>) -> Unit,
    onToggle: (blockKey: String) -> Unit,
    onLink: (String) -> Unit,
    onAnswerForm: ((String, String, Map<String, FormAnswer>) -> Unit)? = null,
) {
    val blocks = state.blocks
    val newestFirst = blocks.asReversed()
    val list = rememberLazyListState()
    val loadOlder by rememberUpdatedState(onLoadOlder)
    val atOldest by remember(list) {
        derivedStateOf {
            val info = list.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: -1
            info.totalItemsCount > 0 && last >= info.totalItemsCount - 1
        }
    }
    LaunchedEffect(atOldest, state.hasOlder, state.loadingOlder) {
        if (atOldest && state.hasOlder && !state.loadingOlder) loadOlder()
    }
    val scope = rememberCoroutineScope()
    // The newest question still open, by its place in the upside-down list.
    val question = newestFirst.indexOfFirst {
        it is Entry.Permission && isQuestion(it.request) && approvalAnswered(it) == null && it.request.id !in state.answeredHere
    }
    // Null while the question is on screen (or none waits); else whether it sits above what
    // is read. Derived, so a layout pass that changes nothing recomposes nothing.
    val questionAbove by remember(list, question) {
        derivedStateOf {
            val visible = list.layoutInfo.visibleItemsInfo
            if (question < 0 || visible.isEmpty() || visible.any { it.index == question }) null
            else question > visible.last().index
        }
    }
    val awayFromLatest by remember(list) { derivedStateOf { list.firstVisibleItemIndex > 0 } }
    Box(Modifier.fillMaxSize()) {
    LazyColumn(
        state = list,
        reverseLayout = true,
        modifier = Modifier.fillMaxSize().testTag("chat-transcript"),
        contentPadding = PaddingValues(horizontal = Metrics.gutter, vertical = Metrics.space(3)),
        verticalArrangement = Arrangement.spacedBy(Metrics.space(3)),
    ) {
        itemsIndexed(
            newestFirst,
            key = { i, block -> blockKey(block) { blocks.size - 1 - i } },
        ) { i, block ->
            val key = blockKey(block) { blocks.size - 1 - i }
            TranscriptBlock(
                block, key, state.expanded, onAnswer, onToggle, onLink,
                docked = state.prompt != null, now = state.now, answeredHere = state.answeredHere, onAnswerForm = onAnswerForm,
            )
        }
        if (state.loadingOlder) {
            item(key = "loading-older") {
                Row(
                    Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(Metrics.space(2), Alignment.CenterHorizontally),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    SmallSpinner()
                    BasicText(
                        "Reading earlier messages…",
                        style = ClaveTypography.type(Metrics.textXs).copy(color = Clave.colors.theme.textSecondary),
                    )
                }
            }
        }
    }
    Row(
        Modifier.align(Alignment.BottomCenter).fillMaxWidth().padding(horizontal = Metrics.gutter, vertical = Metrics.space(2)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
            val above = questionAbove
            if (above != null) {
                // An older question, above what is read, points up; a newer one, down.
                FloatingPill("The agent asks you something", ClaveIcon.ChevronDown, flip = above) { scope.launch { list.animateScrollToItem(question) } }
            }
        }
        if (awayFromLatest) {
            FloatingRound(ClaveIcon.ChevronDown, "Jump to latest") { scope.launch { list.animateScrollToItem(0) } }
        }
    }
    }
}

/** A raised pill over the transcript: a few words and which way to go. */
@Composable
private fun FloatingPill(label: String, icon: ClaveIcon, flip: Boolean, onClick: () -> Unit) {
    val t = Clave.colors.theme
    val shape = RoundedCornerShape(Metrics.radiusXxl)
    Row(
        Modifier
            .shadow(Clave.shadows.raised, shape)
            .clip(shape)
            .background(t.surfaceRaised)
            .border(Metrics.hairline, t.borderSubtle, shape)
            .clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = Metrics.controlHeight)
            .padding(horizontal = Metrics.space(3))
            .testTag("question-pill"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Metrics.space(1.5f)),
    ) {
        BasicText(label, style = ClaveTypography.type(Metrics.textControl).copy(color = t.textPrimary), maxLines = 1)
        Icon(icon, null, Modifier.rotate(if (flip) 180f else 0f), tint = t.textSecondary, size = Metrics.chatGlyph)
    }
}

/** The round "jump to latest" over the transcript's bottom end. */
@Composable
private fun FloatingRound(icon: ClaveIcon, description: String, onClick: () -> Unit) {
    val t = Clave.colors.theme
    Box(
        Modifier
            .size(Metrics.controlHeight + Metrics.space(2))
            .shadow(Clave.shadows.raised, CircleShape)
            .clip(CircleShape)
            .background(t.surfaceRaised)
            .border(Metrics.hairline, t.borderSubtle, CircleShape)
            .clickable(role = Role.Button, onClick = onClick)
            .semantics { contentDescription = description },
        contentAlignment = Alignment.Center,
    ) {
        Icon(icon, null, tint = t.textPrimary, size = Metrics.controlIcon)
    }
}

/** One block of the transcript as the desktop's `TranscriptRow` draws it. */
@Composable
private fun TranscriptBlock(
    block: Block,
    key: String,
    expanded: Set<String>,
    onAnswer: (requestId: String, optionId: String, answers: Map<String, String>) -> Unit,
    onToggle: (blockKey: String) -> Unit,
    onLink: (String) -> Unit,
    docked: Boolean = false,
    now: Long = 0,
    answeredHere: Set<String> = emptySet(),
    onAnswerForm: ((String, String, Map<String, FormAnswer>) -> Unit)? = null,
) {
    val t = Clave.colors.theme
    when (block) {
        is Entry.User -> DeliveredOrOwnTurn(block, stamp(block.at, now))
        is Entry.Assistant -> AssistantProse(block.text, streaming = !block.final, onLink = onLink, timestamp = stamp(block.at, now))
        is Entry.Tool -> SingleTool(block, key, expanded, onToggle)
        is Block.ToolGroup -> {
            if (block.tools.size == 1) {
                SingleTool(block.tools[0], key, expanded, onToggle)
            } else {
                val open = key in expanded
                Column {
                    ToolRow(
                        summary = toolGroupSummary(block.tools),
                        hint = groupHint(block.tools),
                        status = groupStatus(block.tools).toToolStatus(),
                        expanded = open,
                        onToggle = { onToggle(key) },
                        failures = failureCount(block.tools),
                        sections = emptyList(),
                    )
                    if (open) {
                        Column(Modifier.padding(start = Metrics.space(4))) {
                            block.tools.forEach { SingleTool(it, "$key/${it.id}", expanded, onToggle) }
                        }
                    }
                }
            }
        }
        // The open permission is answered on the card docked above the composer: here, its place.
        is Entry.Permission if docked && approvalAnswered(block) == null && !isQuestion(block.request) -> {
            Row(horizontalArrangement = Arrangement.spacedBy(Metrics.space(2)), verticalAlignment = Alignment.CenterVertically) {
                Icon(ClaveIcon.ShieldCheck, contentDescription = null, tint = t.textTertiary, size = Metrics.chatGlyph)
                BasicText(
                    "Waiting for your approval below",
                    style = ClaveTypography.type(Metrics.codeSize).copy(color = t.textTertiary),
                )
            }
        }
        is Entry.Permission if !block.request.questions.isNullOrEmpty() -> {
            val request = block.request
            FormCard(
                title = request.description,
                questions = request.questions.orEmpty(),
                options = request.options.map { it.id to it.label },
                onAnswer = { optionId, answers ->
                    if (onAnswerForm != null) {
                        onAnswerForm(request.id, optionId, answers)
                    } else {
                        onAnswer(request.id, optionId, answers.mapValues { formAnswerText(it.value) })
                    }
                },
                draft = block.draft.orEmpty(),
                notes = block.notes.orEmpty(),
                answered = approvalAnswered(block) ?: if (request.id in answeredHere) "Answered" else null,
                onLink = onLink,
            )
        }
        is Entry.Permission -> {
            val request = block.request
            val approval = if (isQuestion(request)) null else describeApproval(request)
            ApprovalCard(
                title = approval?.label ?: if (isQuestion(request)) request.description else request.toolName ?: request.description,
                target = approval?.target ?: if (isQuestion(request)) null else request.description.takeIf { it != request.toolName },
                options = request.options.map { it.id to it.label },
                onAnswer = { optionId, answers -> onAnswer(request.id, optionId, answers) },
                detail = request.detail,
                questions = request.questions?.map { q ->
                    QuestionView(
                        id = questionKey(q),
                        prompt = q.question,
                        options = q.options.map { it.label },
                        multiSelect = q.multiSelect == true,
                        header = q.header,
                    )
                },
                answered = approvalAnswered(block),
            )
        }
        is Block.ApprovalGroup -> {
            val summary = approvalRunSummary(block.approvals)
            Row(horizontalArrangement = Arrangement.spacedBy(Metrics.space(2)), verticalAlignment = Alignment.Top) {
                Icon(ClaveIcon.ShieldCheck, contentDescription = null, tint = t.textTertiary, size = Metrics.chatGlyph)
                Column {
                    BasicText(summary.head, style = ClaveTypography.type(Metrics.codeSize).copy(color = t.textTertiary))
                    if (summary.detail.isNotEmpty()) {
                        BasicText(summary.detail, style = ClaveTypography.type(Metrics.textXs).copy(color = t.textTertiary))
                    }
                }
            }
        }
        is Block.DeliveryGroup -> Column(verticalArrangement = Arrangement.spacedBy(Metrics.space(2))) {
            block.messages.forEach { DeliveredOrOwnTurn(it, stamp(it.at, now)) }
        }
        is Entry.Error -> Notice(block.message, kind = NoticeKind.Destructive)
    }
}

/** A turn's stamp; none without a clock (a preview). */
private fun stamp(at: Long, now: Long): String? = if (now <= 0 || at <= 0) null else relativeTime(at, now)

/** A user turn: the person's own words, or a message another tab sent, under who sent it. */
@Composable
private fun DeliveredOrOwnTurn(entry: Entry.User, timestamp: String? = null) {
    val t = Clave.colors.theme
    val delivery = parseDelivery(entry.text)
    val labels = entry.attachments.orEmpty().map(::attachmentLabel)
    if (delivery == null) {
        UserTurn(entry.text, attachmentLabels = labels, interrupted = entry.interrupted, timestamp = timestamp)
        return
    }
    Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(Metrics.space(1))) {
        BasicText(
            deliveredCaption(entry.text).orEmpty(),
            style = ClaveTypography.type(Metrics.textXs).copy(color = t.textTertiary),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        UserTurn(delivery.body, attachmentLabels = labels, interrupted = entry.interrupted, timestamp = timestamp)
    }
}

/** One tool call on its row; its sections are read only once the reader opens it. */
@Composable
private fun SingleTool(tool: Entry.Tool, key: String, expanded: Set<String>, onToggle: (String) -> Unit) {
    val open = key in expanded
    // Read only once opened: a closed row never turns an output into text.
    val panel = if (open) toolPanel(tool) else null
    ToolRow(
        summary = toolLine(tool),
        hint = toolHint(tool),
        status = toolStatusOf(tool),
        expanded = open,
        onToggle = { onToggle(key) },
        kind = describeToolHead(tool).kind.wire,
        detailedSections = panel?.sections?.map { ToolSectionView(it.label, it.text, it.language) },
        detail = panel?.detail,
    )
}

/** "Delivery unknown": the message, and the two ways forward as two separate actions. */
@Composable
private fun UnknownSendCard(send: UnknownSendView, onResend: () -> Unit, onDiscard: () -> Unit) {
    val c = Clave.colors
    val t = c.theme
    val link = ClaveTypography.type(Metrics.textControl, lineHeight = Metrics.proseLineHeight)
        .copy(color = t.textPrimary, textDecoration = TextDecoration.Underline)
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(Metrics.radiusLg))
            .background(t.surface100)
            .semantics { liveRegion = LiveRegionMode.Polite }
            .padding(horizontal = Metrics.space(3), vertical = Metrics.space(2.5f)),
        verticalArrangement = Arrangement.spacedBy(Metrics.space(1)),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(Metrics.space(2)), verticalAlignment = Alignment.CenterVertically) {
            Icon(ClaveIcon.ExclamationTriangle, contentDescription = null, tint = c.shared.destructive, size = Metrics.chatGlyph)
            // The red is the triangle's; the words take the primary ink, readable in every theme.
            BasicText("Delivery unknown", style = ClaveTypography.type(Metrics.textControl).copy(color = c.theme.textPrimary))
        }
        BasicText(
            send.text,
            style = ClaveTypography.type(Metrics.textXs, lineHeight = Metrics.proseLineHeight).copy(color = t.textSecondary),
            maxLines = 3,
            overflow = TextOverflow.Ellipsis,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(Metrics.space(4))) {
            BasicText("Send again (may duplicate)", modifier = Modifier.clickable(role = Role.Button, onClick = onResend), style = link)
            BasicText("Discard", modifier = Modifier.clickable(role = Role.Button, onClick = onDiscard), style = link)
        }
    }
}

/** "Add to the message": photos, the camera, a document. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AttachSheet(onDismiss: () -> Unit, onPickPhotos: () -> Unit, onTakePhoto: () -> Unit, onPickDocuments: () -> Unit) {
    val t = Clave.colors.theme
    ModalBottomSheet(onDismissRequest = onDismiss, containerColor = t.surfaceRaised) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().padding(bottom = Metrics.space(4))) {
            listOf(
                Triple("Photos", ClaveIcon.Photo, onPickPhotos),
                Triple("Camera", ClaveIcon.Camera, onTakePhoto),
                Triple("Document", ClaveIcon.Document, onPickDocuments),
            ).forEach { (label, icon, action) ->
                ListRow(
                    title = label,
                    leading = { Icon(icon, contentDescription = null, tint = t.textSecondary) },
                    trailing = {},
                    onClick = {
                        onDismiss()
                        action()
                    },
                )
            }
            ListRow(title = "Cancel", trailing = {}, onClick = onDismiss)
        }
    }
}
