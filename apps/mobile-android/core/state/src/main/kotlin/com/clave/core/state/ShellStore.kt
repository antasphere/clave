package com.clave.core.state

import com.clave.core.contract.ClaudeAccountView
import com.clave.core.contract.CodexAccountView
import com.clave.core.contract.ServerEvent
import com.clave.core.contract.ServerEventEnvelope
import com.clave.core.contract.ServerInfoView
import com.clave.core.contract.SidebarOverview
import com.clave.core.contract.UsageRead
import com.clave.core.transport.ClaveServerClient
import com.clave.core.transport.isUnsupportedRead
import com.clave.core.transport.messageOf
import java.util.concurrent.ConcurrentHashMap
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex

/** One read of the shell: not asked yet or asked for the first time, what it answered, or why not. */
public sealed interface ShellRead<out T> {
    public data object Loading : ShellRead<Nothing>

    public data class Loaded<T>(val value: T) : ShellRead<T>

    /** The Mac's server does not offer this read to the phone yet (a 403 or a 404): an older Clave. */
    public data object Unsupported : ShellRead<Nothing>

    public data class Failed(val message: String) : ShellRead<Nothing>
}

/** The value of a read when it answered one. */
public fun <T> ShellRead<T>.valueOrNull(): T? = (this as? ShellRead.Loaded<T>)?.value

/** What the shell knows of one machine beside the store's lists. */
public data class MachineShell(
    val overview: ShellRead<SidebarOverview> = ShellRead.Loading,
    val claudeAccounts: ShellRead<List<ClaudeAccountView>> = ShellRead.Loading,
    val codexAccounts: ShellRead<List<CodexAccountView>> = ShellRead.Loading,
    val claudeUsage: ShellRead<Map<String, UsageRead>> = ShellRead.Loading,
    val codexUsage: ShellRead<Map<String, UsageRead>> = ShellRead.Loading,
    val serverInfo: ShellRead<ServerInfoView> = ShellRead.Loading,
    /** Session id → the time of the last event the phone heard of it, the server's clock. */
    val activity: Map<String, Long> = emptyMap(),
)

/** A server event as the store heard it, with the machine it came from. */
public data class MachineEvent(val machineId: String, val envelope: ServerEventEnvelope)

/**
 * The reads of the shell, per machine: the desktop's groups, the agent accounts, their usage
 * and the server's version, kept live by the server's events. A layout change reads the
 * groups again, a usage read of one provider reads that provider's snapshot again, a new or
 * restarted session reads the sessions and the groups again. Reads already in flight are
 * joined: a burst of events is one read after the one under way, never one read per event.
 * A read the Mac does not offer ([ShellRead.Unsupported]) is not asked again by an event,
 * only by [refresh] (a pull, a return to the foreground), so an older Mac is not asked on
 * every usage event of its accounts.
 *
 * Nothing here carries a secret: the accounts say whether they hold a token, never which.
 */
