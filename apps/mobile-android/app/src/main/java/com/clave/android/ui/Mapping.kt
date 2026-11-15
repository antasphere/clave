package com.clave.android.ui

import com.clave.core.auth.AuthPhase
import com.clave.core.auth.AuthStatus
import com.clave.core.chat.DeliveryMark
import com.clave.core.chat.UnknownSend
import com.clave.core.chat.attachmentKind
import com.clave.core.chat.groupEntries
import com.clave.core.chat.hasMore
import com.clave.core.chat.markerOf
import com.clave.core.chat.phoneSessionState
import com.clave.core.chat.visibleEntries
import com.clave.core.contract.AgentState
import com.clave.core.contract.Attachment
import com.clave.core.contract.FileAttachment
import com.clave.core.contract.LaunchProfilePreferencesView
import com.clave.core.contract.LaunchProfileView
import com.clave.core.contract.RequestKind
import com.clave.core.contract.SessionAttachment
import com.clave.core.notifications.DeepLink
import com.clave.core.notifications.InitialRoute
import com.clave.core.state.ConversationState
import com.clave.core.state.StoreState
import com.clave.core.state.chatProfilesOf
import com.clave.core.state.conversationKey
import com.clave.core.state.orderProfiles
import com.clave.ui.screens.AccountState
import com.clave.ui.screens.ChatComposerState
import com.clave.ui.screens.ChatScreenState
import com.clave.ui.screens.LaunchScreenState
import com.clave.ui.screens.MachineRow
import com.clave.ui.screens.MachinesScreenState
import com.clave.ui.screens.RequestsScreenState
import com.clave.ui.screens.UnknownSendView
import com.clave.ui.screens.basename
import com.clave.ui.screens.isChatProfile
import com.clave.ui.screens.toReachability
import com.clave.ui.screens.toStatus
import com.clave.ui.theme.Reachability

/*
 * From the store's and the sign-in's values to the screens' states, as pure functions: no
 * Android type, no clock read, no store touched. The screens draw what these answer and
 * nothing else, so a JVM test of these functions is a test of what the person sees.
 */

/** What one open conversation's composer holds beside the store: the chat's own state. */
data class ChatSessionState(
    val draft: String = "",
    val attachments: List<Attachment> = emptyList(),
    val sending: Boolean = false,
    val attaching: Boolean = false,
    /** The last send's or attachment's sentence: a refusal, a note, a failure. */
    val error: String? = null,
    /** The send of this conversation whose delivery the phone could not confirm. */
    val unknownSend: UnknownSend? = null,
    val deliveryMark: DeliveryMark? = null,
    val expanded: Set<String> = emptySet(),
    /** The session's provider takes pictures; false until the server said so. */
    val imagesSupported: Boolean = false,
    /** The machine's server has the files route; true until an upload says it has none. */
    val filesRoute: Boolean = true,
)

/** The sentence a refused relay address shows on the Machines screen: the core's own words. */
fun relayErrorOf(error: Throwable): String = error.message?.takeIf { it.isNotEmpty() } ?: "The relay address could not be saved."

/**
 * The Machines screen: the account as the sign-in says it (its last failure by its wire
 * word), the team relay's address as typed, and every machine with whether this phone holds
 * a credential for it, whether it is the main one, and the reachability the phone measured;
 * null until the phone has tried, so the relay's online flag stands in. [relayError], a
 * refused relay address, wins over the store's own error.
 */
fun machinesState(
    store: StoreState,
    auth: AuthStatus,
    paired: Set<String>,
    relayUrl: String,
    signingOut: Boolean,
    now: Long,
    relayError: String? = null,
): MachinesScreenState = MachinesScreenState(
    account = AccountState(
        signedIn = auth.account != null,
        name = auth.account?.name,
        email = auth.account?.email,
        signingIn = auth.phase == AuthPhase.SigningIn,
        signingOut = signingOut,
        relayUrl = relayUrl,
        lastFailure = auth.lastFailure?.wire,
    ),
    machines = store.machines.map { m ->
        MachineRow(
            machine = m,
            paired = m.id in paired,
            main = m.id == store.mainMachineId,
            reachability = store.reachability[m.id]?.toReachability(),
        )
    },
    loading = store.machinesLoading,
    error = relayError ?: store.machinesError,
    now = now,
)

/** The pending requests of a machine, as its last snapshot listed them; none before one. */
internal fun pendingOf(store: StoreState, machineId: String) = store.requests[machineId]?.snapshot?.pending.orEmpty()

internal fun reachabilityOf(store: StoreState, machineId: String): Reachability =
    store.reachability[machineId]?.toReachability() ?: Reachability.Connecting

/** The machine whose saved profiles the launch form lists: the main one when it is listed, else the target. */
fun launchSourceOf(store: StoreState, machineId: String): String {
    val main = store.mainMachineId
    return if (main != null && store.machines.any { it.id == main }) main else machineId
}

/**
 * Every profile the launch form offers: the chat profiles as the quick composer lists them
 * (the built-ins, each saved profile's chat twin, the saved chats), then the saved terminal
 * profiles by name.
 */
fun launchProfilesOf(prefs: LaunchProfilePreferencesView): List<LaunchProfileView> =
    chatProfilesOf(prefs) + orderProfiles(prefs.customProfiles.filterNot(::isChatProfile))

/**
 * The launch form on [machineId]: the source machine's profiles (launchProfilesOf), chats
 * first; [starting] the profile being started, [refusal] the server's own sentence.
 */
