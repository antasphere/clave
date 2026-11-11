package com.clave.android.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import com.clave.android.AppServices
import com.clave.android.OwnerSession
import com.clave.core.auth.AuthPhase
import com.clave.core.auth.AuthStatus
import com.clave.core.contract.LaunchProfileView
import com.clave.core.contract.RequestResponse
import com.clave.core.contract.SessionInfo
import com.clave.core.contract.WorkspaceView
import com.clave.core.devices.EnrollmentFailure
import com.clave.core.devices.Machine
import com.clave.core.devices.PairingState
import com.clave.core.notifications.PushCleanupResult
import com.clave.core.notifications.TokenRegistration
import com.clave.core.state.LAST_MACHINE_KEY
import com.clave.core.state.StoreState
import com.clave.core.transport.messageOf
import com.clave.ui.theme.APPEARANCE_KEY
import com.clave.ui.theme.Appearance
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** The status shown before the sign-in exists: signed out, nothing failed. */
private val NO_SIGN_IN = AuthStatus(
    phase = AuthPhase.SignedOut,
    account = null,
    clientId = null,
    expiresAt = null,
    renewable = false,
    issuer = "",
    lastFailure = null,
)

const val SETTLED_ELSEWHERE: String = "Answered elsewhere first: this request is settled."
const val RELAY_CHANGED_PENDING: String =
    "Some previous machines have not confirmed notification removal and may still send updates. Removal will retry when you reopen this account. You can revoke this phone in Settings → Mobile on those machines."
const val SIGNED_OUT_RETRY: String =
    "Some machines could not confirm notification removal and may still send updates. Removal will retry when you sign back in to this account. You can also revoke this phone in Settings → Mobile on the Mac."
const val SIGNED_OUT_NO_RETRY: String =
    "Some machines could not confirm notification removal and may still send updates. Try signing in and signing out again, or revoke this phone in Settings → Mobile on the Mac."
const val SIGN_OUT_FAILED: String = "Sign-out could not complete. Try again."
const val MACHINE_UNAVAILABLE: String = "The machine is not available. Return to Machines and refresh."
const val PAIRING_FAILED: String = "Pairing could not complete. Try again."

