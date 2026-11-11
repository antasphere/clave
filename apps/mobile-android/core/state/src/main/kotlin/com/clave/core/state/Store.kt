package com.clave.core.state

import com.clave.core.chat.Action
import com.clave.core.chat.BufferedItem
import com.clave.core.chat.Conversation
import com.clave.core.chat.DeliveryController
import com.clave.core.chat.HistoryCursor
import com.clave.core.chat.Reachability
import com.clave.core.chat.SendFailure
import com.clave.core.chat.SendOptions
import com.clave.core.chat.SendOutcome
import com.clave.core.chat.SendPorts
import com.clave.core.chat.TimelineChanged
import com.clave.core.chat.UnknownSend
import com.clave.core.chat.applyFirstPage
import com.clave.core.chat.applyOlderPage
import com.clave.core.chat.buildUserMessage
import com.clave.core.chat.emptyConversation
import com.clave.core.chat.freshCursor
import com.clave.core.chat.mergeBufferedHistory
import com.clave.core.chat.reduceConversation
import com.clave.core.chat.sendMessage
import com.clave.core.chat.shouldLoadOlder
import com.clave.core.contract.Attachment
import com.clave.core.contract.FileText
import com.clave.core.contract.HistoryItem
import com.clave.core.contract.HistoryPage
import com.clave.core.contract.Interrupt
import com.clave.core.contract.LaunchProfilePreferencesView
import com.clave.core.contract.LaunchProfileView
import com.clave.core.contract.LauncherFamily
import com.clave.core.contract.PermissionResponse
import com.clave.core.contract.RequestResponse
import com.clave.core.contract.RequestSnapshot
import com.clave.core.contract.ResolveOutcome
import com.clave.core.contract.ServerEvent
import com.clave.core.contract.ServerEventEnvelope
import com.clave.core.contract.Session
import com.clave.core.contract.SessionInfo
import com.clave.core.contract.SessionPosition
import com.clave.core.contract.SessionStream
import com.clave.core.contract.SpawnOptions
import com.clave.core.contract.StartSessionInput
import com.clave.core.contract.WorkspaceView
import com.clave.core.devices.Machine
import com.clave.core.transport.ClavePushClient
import com.clave.core.transport.ClaveServerClient
import com.clave.core.transport.PushState
import com.clave.core.transport.PushStatus
import com.clave.core.transport.PushStatusDetail
import com.clave.core.transport.ServerError
import com.clave.core.transport.messageOf
import java.text.Collator
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import com.clave.core.transport.Credential as TransportCredential

/** One machine's live clients. A socket is not data: connections live beside the state. */
public class Connection internal constructor(
    public val machine: Machine,
    public val client: ClaveServerClient,
    public val push: ClavePushClient,
    internal val release: () -> Unit,
)

public data class ConversationState(
    val conversation: Conversation = emptyConversation,
    val cursor: HistoryCursor = freshCursor,
    val error: String? = null,
    /** The push subscription is live for this conversation. */
    val subscribed: Boolean = false,
)

public data class RequestsState(
    val snapshot: RequestSnapshot?,
    /** The server has no requests port (an in-process server): the chat's own permission
     *  cards are the way to answer. */
    val unavailable: Boolean,
    val error: String?,
    val loading: Boolean,
)

/** A plain send refused while the conversation's last message is still being written. */
public const val STILL_SENDING: String = "The last message is still being sent."

/** A plain send refused while the conversation's last message has an unknown delivery. */
public const val DELIVERY_UNKNOWN_FIRST: String =
    "The last message's delivery is unknown. Choose Send again or Discard first."

/** "Send again" or "Discard" once the reconnection's same-id completion of that message has left. */
public const val BEING_COMPLETED: String =
    "The reconnection is already sending this message again under its own id; it can no longer be discarded or sent anew."

/** "Send again" when the server had accepted the first message before the choice: nothing new goes. */
public const val ARRIVED_NOTHING_SENT: String = "The first message had already arrived, so nothing was sent again."

/** "Send again" on a message no longer waiting, whose settling is not known here. */
public const val NOTHING_WAITING: String = "That message is no longer waiting, so nothing was sent again."

/** "Discard" when the server had accepted the message before the choice. */
public const val ARRIVED_NOTHING_DISCARDED: String = "The message had already arrived, so nothing was discarded."

/** "Send again" or "Discard" when the phone could not record the choice: the message still waits, as before. */
public const val CHOICE_NOT_SAVED: String = "The phone could not save that choice, so nothing was discarded or sent again. Try again."