fun launchState(
    store: StoreState,
    machineId: String,
    workspaceId: String,
    starting: String?,
    refusal: String?,
): LaunchScreenState {
    val source = launchSourceOf(store, machineId)
    return LaunchScreenState(
        workspaceName = store.workspaces[machineId]?.firstOrNull { it.id == workspaceId }?.name,
        targetName = store.machines.firstOrNull { it.id == machineId }?.name,
        sourceName = store.machines.firstOrNull { it.id == source }?.name,
        profiles = store.profiles[source]?.let { launchProfilesOf(it) },
        error = store.profilesError[source],
        starting = starting,
        refusal = refusal,
    )
}

/** A machine's pending requests; loading until the first answer is in. */
fun requestsState(
    store: StoreState,
    machineId: String,
    busy: Set<String>,
    notices: Map<String, String>,
): RequestsScreenState {
    val requests = store.requests[machineId]
    return RequestsScreenState(
        machineName = store.machines.firstOrNull { it.id == machineId }?.name,
        loading = requests == null || requests.loading,
        unavailable = requests?.unavailable ?: false,
        error = requests?.error,
        pending = requests?.snapshot?.pending.orEmpty(),
        busy = busy,
        notices = notices,
    )
}

/** An attachment as its chip says it: its marker ("[Image #1]") or its kind, then its name. */
fun attachmentChip(a: Attachment): String = when (a) {
    is FileAttachment -> "${markerOf(a) ?: attachmentKind(a).word} ${a.name}"
    is SessionAttachment -> "${markerOf(a) ?: "Session"} ${a.name}"
}

/**
 * Whether a conversation has ended: its process exited (an exit code, which the reducer
 * also records as [AgentState.Ended]) or its stream carried a fatal error (the reducer sets
 * Ended). [AgentState.Done] is not an end: the server reports it when a turn finishes and
 * the desktop reads it as idle, so the composer stays open for the next message.
 */
fun conversationEnded(state: ConversationState): Boolean =
    state.conversation.exitCode != null || state.conversation.state == AgentState.Ended

/**
 * One conversation: the transcript grouped as the desktop groups it, the session's state
 * with the fatal error folded in (the session list's state until the first page is in), the
 * page cursor, the composer, the send whose delivery is unknown (hidden while a send is in
 * flight, which records one of its own), and the requests of this session waiting on the
 * person, labelled by the kind of the first: an approval or an answer. [title] is the route's,
 * used until the session list names the session.
 */
fun chatState(
    store: StoreState,
    machineId: String,
    sessionId: String,
    chat: ChatSessionState,
    now: Long,
    title: String? = null,
): ChatScreenState {
    val key = conversationKey(machineId, sessionId)
    val conversationState = store.conversations[key] ?: ConversationState()
    val conversation = conversationState.conversation
    val cursor = conversationState.cursor
    val session = store.sessions[machineId]?.firstOrNull { it.id == sessionId }
    val serverState = if (cursor.loaded || session == null) conversation.state else session.state
    val waiting = pendingOf(store, machineId).filter { it.sessionId == sessionId }
    val mark = chat.deliveryMark?.takeIf { !chat.sending }
    return ChatScreenState(
        title = session?.let { it.title.ifEmpty { basename(it.cwd) } } ?: title?.takeIf { it.isNotEmpty() } ?: "Chat",
        machineName = store.machines.firstOrNull { it.id == machineId }?.name,
        provider = session?.provider ?: "",
        blocks = groupEntries(visibleEntries(conversation.entries)),
        status = phoneSessionState(serverState, store.fatal[key]).toStatus(),
        reachability = reachabilityOf(store, machineId),
        loaded = cursor.loaded,
        hasOlder = hasMore(cursor),
        loadingOlder = cursor.loading,
        error = chat.error ?: conversationState.error,
        ended = conversationEnded(conversationState),
        exitCode = conversation.exitCode,
        working = conversation.state == AgentState.Working,
        composer = ChatComposerState(
            text = chat.draft,
            attachments = chat.attachments.map(::attachmentChip),
            sending = chat.sending,
            deliveryMark = when (mark?.kind) {
                null -> null
                DeliveryMark.Kind.Unknown -> mark.reason
                DeliveryMark.Kind.Rejected -> "Not delivered: ${mark.reason}"
            },
        ),
        unknownSend = chat.unknownSend?.takeIf { !chat.sending }?.let { UnknownSendView(it.text) },
        pendingRequests = waiting.size,
        pendingLabel = waiting.firstOrNull()?.let {
            if (it.kind == RequestKind.Permission) "Waiting for your approval" else "Waiting for your answer"
        },
        expanded = chat.expanded,
        now = now,
    )
}

/** The route a link opens on a warm app: the screen it names, the back stack kept. */
fun routeFor(link: DeepLink): String = when (link) {
    is DeepLink.Chat -> Routes.chat(link.machineId, link.sessionId, link.title)
    is DeepLink.Requests -> Routes.requests(link.machineId, link.requestId)
    is DeepLink.Workspaces -> Routes.home(link.machineId)
    is DeepLink.Machines -> Routes.MACHINES
}

/**
 * The routes a cold launch opens, root first: Machines, then the Home of the current machine
 * (the core names it Workspaces, the screen it replaced), then the conversation or the
 * requests of a link. A route of a name this app does not know, or missing its machine, is
 * skipped rather than guessed. The app drops Machines under a Home, so back from Home leaves.
 */
fun routesFor(initial: InitialRoute): List<String> = initial.routes.mapNotNull { route ->
    val machineId = route.params["machineId"]
    when (route.name) {
        "Machines" -> Routes.MACHINES
        "Workspaces" -> machineId?.let(Routes::home)
        "Chat" -> {
            val sessionId = route.params["sessionId"]
            if (machineId != null && sessionId != null) Routes.chat(machineId, sessionId, route.params["title"]) else null
        }
        "Requests" -> machineId?.let { Routes.requests(it, route.params["requestId"]) }
        else -> null
    }
}