/**
 * The screens' one door to the services: the sign-in's status, the current owner's store and
 * the state the store does not hold (the relay address as typed, the requests being
 * resolved, the launch in progress, the pairing, one transient notice), and every action a
 * screen takes. Every action runs in the ViewModel's scope on the owner current when it was
 * taken; an owner change clears the per-owner state, so nothing of one account is shown under
 * the next. Errors are said in the core's or the server's own words.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ClaveViewModel(private val services: AppServices) : ViewModel() {
    private val _appearance = MutableStateFlow(Appearance.System)
    val appearance: StateFlow<Appearance> = _appearance.asStateFlow()

    val auth: StateFlow<AuthStatus> = services.hub
        .flatMapLatest { it?.status ?: flowOf(NO_SIGN_IN) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, NO_SIGN_IN)

    val owner: StateFlow<OwnerSession?> = services.owner

    val store: StateFlow<StoreState> = services.owner
        .flatMapLatest { it?.store?.state ?: flowOf(StoreState()) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, StoreState())

    private val _paired = MutableStateFlow<Set<String>>(emptySet())

    /** The machines a credential is kept for on this phone, for this owner. */
    val paired: StateFlow<Set<String>> = _paired.asStateFlow()

    private val _relayUrl = MutableStateFlow("")

    /** The team relay's address as the field shows it: the stored one, then what is typed. */
    val relayUrl: StateFlow<String> = _relayUrl.asStateFlow()

    private val _relayError = MutableStateFlow<String?>(null)

    /** A relay address the owner services refused, in their words. */
    val relayError: StateFlow<String?> = _relayError.asStateFlow()

    private val _signingOut = MutableStateFlow(false)
    val signingOut: StateFlow<Boolean> = _signingOut.asStateFlow()

    private val _notice = MutableStateFlow<String?>(null)

    /** One transient sentence for the person (a sign-out's or relay change's warning, a link's reason). */
    val notice: StateFlow<String?> = _notice.asStateFlow()

    private val _busy = MutableStateFlow<Map<String, Set<String>>>(emptyMap())

    /** Per machine, the requests being resolved. */
    val busy: StateFlow<Map<String, Set<String>>> = _busy.asStateFlow()

    private val _requestNotices = MutableStateFlow<Map<String, Map<String, String>>>(emptyMap())

    /** Per machine, a sentence per request after a resolve that did not land. */
    val requestNotices: StateFlow<Map<String, Map<String, String>>> = _requestNotices.asStateFlow()

    private val _starting = MutableStateFlow<Map<String, String>>(emptyMap())

    /** Per machine, the id of the profile being started. */
    val starting: StateFlow<Map<String, String>> = _starting.asStateFlow()

    private val _refusals = MutableStateFlow<Map<String, String>>(emptyMap())

    /** Per machine, the server's sentence when it would not start a session. */
    val refusals: StateFlow<Map<String, String>> = _refusals.asStateFlow()

    private val _pairing = MutableStateFlow<PairingState?>(null)

    /** The pairing under way or settled; null before it began. */
    val pairing: StateFlow<PairingState?> = _pairing.asStateFlow()

    private val urls = Channel<String>(Channel.BUFFERED)

    /** The VIEW intents the activity received while running, in order. */
    val incomingUrls: Flow<String> = urls.receiveAsFlow()

    /** Machines whose server answered that it has no files route; a property of the server, not of a chat. */
    private val noFilesRoute = ConcurrentHashMap.newKeySet<String>()
    private val machinesLock = Mutex()

    /** Stops the pairing under way, if any. */
    @Volatile private var pairingStop: () -> Unit = {}

    init {
        viewModelScope.launch { _appearance.value = Appearance.of(services.kv.get(APPEARANCE_KEY)) }
        viewModelScope.launch {
            services.owner.collect { owner ->
                _pairing.value = null
                _busy.value = emptyMap()
                _requestNotices.value = emptyMap()
                _starting.value = emptyMap()
                _refusals.value = emptyMap()
                _relayError.value = null
                noFilesRoute.clear()
                if (owner != null) {
                    _relayUrl.value = owner.services.relayUrl()
                    owner.store.loadMachines()
                } else {
                    _relayUrl.value = ""
                }
            }
        }
        viewModelScope.launch {
            combine(services.owner, store.map { s -> s.machines.map { it.id } }.distinctUntilChanged()) { o, ids -> o to ids }
                .collect { (o, ids) -> refreshPaired(o, ids) }
        }
    }

    private suspend fun refreshPaired(owner: OwnerSession?, ids: List<String> = store.value.machines.map { it.id }) {
        _paired.value = if (owner == null) emptySet() else ids.filter { owner.services.credentials.get(it) != null }.toSet()
    }

    /** Runs [block] on the current owner, if any; a failure the block does not catch is the notice. */
    private fun withOwner(block: suspend (OwnerSession) -> Unit) {
        val owner = services.owner.value ?: return
        viewModelScope.launch {
            try {
                block(owner)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _notice.value = messageOf(e)
            }
        }
    }

    /** The machine list holds [machineId], loading it once when it does not (a cold deep link). */
    private suspend fun ensureMachine(owner: OwnerSession, machineId: String) = machinesLock.withLock {
        if (owner.store.state.value.machines.none { it.id == machineId }) owner.store.loadMachines()
    }

    fun setAppearance(value: Appearance) {
        _appearance.value = value
        viewModelScope.launch { services.kv.set(APPEARANCE_KEY, value.id) }
    }

    fun showNotice(text: String) {
        if (text.isNotEmpty()) _notice.value = text
    }

    /** Clears the notice, only when it is still [text] (a newer one stays). */
    fun dismissNotice(text: String? = _notice.value) {
        _notice.update { if (it == text) null else it }
    }

    /** The activity's VIEW intent, handed to the navigation. */
    fun receiveUrl(url: String) {
        urls.trySend(url)
    }

    // ── machines and the account ──

    fun loadMachines() = withOwner { it.store.loadMachines() }

    /** Disconnects every machine, then opens the browser; a failure is the status's lastFailure. */
    fun signIn() {
        val hub = services.hub.value ?: return
        services.owner.value?.store?.disconnectAll()
        viewModelScope.launch {
            try {
                hub.signIn()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // The status carries the failure's word; the screen says it.
            }
        }
    }

    /** Clears the push registrations, then forgets the login; machines that did not confirm are said. */
    fun signOut() {
        val owner = services.owner.value ?: return
        owner.store.disconnectAll()
        _signingOut.value = true
        viewModelScope.launch {
            try {
                val result: PushCleanupResult = owner.services.signOut()
                if (result.pending != 0) _notice.value = if (result.retryRecorded) SIGNED_OUT_RETRY else SIGNED_OUT_NO_RETRY
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                _notice.value = SIGN_OUT_FAILED
            } finally {
                _signingOut.value = false
            }
        }
    }

    /** The relay field's text as typed; nothing is saved until [connectRelay]. */
    fun editRelayUrl(value: String) {
        _relayUrl.value = value
        _relayError.value = null
    }

    fun connectRelay() = setRelayUrl(_relayUrl.value)

    /**
     * Saves the team relay: every machine disconnected first, the address checked and kept by
     * the owner services (a refused one is the Machines error), then the machines listed again.
     */
    fun setRelayUrl(value: String) {
        val owner = services.owner.value ?: return
        _relayError.value = null
        owner.store.disconnectAll()
        viewModelScope.launch {
            try {
                val cleanup = owner.services.setRelayUrl(value)
                if (cleanup.pending != 0) _notice.value = RELAY_CHANGED_PENDING
                _relayUrl.value = owner.services.relayUrl()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _relayError.value = relayErrorOf(e)
                return@launch
            }
            owner.store.loadMachines()
        }
    }

    fun setMainMachine(machineId: String) = withOwner { it.store.setMainMachine(machineId) }

    fun removeDeveloperMachine(machineId: String) = withOwner { owner ->
        owner.store.removeDeveloperMachine(machineId)
        refreshPaired(owner)
    }

    /** A development build's server by address and token; [onDone] on success, [onError] with the sentence. */
    fun addDeveloperMachine(url: String, token: String, name: String, onDone: () -> Unit, onError: (String) -> Unit) {
        val owner = services.owner.value ?: return onError("The account is still loading. Try again.")
        viewModelScope.launch {
            try {
                owner.store.addDeveloperMachine(url, token, name)
                refreshPaired(owner)
                onDone()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                onError(messageOf(e))
            }
        }
    }

    /** Connects to the machine and remembers it as the one a cold launch opens on, when it is listed. */
    fun openMachine(machineId: String) = withOwner { owner ->
        ensureMachine(owner, machineId)
        if (owner.store.state.value.machines.none { it.id == machineId }) return@withOwner
        owner.kv.set(LAST_MACHINE_KEY, machineId)
        try {
            owner.store.connect(machineId)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // The lists say why in their own error fields.
        }
    }

    fun loadWorkspaces(machineId: String) = withOwner { owner ->
        ensureMachine(owner, machineId)
        owner.store.loadWorkspaces(machineId)
    }

    fun loadSessions(machineId: String) = withOwner { owner ->
        ensureMachine(owner, machineId)
        owner.store.loadSessions(machineId)
    }

    fun loadRequests(machineId: String) = withOwner { owner ->
        ensureMachine(owner, machineId)
        owner.store.loadRequests(machineId)
    }

    /** After a resume: the machine's sessions and requests read again. */
    fun refreshMachine(machineId: String) {
        loadSessions(machineId)
        loadRequests(machineId)
    }

    /** Answers a request; one the server says another client settled first keeps a sentence. */
    fun resolveRequest(machineId: String, requestId: String, response: RequestResponse) {
        val owner = services.owner.value ?: return
        _busy.update { it + (machineId to (it[machineId].orEmpty() + requestId)) }
        viewModelScope.launch {
            val notice = try {
                if (owner.store.resolveRequest(machineId, requestId, response).accepted) null else SETTLED_ELSEWHERE
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                messageOf(e)
            } finally {
                _busy.update { it + (machineId to (it[machineId].orEmpty() - requestId)) }
            }
            _requestNotices.update { all ->
                val mine = all[machineId].orEmpty()
                all + (machineId to if (notice == null) mine - requestId else mine + (requestId to notice))
            }
        }
    }

    // ── launch ──

    fun loadProfiles(source: String) = withOwner { owner ->
        ensureMachine(owner, source)
        owner.store.loadProfiles(source)
    }

    /** Starts a session from a profile; [onStarted] with the session, else the refusal kept for the screen. */
    fun startSession(machineId: String, workspace: WorkspaceView, profile: LaunchProfileView, onStarted: (SessionInfo) -> Unit) {
        val owner = services.owner.value ?: return
        if (_starting.value[machineId] != null) return
        _starting.update { it + (machineId to profile.id) }
        _refusals.update { it - machineId }
        viewModelScope.launch {
            try {
                onStarted(owner.store.startSession(machineId, workspace, profile))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _refusals.update { it + (machineId to messageOf(e)) }
            } finally {
                _starting.update { it - machineId }
            }
        }
    }

    // ── pairing ──

    /**
     * Pairs with [machine] once: the states as they come, a cancel stops it at the next step.
     * On the approval the machine becomes the main one when none was, and the push token is
     * registered (asking for the notification permission); a token the platform will not hand
     * is said as a notice, never as a pairing failure.
     */
    fun pair(machine: Machine?) {
        val owner = services.owner.value ?: return
        if (machine == null) {
            _pairing.value = PairingState.Failed(EnrollmentFailure.Protocol, MACHINE_UNAVAILABLE)
            return
        }
        pairingStop()
        val cancelled = AtomicBoolean(false)
        val cancel: () -> Boolean = { cancelled.get() || services.owner.value !== owner }
        pairingStop = { cancelled.set(true) }
        _pairing.value = PairingState.Requesting
        viewModelScope.launch {
            try {
                val result = owner.services.pair(machine, { state -> if (!cancel()) _pairing.value = state }, cancel)
                if (!cancel()) _pairing.value = result
                if (result !is PairingState.Approved || cancel()) return@launch
                // The credential store made it the main machine if none was: the store says so too.
                val main = owner.services.credentials.mainMachineId()
                if (main == null || main == machine.id) owner.store.setMainMachine(machine.id)
                refreshPaired(owner)
                when (val token = owner.services.registerPush(machine.id)) {
                    is TokenRegistration.Unsupported -> showNotice(token.reason)
                    is TokenRegistration.Failed -> showNotice(token.reason)
                    else -> Unit
                }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                if (!cancel()) _pairing.value = PairingState.Failed(EnrollmentFailure.Network, PAIRING_FAILED)
            }
        }
    }

    /** The person left the pairing or pressed Cancel: polling stops at the next step. */
    fun cancelPairing() {
        pairingStop()
        if (_pairing.value.let { it == null || it == PairingState.Requesting || it is PairingState.Waiting }) {
            _pairing.value = PairingState.Cancelled
        }
    }

    /** Forgets a settled pairing before a new screen starts one. */
    fun resetPairing() {
        pairingStop()
        _pairing.value = null
    }

    // ── chat ──

    /** The composer and subscription of one conversation on the current owner; null while no owner exists. */
    fun chat(machineId: String, sessionId: String): ChatSession? {
        val owner = services.owner.value ?: return null
        return ChatSession(
            owner = owner,
            machineId = machineId,
            sessionId = sessionId,
            files = services.files,
            scope = viewModelScope,
            filesRouteOf = { it !in noFilesRoute },
            markNoFilesRoute = { noFilesRoute.add(it) },
        )
    }

    companion object {
        /** The factory the activity builds the ViewModel with, from the process's services. */
        fun factory(services: AppServices): ViewModelProvider.Factory = viewModelFactory {
            initializer { ClaveViewModel(services) }
        }
    }
}