/** The outcome of an answer or an interrupt written into a session. */
public data class ActionOutcome(val ok: Boolean, val error: String? = null)

public fun conversationKey(machineId: String, sessionId: String): String = "$machineId\u0000$sessionId"

public data class StoreState(
    val machines: List<Machine> = emptyList(),
    val machinesLoading: Boolean = false,
    val machinesError: String? = null,
    val mainMachineId: String? = null,
    val reachability: Map<String, Reachability> = emptyMap(),
    val workspaces: Map<String, List<WorkspaceView>> = emptyMap(),
    val workspacesError: Map<String, String?> = emptyMap(),
    val sessions: Map<String, List<Session>> = emptyMap(),
    val sessionsError: Map<String, String?> = emptyMap(),
    /** machine id → session id → the authoritative stamp from the latest session list. */
    val stamps: Map<String, Map<String, String?>> = emptyMap(),
    /** Conversation key → the last fatal error its stream carried. */
    val fatal: Map<String, String> = emptyMap(),
    val conversations: Map<String, ConversationState> = emptyMap(),
    val requests: Map<String, RequestsState> = emptyMap(),
    val profiles: Map<String, LaunchProfilePreferencesView?> = emptyMap(),
    val profilesError: Map<String, String?> = emptyMap(),
)

private fun familyOptions(family: LauncherFamily): SpawnOptions = when (family) {
    LauncherFamily.Claude -> SpawnOptions(claudeMode = true)
    LauncherFamily.Codex -> SpawnOptions(codexMode = true)
    LauncherFamily.Pi -> SpawnOptions(piMode = true)
    LauncherFamily.Antigravity -> SpawnOptions(antigravityMode = true)
}

/** The start payload the phone sends: the family boolean, the profile by id and its full
 *  definition (the seam the Mac uses for a server today), and the workspace. The target's
 *  accounts stay its own: none is carried. */
public fun startPayload(workspace: WorkspaceView, profile: LaunchProfileView): StartSessionInput =
    StartSessionInput(
        cwd = workspace.rootDir,
        options = familyOptions(profile.family).copy(
            launchProfileId = profile.id,
            launchProfile = LaunchProfileView(
                id = profile.id,
                name = profile.name,
                family = profile.family,
                command = profile.command.toList(),
                additionalArgs = profile.additionalArgs.toList(),
                sourceProfileId = profile.sourceProfileId?.takeIf { it.isNotEmpty() },
                pi = profile.pi,
            ),
            workspaceId = workspace.id,
        ),
    )

/** Whether the machine answers, read off the push channel's state. A token the server
 *  refused (4001) or a device session revoked on the machine (4011) is a refusal. */
public fun reachabilityOf(state: PushState): Reachability = when (state.status) {
    PushStatus.Open -> Reachability.Reachable
    PushStatus.Connecting, PushStatus.Idle -> Reachability.Connecting
    PushStatus.Reconnecting -> Reachability.Unreachable
    PushStatus.Closed -> when (state.detail.final) {
        PushStatusDetail.Final.Unauthorized, PushStatusDetail.Final.Revoked -> Reachability.Refused
        else -> Reachability.Unreachable
    }
}

private val nameOrder: Collator = Collator.getInstance(Locale.ROOT)

/** Chats first, then the rest, each group by name: the launch form's order. */
public fun orderProfiles(profiles: List<LaunchProfileView>): List<LaunchProfileView> {
    fun isChat(p: LaunchProfileView): Boolean =
        p.id == "claude-chat" || p.id == "codex-chat" || p.id.startsWith("chat:") || p.id == "dev-echo-adapter"
    return profiles.sortedWith(compareBy<LaunchProfileView> { if (isChat(it)) 0 else 1 }.thenComparator { a, b -> nameOrder.compare(a.name, b.name) })
}

/**
 * The transport's error as the send table reads it. The table retries nothing but a lost
 * answer (network, timeout, unreadable), so the kind decides what happens next:
 *
 * - a 403 (the device-session boundary) becomes [SendFailure.Kind.Policy]: the table ends
 *   it [SendOutcome.Failed] with the server's own sentence, without asking the status
 *   route, without a second write. Refused would end Unknown or Rejected, and Network,
 *   Timeout or Protocol would ask the server again; neither is true of a boundary.
 * - every other kind keeps its name, with the status and the declared failure's tag.
 */