public class ShellStore(
    private val scope: CoroutineScope,
    private val connect: suspend (machineId: String) -> ClaveServerClient,
    events: Flow<MachineEvent>,
    private val reloadSessions: suspend (machineId: String) -> Unit = {},
) {
    private val _state = MutableStateFlow<Map<String, MachineShell>>(emptyMap())
    public val state: StateFlow<Map<String, MachineShell>> = _state.asStateFlow()

    private enum class Kind { Overview, Accounts, ClaudeUsage, CodexUsage, ServerInfo }

    /** One coalescing gate per machine and read: a read asked while one runs runs once more after it. */
    private class Gate {
        val lock = Mutex()
        @Volatile var again = false
    }

    private val gates = ConcurrentHashMap<Pair<String, Kind>, Gate>()

    init {
        scope.launch { events.collect { onEvent(it) } }
    }

    private fun shell(machineId: String): MachineShell = _state.value[machineId] ?: MachineShell()

    private fun patch(machineId: String, change: (MachineShell) -> MachineShell) =
        _state.update { it + (machineId to change(it[machineId] ?: MachineShell())) }

    private fun onEvent(event: MachineEvent) {
        val m = event.machineId
        val e = event.envelope.event
        when (e) {
            is ServerEvent.SessionStateChanged -> touch(m, e.id, event.envelope.at)
            is ServerEvent.SessionTitleChanged -> touch(m, e.id, event.envelope.at)
            is ServerEvent.SessionRenamed -> touch(m, e.id, event.envelope.at)
            is ServerEvent.Unknown -> when (e.tag) {
                "sidebar.layout_changed", "sidebar.layout_removed", "sidebar.overview_changed" -> fromEvent(m, Kind.Overview)
                "usage.claude_read" -> fromEvent(m, Kind.ClaudeUsage)
                "usage.codex_read" -> fromEvent(m, Kind.CodexUsage)
                "session.registered", "session.restarted", "session.closed", "session.removed" -> scope.launch {
                    reloadSessions(m)
                    run(m, Kind.Overview)
                }
                else -> Unit
            }
            else -> Unit
        }
    }

    private fun touch(machineId: String, sessionId: String, at: Long) = patch(machineId) { s ->
        if ((s.activity[sessionId] ?: 0) >= at) s else s.copy(activity = s.activity + (sessionId to at))
    }

    private fun readOf(s: MachineShell, kind: Kind): ShellRead<*> = when (kind) {
        Kind.Overview -> s.overview
        Kind.Accounts -> s.claudeAccounts
        Kind.ClaudeUsage -> s.claudeUsage
        Kind.CodexUsage -> s.codexUsage
        Kind.ServerInfo -> s.serverInfo
    }

    /** An event's read: skipped while the Mac does not offer it. */
    private fun fromEvent(machineId: String, kind: Kind) {
        if (readOf(shell(machineId), kind) is ShellRead.Unsupported) return
        scope.launch { run(machineId, kind) }
    }

    /** Reads every part of the shell of [machineId] again. */
    public fun refresh(machineId: String) {
        for (kind in Kind.entries) scope.launch { run(machineId, kind) }
    }

    /** The groups again, alone (the session list's pull). */
    public fun refreshOverview(machineId: String) {
        scope.launch { run(machineId, Kind.Overview) }
    }

    /** The accounts and both usage snapshots again (the limits page's pull). */
    public fun refreshLimits(machineId: String) {
        for (kind in listOf(Kind.Accounts, Kind.ClaudeUsage, Kind.CodexUsage)) scope.launch { run(machineId, kind) }
    }

    private suspend fun run(machineId: String, kind: Kind) {
        val gate = gates.getOrPut(machineId to kind) { Gate() }
        gate.again = true
        while (true) {
            // The holder reads again for us; it looks once more after letting go, so no ask is lost.
            if (!gate.lock.tryLock()) return
            try {
                while (gate.again) {
                    gate.again = false
                    read(machineId, kind)
                }
            } finally {
                gate.lock.unlock()
            }
            if (!gate.again) return
        }
    }

    /** One read, its answer published; a failure keeps the last answer and is said only when there was none. */
    private suspend fun <T> load(machineId: String, fetch: suspend (ClaveServerClient) -> T): ShellRead<T> = try {
        ShellRead.Loaded(fetch(connect(machineId)))
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        if (isUnsupportedRead(e)) ShellRead.Unsupported else ShellRead.Failed(messageOf(e))
    }

    /** A failed refresh keeps what was shown: only a first read shows its failure. */
    private fun <T> kept(previous: ShellRead<T>, next: ShellRead<T>): ShellRead<T> =
        if (next is ShellRead.Failed && previous is ShellRead.Loaded) previous else next

    private suspend fun read(machineId: String, kind: Kind) {
        when (kind) {
            Kind.Overview -> {
                val next = load(machineId) { it.sidebar.overview() }
                patch(machineId) { it.copy(overview = kept(it.overview, next)) }
            }
            Kind.Accounts -> {
                val claude = load(machineId) { it.accounts.claude() }
                val codex = load(machineId) { it.accounts.codex() }
                patch(machineId) { it.copy(claudeAccounts = kept(it.claudeAccounts, claude), codexAccounts = kept(it.codexAccounts, codex)) }
            }
            Kind.ClaudeUsage -> {
                val next = load(machineId) { it.usage.claudeSnapshot() }
                patch(machineId) { it.copy(claudeUsage = kept(it.claudeUsage, next)) }
            }
            Kind.CodexUsage -> {
                val next = load(machineId) { it.usage.codexSnapshot() }
                patch(machineId) { it.copy(codexUsage = kept(it.codexUsage, next)) }
            }
            Kind.ServerInfo -> {
                val next = load(machineId) { it.server.info() }
                patch(machineId) { it.copy(serverInfo = kept(it.serverInfo, next)) }
            }
        }
    }

    /** Forgets a machine's shell (it was forgotten, or the owner changed). */
    public fun forget(machineId: String) {
        _state.update { it - machineId }
    }
}
