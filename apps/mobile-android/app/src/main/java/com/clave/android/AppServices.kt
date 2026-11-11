package com.clave.android

import android.app.Application
import android.content.Context
import android.os.Build
import android.provider.Settings
import com.clave.android.auth.OAuthCallbackActivity
import com.clave.android.push.NotificationActionReceiver
import com.clave.core.auth.AuthStatus
import com.clave.core.auth.HubSignIn
import com.clave.core.auth.SignInDeps
import com.clave.core.contract.DeviceDescription
import com.clave.core.contract.DevicePlatform
import com.clave.core.devices.BuildKind
import com.clave.core.ports.Clock
import com.clave.core.ports.CryptoPort
import com.clave.core.ports.HttpPort
import com.clave.core.ports.JvmCrypto
import com.clave.core.ports.KeyValueStore
import com.clave.core.ports.Log
import com.clave.core.ports.SecureStore
import com.clave.core.ports.SystemClock
import com.clave.core.ports.WebSocketFactory
import com.clave.platform.app.ForegroundActivity
import com.clave.platform.auth.CustomTabsAuthSession
import com.clave.platform.files.ContentFiles
import com.clave.platform.log.LogcatLog
import com.clave.platform.net.Networking
import com.clave.platform.push.ClaveNotifications
import com.clave.platform.push.FirebaseTokens
import com.clave.platform.push.NotificationPermission
import com.clave.platform.store.KeystoreSecureStore
import com.clave.platform.store.PreferencesKeyValueStore
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChangedBy
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Which account an owner session belongs to: the issuer and the subject, null when signed out. */
data class OwnerKey(val issuer: String, val subject: String?)

/** The owner a status names. */
fun ownerKeyOf(status: AuthStatus): OwnerKey = OwnerKey(status.issuer, status.account?.subject)

/**
 * The process's services, built once by [ClaveApplication.onCreate] and reached through
 * [services]: the platform's stores, network, browser, notifications and files, the hub
 * sign-in ([hub]) and the session of the account the sign-in names now ([owner]). An owner
 * session is rebuilt whenever the issuer or the account changes, and the previous one is
 * closed first, so no socket, store or notification route of one account reaches the next.
 * The default build reaches Clave's real hub and relay; only a development build may point
 * the sign-in elsewhere, through [Development.issuerOverride].
 */
class AppServices(private val application: Application) {
    val log: Log = LogcatLog(enabled = BuildConfig.DEVELOPMENT)

    /** The plain store; every owner reads it through its own namespace. */
    val kv: KeyValueStore = PreferencesKeyValueStore(application)
    val secure: SecureStore = KeystoreSecureStore(application, log)
    val http: HttpPort = Networking.httpPort()
    val sockets: WebSocketFactory = Networking.webSockets()
    val crypto: CryptoPort = JvmCrypto
    val clock: Clock = SystemClock
    val build: BuildKind = if (BuildConfig.DEVELOPMENT) BuildKind.Development else BuildKind.Release
    val foreground: ForegroundActivity = ForegroundActivity(application)
    val browser: CustomTabsAuthSession = CustomTabsAuthSession(foreground, callbackActivity = OAuthCallbackActivity::class.java)
    val notifications: ClaveNotifications = ClaveNotifications(
        context = application,
        channelName = application.getString(R.string.notification_channel_name),
        channelDescription = application.getString(R.string.notification_channel_description),
        openActivity = MainActivity::class.java,
        actionReceiver = NotificationActionReceiver::class.java,
        smallIcon = R.drawable.ic_notification,
    )
    val tokens: FirebaseTokens = FirebaseTokens(application)
    val permission: NotificationPermission = NotificationPermission(application) { NotificationPermissionRequests.ask() }
    val device: DeviceDescription = DeviceDescription(
        name = Settings.Global.getString(application.contentResolver, "device_name") ?: Build.MODEL,
        platform = DevicePlatform.Android,
        appVersion = BuildConfig.VERSION_NAME,
    )
    val files: ContentFiles = ContentFiles(application)

    /** The process's own work: the restore, the owner sessions' births and deaths, the receivers. */
    val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val _hub = MutableStateFlow<HubSignIn?>(null)

    /** The sign-in, once the issuer override (a development build's only) has been read. */
    val hub: StateFlow<HubSignIn?> = _hub.asStateFlow()

    private val _owner = MutableStateFlow<OwnerSession?>(null)

    /** The session of the account the sign-in names now; null until the first is built. */
    val owner: StateFlow<OwnerSession?> = _owner.asStateFlow()

    /** One rebuild of the sign-in at a time; the owner flow follows the sign-in it is given. */
    private val authLock = Mutex()
    private var following: Job? = null

    /** Builds the sign-in from the stored override, restores it, and starts the owner flow. */
    fun start() {
        scope.launch { authLock.withLock { startAuth() } }
    }

    /**
     * After the development issuer override changes: the owner session is closed, a sign-in
     * on the new issuer is built and restored, and the owner flow starts again from it. A
     * release build has no override, so this rebuilds the same sign-in on the hub.
     */
    suspend fun rebuildAuth() = authLock.withLock {
        following?.cancel()
        following = null
        _owner.value?.close()
        _owner.value = null
        startAuth()
    }

    private suspend fun startAuth() {
        val auth = HubSignIn(
            SignInDeps(
                issuer = Development.issuerOverride(kv),
                http = http,
                secureStore = secure,
                crypto = crypto,
                openAuthSession = browser.open,
                log = log,
            ),
        )
        _hub.value = auth
        following = scope.launch { follow(auth) }
        scope.launch { auth.restore() }
    }

    /** One owner session per (issuer, subject): a change closes the previous one before the next is built. */
    private suspend fun follow(auth: HubSignIn) {
        auth.status.distinctUntilChangedBy(::ownerKeyOf).collect { status ->
            _owner.value?.close()
            _owner.value = null
            try {
                _owner.value = OwnerSession.open(this, auth, status)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                log.event("owner.open_failed", mapOf("error" to e::class.simpleName))
            }
        }
    }

    /**
     * The owner of the restored login: what a receiver woken in a cold process needs, since
     * the first owner built before the restore is the signed-out one. Waits for the sign-in,
     * its restore, and the owner of the account the restore found.
     */
    suspend fun restoredOwner(): OwnerSession {
        val auth = hub.filterNotNull().first()
        auth.restore()
        val key = ownerKeyOf(auth.status.value)
        return owner.filterNotNull().first { it.auth === auth && it.key == key }
    }
}

/** The services of the process [context] belongs to. */
fun services(context: Context): AppServices = (context.applicationContext as ClaveApplication).services