internal fun ServerError.toSendFailure(): SendFailure = SendFailure(
    kind = when (kind) {
        ServerError.Kind.Unauthenticated -> SendFailure.Kind.Unauthenticated
        ServerError.Kind.Forbidden -> SendFailure.Kind.Policy
        ServerError.Kind.Refused -> SendFailure.Kind.Refused
        ServerError.Kind.Network -> SendFailure.Kind.Network
        ServerError.Kind.Timeout -> SendFailure.Kind.Timeout
        ServerError.Kind.Protocol -> SendFailure.Kind.Protocol
        ServerError.Kind.Policy -> SendFailure.Kind.Policy
    },
    message = message ?: "",
    status = status,
    failureTag = failure?.tag,
    cause = this,
)

private suspend fun <T> asSendCall(block: suspend () -> T): T = try {
    block()
} catch (e: ServerError) {
    throw e.toSendFailure()
}

/**
 * The phone's one store (store.ts): the machines and their reachability, each machine's
 * workspaces, sessions and pending requests, the open conversations with their page
 * cursors, and the actions that move them through the server client and the push client of
 * each machine. [state] is one immutable value, replaced whole on every change, so a
 * screen never reads half an update.
 *
 * Nothing here retries a 403: the boundary of a device session is surfaced in the matching
 * error field in the server's words, once, with no second call and no other credential.
 */
public class ClaveStore(private val services: Services) {
    private val _state = MutableStateFlow(StoreState())
    public val state: StateFlow<StoreState> = _state.asStateFlow()

    private val scope = services.scope
    private val log = services.log
    private val connections = ConcurrentHashMap<String, Connection>()
    private val connectionsLock = Any()
    private val openChats = ConcurrentHashMap<String, OpenChat>()
    private val requestLoads = ConcurrentHashMap<String, Int>()

    /** For the tests, which seed a sibling machine's state as store.test.ts's setState did. */
    internal fun update(transform: (StoreState) -> StoreState) {
        _state.update(transform)
    }

    private fun fail(error: Throwable): String {
        if (error is ServerError && error.kind == ServerError.Kind.Forbidden) {
            log.event("store.forbidden", mapOf("status" to error.status))
        }
        return messageOf(error)
    }

    private fun conversationOf(state: StoreState, key: String): ConversationState =
        state.conversations[key] ?: ConversationState()

    private fun setConversation(key: String, change: (ConversationState) -> ConversationState) =
        _state.update { it.copy(conversations = it.conversations + (key to change(conversationOf(it, key)))) }

    private fun applySessionEvent(machineId: String, envelope: ServerEventEnvelope) {
        when (val event = envelope.event) {
            is ServerEvent.SessionStateChanged -> _state.update { s ->
                val sessions = s.sessions[machineId] ?: return@update s
                s.copy(sessions = s.sessions + (machineId to sessions.map { if (it.id == event.id) it.copy(state = event.state) else it }))
            }
            is ServerEvent.SessionTitleChanged -> retitle(machineId, event.id, event.title)
            is ServerEvent.SessionRenamed -> retitle(machineId, event.id, event.name)
            is ServerEvent.RequestsChanged -> scope.launch { loadRequests(machineId) }
            is ServerEvent.WorkspacesStateChanged ->
                _state.update { it.copy(workspaces = it.workspaces + (machineId to event.workspaces.toList())) }
            is ServerEvent.Unknown -> Unit
        }
    }

    private fun retitle(machineId: String, id: String, title: String) = _state.update { s ->
        val sessions = s.sessions[machineId] ?: return@update s
        s.copy(sessions = s.sessions + (machineId to sessions.map { if (it.id == id) it.copy(title = title) else it }))
    }

    // ── machines ──

    public suspend fun loadMachines() {
        _state.update { it.copy(machinesLoading = true, machinesError = null) }
        val found = mutableListOf<Machine>()
        val problems = mutableListOf<String>()
        for (source in listOfNotNull(services.relaySource, services.developerSource)) {
            try {
                found += source.list()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                problems += fail(e)
            }
        }
        val main = services.credentials.mainMachineId()
        _state.update {
            it.copy(
                machines = found.toList(),
                machinesLoading = false,
                machinesError = if (problems.isEmpty()) null else problems.joinToString(" "),
                mainMachineId = main ?: found.firstOrNull()?.id,
            )
        }
    }

    public suspend fun addDeveloperMachine(serverUrl: String, token: String, name: String? = null): Machine {
        val developer = services.developerSource
            ?: throw IllegalStateException("The developer connection exists in development builds only.")
        val machine = if (name == null) developer.add(serverUrl, token) else developer.add(serverUrl, token, name)
        loadMachines()
        return machine
    }

    public suspend fun removeDeveloperMachine(machineId: String) {
        disconnect(machineId)
        services.developerSource?.remove(machineId)
        loadMachines()
    }

    public suspend fun setMainMachine(machineId: String) {
        services.credentials.setMainMachineId(machineId)
        _state.update { it.copy(mainMachineId = machineId) }
    }

    // ── connections ──

    /** The machine's clients, made once: parallel callers share one socket. */
    public suspend fun connect(machineId: String): Connection {
        connections[machineId]?.let { return it }
        val machine = _state.value.machines.firstOrNull { it.id == machineId }
            ?: throw IllegalStateException("That machine is not in the list.")
        val credential = services.credentials.get(machineId)
        val connection = synchronized(connectionsLock) {
            connections[machineId]?.let { return it }
            if (credential == null) throw IllegalStateException("No credential is kept for ${machine.name}.")
            val client = ClaveServerClient(TransportCredential(machine.baseUrl, credential.bearer), services.http, services.build)
            val push = ClavePushClient(
                url = machine.pushUrl,
                token = credential.bearer,
                sockets = services.sockets,
                scope = scope,
                build = services.build,
                clientName = services.clientName,
                backoffBaseMs = services.push.backoffBaseMs,
                backoffMaxMs = services.push.backoffMaxMs,
                livenessIntervalMs = services.push.livenessIntervalMs,
                livenessTimeoutMs = services.push.livenessTimeoutMs,
                log = log,
            )
            val offStatus = push.onStatus { status -> onPushStatus(machineId, client, status) }
            // Undispatched: the collector is subscribed before the socket can deliver an event.
            val events = scope.launch(start = CoroutineStart.UNDISPATCHED) {
                push.events.collect { applySessionEvent(machineId, it) }
            }
            Connection(machine, client, push) {
                offStatus()
                events.cancel()
                push.close()
            }.also { connections[machineId] = it }
        }
        _state.update { it.copy(reachability = it.reachability + (machineId to Reachability.Connecting)) }
        connection.push.connect()
        return connection
    }

    /** Runs under the push client's lock on a socket thread: nothing here blocks. */
    private fun onPushStatus(machineId: String, client: ClaveServerClient, status: PushState) {
        _state.update { it.copy(reachability = it.reachability + (machineId to reachabilityOf(status))) }
        if (status.status != PushStatus.Open) return
        // One ask of the requests per Open: the reconnection pass joins it rather than asking
        // again, so a refusal (a 403) is heard once.
        val requests: Deferred<Unit> = scope.async { loadRequests(machineId) }
        // Each open chat starts buffering now, before any frame of the new socket, and awaits
        // this socket's acknowledgement before its snapshot.
        val open = openChats.values.filter { it.machineId == machineId }
        val refreshes = open.map { it.refresh() }
        val history: Deferred<Unit> = scope.async { refreshes.awaitAll(); Unit }
        val delivery = services.delivery ?: return
        scope.launch {
            try {
                delivery.reconnect(
                    machineId = machineId,
                    openConversations = open.map { it.sessionId },
                    write = { send ->
                        asSendCall {
                            client.sessions.write(
                                send.sessionId,
                                buildUserMessage(send.text, send.attachments ?: emptyList(), send.clientMessageId),
                            )
                        }
                    },
                    status = { send -> asSendCall { client.sessions.writeStatus(send.sessionId, send.clientMessageId) } },
                    refreshRequests = { requests.await() },
                    refreshHistory = { _, _ -> history.await() },
                )
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val message = fail(e)
                _state.update { it.copy(sessionsError = it.sessionsError + (machineId to message)) }
            }
        }
    }

    public fun disconnect(machineId: String) {
        for (open in openChats.values.toList()) if (open.machineId == machineId) open.close()
        val connection = synchronized(connectionsLock) { connections.remove(machineId) } ?: return
        connection.release()
        val prefix = "$machineId\u0000"
        _state.update { s ->
            s.copy(conversations = s.conversations.mapValues { (key, c) -> if (key.startsWith(prefix)) c.copy(subscribed = false) else c })
        }
    }

    public fun disconnectAll() {
        for (id in connections.keys.toList()) disconnect(id)
    }

    // ── lists ──

    public suspend fun loadWorkspaces(machineId: String) {
        try {
            val client = connect(machineId).client
            val loaded = client.workspaces.load()
            _state.update {
                it.copy(
                    workspaces = it.workspaces + (machineId to loaded.workspaces.toList()),
                    workspacesError = it.workspacesError + (machineId to null),
                )
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val message = fail(e)
            _state.update { it.copy(workspacesError = it.workspacesError + (machineId to message)) }
        }
    }

    /** The list and its stamps replace the previous ones in one publication; a failed
     *  refresh keeps the last complete list. */
    public suspend fun loadSessions(machineId: String) {
        try {
            val client = connect(machineId).client
            val sessions = client.sessions.list()
            val stamps = LinkedHashMap<String, String?>()
            for (session in sessions) stamps[session.id] = session.workspaceId
            _state.update {
                it.copy(
                    sessions = it.sessions + (machineId to sessions),
                    stamps = it.stamps + (machineId to stamps.toMap()),
                    sessionsError = it.sessionsError + (machineId to null),
                )
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val message = fail(e)
            _state.update { it.copy(sessionsError = it.sessionsError + (machineId to message)) }
        }
    }

    // ── conversations ──

    /**
     * One open conversation and its subscription barrier. Frames arrive on the push
     * client's thread, the snapshot on a coroutine; [lock] orders them as JavaScript's
     * single thread ordered the original.
     */
    private inner class OpenChat(
        val machineId: String,
        val sessionId: String,
        val key: String,
        val client: ClaveServerClient,
        val push: ClavePushClient,
    ) {
        private val lock = Any()
        @Volatile var active = true
            private set
        private var buffering = true
        private var buffered = mutableListOf<BufferedItem>()
        private var watermark: SessionPosition? = null
        private var exitCode: Int? = null
        private var inFlight: Deferred<Unit>? = null
        var off: () -> Unit = {}

        fun position(): SessionPosition? = synchronized(lock) { watermark }

        private fun publish(conversation: Conversation) {
            if (!active) return
            _state.update { s ->
                val next = s.copy(conversations = s.conversations + (key to conversationOf(s, key).copy(conversation = conversation)))
                val fatal = conversation.fatal
                if (fatal != null && s.fatal[key] == null) next.copy(fatal = next.fatal + (key to fatal)) else next
            }
        }

        /** A fresh snapshot behind the barrier; a second ask joins the one in flight. */
        fun refresh(): Deferred<Unit> = synchronized(lock) {
            if (!active) return CompletableDeferred(Unit)
            inFlight?.let { return it }
            buffering = true
            buffered = mutableListOf()
            val job = scope.async(start = CoroutineStart.LAZY) { run() }
            inFlight = job
            job.invokeOnCompletion { synchronized(lock) { if (inFlight === job) inFlight = null } }
            job.start()
            job
        }

        private suspend fun run() {
            try {
                // The ack means the server has bound its listeners, before taking the snapshot.
                push.subscribed(sessionId)
                for (attempt in 0 until 3) {
                    if (!active) return
                    val page = client.sessions.timeline(sessionId)
                    val done = synchronized(lock) {
                        if (!active) return
                        try {
                            val joined = mergeBufferedHistory(page, buffered)
                            val applied = applyFirstPage(emptyConversation, joined)
                            watermark = buffered.fold(page.cursor) { position, item ->
                                val at = item.position
                                if (at != null && at.sequence > position.sequence) at else position
                            }
                            buffering = false
                            buffered = mutableListOf()
                            setConversation(key) { it.copy(cursor = applied.cursor, error = null) }
                            val code = exitCode
                            publish(if (code == null) applied.conversation else reduceConversation(applied.conversation, Action.Exit(code)))
                            true
                        } catch (e: TimelineChanged) {
                            if (attempt == 2) throw e
                            // The next snapshot starts after all frames buffered so far.
                            buffered = mutableListOf()
                            false
                        }
                    }
                    if (done) return
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (active) {
                    val message = fail(e)
                    setConversation(key) { it.copy(error = message) }
                }
            } finally {
                synchronized(lock) {
                    buffering = false
                    buffered = mutableListOf()
                }
            }
        }

        fun onStream(stream: SessionStream) {
            synchronized(lock) { receive(stream) }
        }

        private fun receive(stream: SessionStream) {
            if (!active || stream !is SessionStream.Event) return
            val item = BufferedItem(stream.event, services.clock.now(), stream.position)
            val position = item.position
            if (buffering) {
                val latest = buffered.lastOrNull { it.position != null }?.position
                if (latest != null && position != null && latest.generation != position.generation) buffered = mutableListOf()
                buffered.add(item)
                return
            }
            if (position != null) {
                val mark = watermark
                if (mark == null || position.generation != mark.generation || position.sequence > mark.sequence + 1) {
                    // Out of order or another generation: a fresh snapshot, this frame its first buffered one.
                    refresh()
                    buffered.add(item)
                    return
                }
                if (position.sequence <= mark.sequence) return
                watermark = position
            }
            publish(reduceConversation(conversationOf(_state.value, key).conversation, Action.Event(item.event, item.at)))
        }

        fun onExit(code: Int) {
            synchronized(lock) {
                if (!active) return
                exitCode = code
                publish(reduceConversation(conversationOf(_state.value, key).conversation, Action.Exit(code)))
            }
        }

        fun close() {
            synchronized(lock) {
                if (!active) return
                active = false
            }
            off()
            openChats.remove(key, this)
            setConversation(key) { it.copy(subscribed = false) }
        }
    }

    /**
     * Opens a conversation: subscribes, then awaits the server's acknowledgement of THIS
     * socket's subscription before the first timeline snapshot, buffering the live frames
     * meanwhile and joining them to the snapshot by position. Answers the close.
     */
    public suspend fun openChat(machineId: String, sessionId: String): () -> Unit {
        val key = conversationKey(machineId, sessionId)
        // A second mount adopts a fresh subscription; an old async page cannot overwrite it.
        openChats[key]?.close()
        val connection = connect(machineId)
        openChats[key]?.close()
        val open = OpenChat(machineId, sessionId, key, connection.client, connection.push)
        openChats[key] = open
        open.off = connection.push.subscribe(sessionId, open::onStream, open::onExit)
        setConversation(key) { it.copy(subscribed = true, error = null) }
        open.refresh().await()
        return open::close
    }

    /** Refreshes only the conversations open on this machine. Never dispatches a draft. */
    public suspend fun refreshOpenHistory(machineId: String) {
        openChats.values.filter { it.machineId == machineId }.map { it.refresh() }.awaitAll()
    }

    public suspend fun loadOlder(machineId: String, sessionId: String) {
        val key = conversationKey(machineId, sessionId)
        val current = conversationOf(_state.value, key)
        val open = openChats[key] ?: return
        val before = current.cursor.before
        if (!shouldLoadOlder(current.cursor) || before == null) return
        val position = open.position()
        setConversation(key) { it.copy(cursor = current.cursor.copy(loading = true)) }
        try {
            val client = connect(machineId).client
            val page = client.sessions.timeline(sessionId, before)
            if (openChats[key] !== open) return
            if (page.cursor.generation != position?.generation) {
                open.refresh().await()
                return
            }
            val latest = conversationOf(_state.value, key)
            // A concurrent refresh has already replaced the page and its cursor.
            if (latest.cursor.before != before) return
            val applied = applyOlderPage(
                latest.conversation,
                HistoryPage(page.items.map { HistoryItem(it.event, it.at) }, page.before),
                page.truncated,
            )
            setConversation(key) { it.copy(conversation = applied.conversation, cursor = applied.cursor) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (openChats[key] !== open) return
            val message = fail(e)
            setConversation(key) { it.copy(cursor = it.cursor.copy(loading = false), error = message) }
        }
    }

    // ── writes ──

    /**
     * One send under an id the phone minted (or the one given); the outcome follows the
     * table of the chat module's `sendMessage`. The ledger entry goes in before the write,
     * the settlement after it; the draft is cleared on `sent` only, and only when it is
     * still the text sent.
     *
     * While the conversation has a send whose outcome is not settled (its write in flight, or
     * its outcome unknown), a new send is refused before any id is minted or any request
     * leaves: a new id would be a second logical message the person never confirmed. That
     * send is settled under its own id, by its sender or by the reconnection pass; the person
     * may choose [resend] or [discardUnknown]. The draft is left as it is.
     */
    public suspend fun send(
        machineId: String,
        sessionId: String,
        text: String,
        clientMessageId: String? = null,
        attachments: List<Attachment> = emptyList(),
    ): SendOutcome {
        val delivery = services.delivery ?: return sendAdmitted(machineId, sessionId, text, clientMessageId, attachments, null)
        // One send at a time per conversation, claimed before any check or id: two senders of
        // the same conversation (two screens, a tap racing a retry) cannot both pass the check
        // below before either has written its ledger entry.
        if (!delivery.claim(machineId, sessionId)) {
            return SendOutcome.Failed(delivery.unsettled(machineId, sessionId)?.clientMessageId ?: "", STILL_SENDING)
        }
        try {
            val pending = delivery.unsettled(machineId, sessionId)
            if (pending != null) {
                val reason = if (delivery.inFlight(pending.clientMessageId)) STILL_SENDING else DELIVERY_UNKNOWN_FIRST
                return SendOutcome.Failed(pending.clientMessageId, reason)
            }
            // A notice of unknown delivery a build before this one left without its send: nobody knows
            // whether that message arrived, so the person chooses (Send again or Discard) first.
            val orphan = delivery.orphan(machineId, sessionId)
            if (orphan != null) return SendOutcome.Failed(orphan.clientMessageId, DELIVERY_UNKNOWN_FIRST)
            return sendAdmitted(machineId, sessionId, text, clientMessageId, attachments, delivery)
        } finally {
            delivery.release(machineId, sessionId)
        }
    }

    /** The admitted send: its id minted, its ledger entry written before the write, settled after it. */
    private suspend fun sendAdmitted(
        machineId: String,
        sessionId: String,
        text: String,
        givenId: String?,
        attachments: List<Attachment>,
        delivery: DeliveryController?,
    ): SendOutcome {
        val clientMessageId = givenId ?: services.mintMessageId()
        val trimmed = text.trim()
        if (trimmed.isEmpty() && attachments.isEmpty()) return SendOutcome.Failed(clientMessageId, "Nothing to send.")
        val client = try {
            connect(machineId).client
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return SendOutcome.Failed(clientMessageId, fail(e))
        }
        val message = buildUserMessage(trimmed, attachments, clientMessageId)
        val send = UnknownSend(
            machineId = machineId,
            sessionId = sessionId,
            clientMessageId = clientMessageId,
            text = message.text,
            at = services.clock.now(),
            draftText = text,
            attachments = attachments.takeIf { it.isNotEmpty() },
        )
        try {
            delivery?.begin(send)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            return SendOutcome.Failed(clientMessageId, "The send could not be saved safely. Nothing was sent.")
        }
        val ports = object : SendPorts {
            override suspend fun write(clientMessageId: String) = asSendCall { client.sessions.write(sessionId, message) }
            override suspend fun status(clientMessageId: String) = asSendCall { client.sessions.writeStatus(sessionId, clientMessageId) }
            override suspend fun sleep(ms: Long) = services.sleep(ms)
            override fun now(): Long = services.clock.now()
        }
        val outcome = try {
            sendMessage(clientMessageId, ports, SendOptions())
        } catch (e: Throwable) {
            // Cancelled with the write out: its outcome is not known, so the entry stays for the
            // reconnection pass and only the in-flight mark goes.
            delivery?.abandon(send)
            throw e
        }
        if (outcome is SendOutcome.Failed) log.event("store.send_failed", mapOf("machine" to machineId))
        // What the controller could record: an end it failed to save is answered unknown, never settled.
        val reported = delivery?.finish(send, outcome) ?: outcome
        if (reported is SendOutcome.Sent && services.drafts.get(machineId, sessionId) == text) {
            services.drafts.clear(machineId, sessionId)
        }
        return reported
    }

    /**
     * "Send again (may duplicate)": the person's explicit choice on a send of unknown outcome.
     * The unknown send is discarded first, once any reconnection pass of the machine has
     * finished reconciling (so no pass completes it afterwards), and the text goes under a NEW
     * id. When that send was settled meanwhile (accepted, completed or refused by the pass),
     * nothing is sent again.
     */
    public suspend fun resend(
        machineId: String,
        sessionId: String,
        unknownId: String,
        text: String,
        attachments: List<Attachment> = emptyList(),
    ): SendOutcome {
        val delivery = services.delivery
        if (delivery != null) {
            when (delivery.discard(machineId, sessionId, unknownId)) {
                // A notice left without its send: cleared, the draft goes under a new id as the person chose.
                DeliveryController.DiscardResult.Discarded, DeliveryController.DiscardResult.OrphanCleared -> Unit
                // It arrived before the choice: the first id is the message, nothing more goes.
                DeliveryController.DiscardResult.AlreadyDelivered -> return SendOutcome.Sent(unknownId, reconciled = true)
                DeliveryController.DiscardResult.AlreadyRejected ->
                    return SendOutcome.Rejected(unknownId, delivery.marks.get(machineId, sessionId)?.reason ?: "The server refused the message.")
                DeliveryController.DiscardResult.BeingCompleted -> return SendOutcome.Failed(unknownId, BEING_COMPLETED)
                DeliveryController.DiscardResult.InFlight -> return SendOutcome.Failed(unknownId, STILL_SENDING)
                DeliveryController.DiscardResult.NothingToDiscard -> return SendOutcome.Failed(unknownId, NOTHING_WAITING)
                DeliveryController.DiscardResult.NotSaved -> return SendOutcome.Failed(unknownId, CHOICE_NOT_SAVED)
            }
        }
        return send(machineId, sessionId, text, attachments = attachments)
    }

    /**
     * "Discard": the person's explicit choice on a send of unknown outcome, decided at once: a
     * reconnection pass that has not sent the same-id completion will not send it. What the
     * server had answered before stands and is said (DeliveryController.DiscardResult); null
     * without a delivery ledger.
     */
    public suspend fun discardUnknown(machineId: String, sessionId: String, unknownId: String): DeliveryController.DiscardResult? =
        services.delivery?.discard(machineId, sessionId, unknownId)

    public suspend fun answerInChat(
        machineId: String,
        sessionId: String,
        requestId: String,
        optionId: String,
        answers: Map<String, String>? = null,
    ): ActionOutcome {
        val key = conversationKey(machineId, sessionId)
        return try {
            val client = connect(machineId).client
            client.sessions.write(sessionId, PermissionResponse(requestId, optionId, answers))
            setConversation(key) { it.copy(conversation = reduceConversation(it.conversation, Action.Answer(requestId, optionId, answers))) }
            ActionOutcome(ok = true)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            ActionOutcome(ok = false, error = fail(e))
        }
    }

    public suspend fun interrupt(machineId: String, sessionId: String): ActionOutcome = try {
        connect(machineId).client.sessions.write(sessionId, Interrupt)
        ActionOutcome(ok = true)
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        ActionOutcome(ok = false, error = fail(e))
    }

    // ── requests ──

    /** The pending requests; an answer older than a later ask's is dropped by generation. */
    public suspend fun loadRequests(machineId: String) {
        val generation = requestLoads.merge(machineId, 1) { a, b -> a + b }!!
        val current = _state.value.requests[machineId]
        patchRequests(machineId, RequestsState(current?.snapshot, current?.unavailable ?: false, null, true))
        try {
            val snapshot = connect(machineId).client.requests.list()
            if (requestLoads[machineId] != generation) return
            patchRequests(machineId, RequestsState(snapshot, unavailable = false, error = null, loading = false))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (requestLoads[machineId] != generation) return
            val unavailable = e is ServerError && e.capabilityUnavailable
            patchRequests(
                machineId,
                RequestsState(
                    snapshot = if (unavailable) RequestSnapshot(0, emptyList()) else current?.snapshot,
                    unavailable = unavailable,
                    error = if (unavailable) null else fail(e),
                    loading = false,
                ),
            )
        }
    }

    private fun patchRequests(machineId: String, value: RequestsState) =
        _state.update { it.copy(requests = it.requests + (machineId to value)) }

    public suspend fun resolveRequest(machineId: String, requestId: String, response: RequestResponse): ResolveOutcome {
        val client = connect(machineId).client
        try {
            return client.requests.resolve(requestId, response)
        } finally {
            scope.launch { loadRequests(machineId) }
        }
    }

    // ── launch ──

    public suspend fun loadProfiles(machineId: String) {
        try {
            val prefs = connect(machineId).client.launchProfiles.list()
            _state.update {
                it.copy(profiles = it.profiles + (machineId to prefs), profilesError = it.profilesError + (machineId to null))
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val message = fail(e)
            _state.update { it.copy(profilesError = it.profilesError + (machineId to message)) }
        }
    }

    public suspend fun startSession(machineId: String, workspace: WorkspaceView, profile: LaunchProfileView): SessionInfo {
        val client = connect(machineId).client
        val info = client.sessions.start(startPayload(workspace, profile))
        scope.launch { loadSessions(machineId) }
        return info
    }

    public suspend fun readFile(machineId: String, root: String, path: String): FileText =
        connect(machineId).client.files.read(root, path)
}
