package com.clave.android.ui

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import androidx.navigation.navDeepLink
import com.clave.android.AppServices
import com.clave.android.BuildConfig
import com.clave.android.Development
import com.clave.core.chat.PickedKind
import com.clave.core.chat.emptyConversation
import com.clave.core.notifications.DeepLink
import com.clave.core.notifications.parseDeepLink
import com.clave.core.state.LAST_MACHINE_KEY
import com.clave.core.state.conversationKey
import com.clave.ui.components.Notice
import com.clave.ui.components.NoticeAction
import com.clave.ui.screens.AppearanceScreen
import com.clave.ui.screens.ChatActions
import com.clave.ui.screens.ChatScreen
import com.clave.ui.screens.LaunchScreen
import com.clave.ui.screens.MachinesScreen
import com.clave.ui.screens.PairingScreen
import com.clave.ui.screens.RequestsScreen
import com.clave.ui.screens.SessionsScreen
import com.clave.ui.screens.WorkspacesScreen
import com.clave.ui.screens.basename
import com.clave.ui.screens.isChatProfile
import com.clave.ui.theme.ClaveTheme
import com.clave.ui.theme.Metrics
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withTimeoutOrNull

/** How long a cold launch waits for the stored login before it opens on what it has. */
private const val RESTORE_WAIT_MS: Long = 5_000

/** How long the transient notice stays unless dismissed. */
private const val NOTICE_MS: Long = 10_000

/** The camera permission is declared, so the system's camera refuses to run without it. */
private const val CAMERA_REFUSED: String = "Clave may not use the camera. Allow it in the system settings to take a photo."

private fun NavBackStackEntry.arg(name: String): String = arguments?.getString(name).orEmpty()

private fun NavBackStackEntry.optionalArg(name: String): String? = arguments?.getString(name)?.takeIf { it.isNotEmpty() }

private val machineArg = navArgument(Routes.MACHINE_ID) { type = NavType.StringType }

private fun optional(name: String) = navArgument(name) {
    type = NavType.StringType
    nullable = true
    defaultValue = null
}

/** The wall clock, ticking every [periodMs]: the "seen 5 min ago" lines and the pairing's countdown. */
@Composable
private fun rememberNow(periodMs: Long): Long {
    val now by produceState(System.currentTimeMillis()) {
        while (true) {
            delay(periodMs)
            value = System.currentTimeMillis()
        }
    }
    return now
}

/**
 * The app: the theme of the person's appearance, the navigation graph of the screens, and
 * the transient notice above them. Every screen is the design system's, fed by the pure
 * mapping from the store and the sign-in; each route's effects load what it shows. A cold
 * launch opens where the notification inbox says (Machines, the Workspaces of the last
 * machine, the conversation of a link); after it, the inbox and the activity's VIEW intents
 * navigate a warm app, and coming back to the foreground reads the current machine's
 * sessions and requests again.
 */
@Composable
fun ClaveApp(services: AppServices, launchUrl: String?, viewModel: ClaveViewModel) {
    val appearance by viewModel.appearance.collectAsStateWithLifecycle()
    ClaveTheme(appearance) {
        val nav = rememberNavController()
        val owner by viewModel.owner.collectAsStateWithLifecycle()
        val notice by viewModel.notice.collectAsStateWithLifecycle()
        val links = remember { Channel<DeepLink>(Channel.BUFFERED) }
        var started by remember { mutableStateOf(false) }

        LaunchedEffect(Unit) {
            val first = withTimeoutOrNull(RESTORE_WAIT_MS) { services.restoredOwner() } ?: services.owner.value
            if (first != null) {
                val initial = first.inbox.initialState(first.kv.get(LAST_MACHINE_KEY), launchUrl)
                for (route in routesFor(initial).drop(1)) nav.navigate(route)
            }
            started = true
        }
        LaunchedEffect(owner, started) {
            if (started) owner?.inbox?.ready { link -> links.trySend(link) }
        }
        LaunchedEffect(Unit) {
            for (link in links) open(nav, viewModel, link)
        }
        LaunchedEffect(Unit) {
            viewModel.incomingUrls.collect { url -> parseDeepLink(url)?.let { open(nav, viewModel, it) } }
        }
        DisposableEffect(Unit) {
            val off = services.foreground.onForegroundChange { foreground ->
                if (foreground) nav.currentBackStackEntry?.optionalArg(Routes.MACHINE_ID)?.let(viewModel::refreshMachine)
            }
            onDispose { off() }
        }

        Box(Modifier.fillMaxSize()) {
            NavHost(navController = nav, startDestination = Routes.MACHINES) {
                composable(Routes.MACHINES, deepLinks = listOf(navDeepLink { uriPattern = Routes.LINK_MACHINES })) {
                    MachinesRoute(nav, viewModel)
                }
                composable(Routes.PAIRING, arguments = listOf(machineArg)) { entry ->
                    PairingRoute(nav, viewModel, entry.arg(Routes.MACHINE_ID))
                }
                composable(
                    Routes.WORKSPACES,
                    arguments = listOf(machineArg),
                    deepLinks = listOf(navDeepLink { uriPattern = Routes.LINK_WORKSPACES }),
                ) { entry -> WorkspacesRoute(nav, viewModel, entry.arg(Routes.MACHINE_ID)) }
                composable(
                    Routes.SESSIONS,
                    arguments = listOf(machineArg, navArgument(Routes.WORKSPACE_ID) { type = NavType.StringType }),
                ) { entry -> SessionsRoute(nav, viewModel, entry.arg(Routes.MACHINE_ID), entry.arg(Routes.WORKSPACE_ID)) }
                composable(
                    Routes.LAUNCH,
                    arguments = listOf(machineArg, navArgument(Routes.WORKSPACE_ID) { type = NavType.StringType }),
                ) { entry -> LaunchRoute(nav, viewModel, entry.arg(Routes.MACHINE_ID), entry.arg(Routes.WORKSPACE_ID)) }
                composable(
                    Routes.CHAT,
                    arguments = listOf(machineArg, navArgument(Routes.SESSION_ID) { type = NavType.StringType }, optional(Routes.TITLE)),
                    deepLinks = listOf(navDeepLink { uriPattern = Routes.LINK_CHAT }),
                ) { entry ->
                    ChatRoute(
                        nav,
                        services,
                        viewModel,
                        entry.arg(Routes.MACHINE_ID),
                        entry.arg(Routes.SESSION_ID),
                        entry.optionalArg(Routes.TITLE),
                    )
                }
                composable(
                    Routes.REQUESTS,
                    arguments = listOf(machineArg, optional(Routes.REQUEST_ID)),
                    deepLinks = listOf(
                        navDeepLink { uriPattern = Routes.LINK_REQUESTS },
                        navDeepLink { uriPattern = Routes.LINK_REQUEST },
                    ),
                ) { entry -> RequestsRoute(nav, viewModel, entry.arg(Routes.MACHINE_ID)) }
                composable(Routes.APPEARANCE) {
                    val current by viewModel.appearance.collectAsStateWithLifecycle()
                    AppearanceScreen(appearance = current, onAppearance = viewModel::setAppearance, onBack = { nav.popBackStack() })
                }
                Development.routes(this, services, viewModel, nav)
            }
            val text = notice
            if (text != null) {
                LaunchedEffect(text) {
                    delay(NOTICE_MS)
                    viewModel.dismissNotice(text)
                }
                Notice(
                    text,
                    action = NoticeAction("Dismiss") { viewModel.dismissNotice(text) },
                    modifier = Modifier
                        .align(Alignment.BottomCenter)
                        .windowInsetsPadding(WindowInsets.safeDrawing)
                        .padding(Metrics.gutter),
                )
            }
        }
    }
}

/** A link on a warm app: its screen over the current stack; a Machines link goes back to the root with its reason. */
private fun open(nav: NavHostController, viewModel: ClaveViewModel, link: DeepLink) {
    if (link is DeepLink.Machines) {
        nav.popBackStack(Routes.MACHINES, inclusive = false)
        viewModel.showNotice(link.reason)
        return
    }
    nav.navigate(routeFor(link)) { launchSingleTop = true }
}

@Composable
private fun MachinesRoute(nav: NavHostController, viewModel: ClaveViewModel) {
    val store by viewModel.store.collectAsStateWithLifecycle()
    val auth by viewModel.auth.collectAsStateWithLifecycle()
    val paired by viewModel.paired.collectAsStateWithLifecycle()
    val relayUrl by viewModel.relayUrl.collectAsStateWithLifecycle()
    val relayError by viewModel.relayError.collectAsStateWithLifecycle()
    val signingOut by viewModel.signingOut.collectAsStateWithLifecycle()
    val now = rememberNow(30_000)
    var shown by rememberSaveable { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        if (!shown) viewModel.loadMachines()
        shown = true
    }
    val card = Development.machinesCard
    MachinesScreen(
        state = machinesState(store, auth, paired, relayUrl, signingOut, now, relayError),
        onSignIn = viewModel::signIn,
        onSignOut = viewModel::signOut,
        onRelayUrlChange = viewModel::editRelayUrl,
        onConnectRelay = viewModel::connectRelay,
        onRefresh = viewModel::loadMachines,
        onOpen = { nav.navigate(Routes.workspaces(it.id)) },
        onPair = { nav.navigate(Routes.pairing(it.id)) },
        onMakeMain = { viewModel.setMainMachine(it.id) },
        onForget = if (BuildConfig.DEVELOPMENT) ({ machine -> viewModel.removeDeveloperMachine(machine.id) }) else null,
        onAppearance = { nav.navigate(Routes.APPEARANCE) },
        developer = card?.let { { it { nav.navigate(Routes.DEVELOPER) } } },
    )
}

@Composable
private fun PairingRoute(nav: NavHostController, viewModel: ClaveViewModel, machineId: String) {
    val store by viewModel.store.collectAsStateWithLifecycle()
    val pairing by viewModel.pairing.collectAsStateWithLifecycle()
    val now = rememberNow(1_000)
    val machine = store.machines.firstOrNull { it.id == machineId }
    LaunchedEffect(machineId) {
        viewModel.resetPairing()
        viewModel.pair(machine)
    }
    DisposableEffect(machineId) { onDispose { viewModel.cancelPairing() } }
    PairingScreen(
        machineName = machine?.name ?: "this machine",
        state = pairing,
        now = now,
        onCancel = viewModel::cancelPairing,
        onRetry = { viewModel.pair(store.machines.firstOrNull { it.id == machineId }) },
        onDone = { nav.navigate(Routes.workspaces(machineId)) { popUpTo(Routes.PAIRING) { inclusive = true } } },
        onBack = { nav.popBackStack() },
    )
}

@Composable
private fun WorkspacesRoute(nav: NavHostController, viewModel: ClaveViewModel, machineId: String) {
    val store by viewModel.store.collectAsStateWithLifecycle()
    val owner by viewModel.owner.collectAsStateWithLifecycle()
    LaunchedEffect(machineId, owner) {
        viewModel.openMachine(machineId)
        viewModel.loadWorkspaces(machineId)
        viewModel.loadRequests(machineId)
    }
    WorkspacesScreen(
        state = workspacesState(store, machineId),
        onOpen = { nav.navigate(Routes.sessions(machineId, it.id)) },
        onRequests = { nav.navigate(Routes.requests(machineId)) },
        onRefresh = {
            viewModel.loadWorkspaces(machineId)
            viewModel.loadRequests(machineId)
        },
        onBack = { nav.popBackStack() },
    )
}

@Composable
private fun SessionsRoute(nav: NavHostController, viewModel: ClaveViewModel, machineId: String, workspaceId: String) {
    val store by viewModel.store.collectAsStateWithLifecycle()
    val owner by viewModel.owner.collectAsStateWithLifecycle()
    LaunchedEffect(machineId, workspaceId, owner) {
        if (viewModel.store.value.workspaces[machineId] == null) viewModel.loadWorkspaces(machineId)
        viewModel.loadSessions(machineId)
    }
    SessionsScreen(
        state = sessionsState(store, machineId, workspaceId),
        onOpen = { s -> nav.navigate(Routes.chat(machineId, s.id, s.title.ifEmpty { basename(s.cwd) })) },
        onLaunch = { nav.navigate(Routes.launch(machineId, workspaceId)) },
        onRefresh = { viewModel.loadSessions(machineId) },
        onBack = { nav.popBackStack() },
    )
}

@Composable
private fun LaunchRoute(nav: NavHostController, viewModel: ClaveViewModel, machineId: String, workspaceId: String) {
    val store by viewModel.store.collectAsStateWithLifecycle()
    val owner by viewModel.owner.collectAsStateWithLifecycle()
    val starting by viewModel.starting.collectAsStateWithLifecycle()
    val refusals by viewModel.refusals.collectAsStateWithLifecycle()
    val source = launchSourceOf(store, machineId)
    LaunchedEffect(machineId, workspaceId, source, owner) {
        viewModel.loadProfiles(source)
        if (viewModel.store.value.workspaces[machineId] == null) viewModel.loadWorkspaces(machineId)
    }
    LaunchScreen(
        state = launchState(store, machineId, workspaceId, starting[machineId], refusals[machineId]),
        onStart = { profile ->
            val workspace = store.workspaces[machineId]?.firstOrNull { it.id == workspaceId }
            if (workspace != null) {
                viewModel.startSession(machineId, workspace, profile) { info ->
                    if (isChatProfile(profile)) {
                        nav.navigate(Routes.chat(machineId, info.id, info.folderName)) { popUpTo(Routes.LAUNCH) { inclusive = true } }
                    } else {
                        nav.popBackStack()
                    }
                }
            }
        },
        onBack = { nav.popBackStack() },
    )
}

@Composable
private fun RequestsRoute(nav: NavHostController, viewModel: ClaveViewModel, machineId: String) {
    val store by viewModel.store.collectAsStateWithLifecycle()
    val owner by viewModel.owner.collectAsStateWithLifecycle()
    val busy by viewModel.busy.collectAsStateWithLifecycle()
    val notices by viewModel.requestNotices.collectAsStateWithLifecycle()
    LaunchedEffect(machineId, owner) { viewModel.loadRequests(machineId) }
    RequestsScreen(
        state = requestsState(store, machineId, busy[machineId].orEmpty(), notices[machineId].orEmpty()),
        onResolve = { requestId, response -> viewModel.resolveRequest(machineId, requestId, response) },
        onRefresh = { viewModel.loadRequests(machineId) },
        onBack = { nav.popBackStack() },
    )
}

@Composable
private fun ChatRoute(
    nav: NavHostController,
    services: AppServices,
    viewModel: ClaveViewModel,
    machineId: String,
    sessionId: String,
    title: String?,
) {
    val context = LocalContext.current
    val store by viewModel.store.collectAsStateWithLifecycle()
    val owner by viewModel.owner.collectAsStateWithLifecycle()
    val chat = remember(owner, machineId, sessionId) { viewModel.chat(machineId, sessionId) }
    val chatFlow = remember(chat) { chat?.state ?: MutableStateFlow(ChatSessionState()) }
    val chatState by chatFlow.collectAsStateWithLifecycle()
    val controlsFlow = remember(chat) { chat?.controls ?: MutableStateFlow(ChatControlsState()) }
    val controls by controlsFlow.collectAsStateWithLifecycle()
    val now = rememberNow(30_000)
    DisposableEffect(chat) {
        chat?.open()
        onDispose { chat?.close() }
    }
    LaunchedEffect(machineId, owner) {
        if (viewModel.store.value.sessions[machineId] == null) viewModel.loadSessions(machineId)
    }

    val photos = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(maxItems = 10)) { uris ->
        for (uri in uris) {
            val video = context.contentResolver.getType(uri)?.startsWith("video/") == true
            chat?.attach(uri, if (video) PickedKind.Video else PickedKind.Image)
        }
    }
    var cameraTarget by rememberSaveable { mutableStateOf<String?>(null) }
    val camera = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { taken ->
        val target = cameraTarget
        cameraTarget = null
        if (taken && target != null) chat?.attach(Uri.parse(target), PickedKind.Image)
    }
    val takePhoto = {
        val target = services.files.cameraTarget()
        cameraTarget = target.toString()
        try {
            camera.launch(target)
        } catch (_: ActivityNotFoundException) {
            cameraTarget = null
            chat?.showError("No camera app is available on this phone.")
        }
    }
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) takePhoto() else chat?.showError(CAMERA_REFUSED)
    }
    val documents = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        for (uri in uris) chat?.attach(uri, null)
    }

    val screen = chatState(store, machineId, sessionId, chatState, now, title)
    val conversation = store.conversations[conversationKey(machineId, sessionId)]?.conversation ?: emptyConversation
    ChatScreen(
        state = screen.copy(
            controls = chatControlsView(screen.provider, conversation, controls),
            prompt = promptView(screen.provider, conversation),
        ),
        actions = ChatActions(
            onOpenControls = { chat?.refreshControls() },
            onPickModel = { chat?.pickModel(it) },
            onPickEffort = { chat?.pickEffort(it) },
            onPickMode = { chat?.pickMode(it) },
            onDismissRefusal = { chat?.dismissRefusal() },
        ),
        onBack = { nav.popBackStack() },
        onRequests = { nav.navigate(Routes.requests(machineId)) },
        onLoadOlder = { chat?.loadOlder() },
        onTextChange = { chat?.setDraft(it) },
        onSend = { chat?.send() },
        onStop = { chat?.interrupt() },
        onPickPhotos = { photos.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) },
        onTakePhoto = {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                takePhoto()
            } else {
                cameraPermission.launch(Manifest.permission.CAMERA)
            }
        },
        onPickDocuments = { documents.launch(arrayOf("*/*")) },
        onRemoveAttachment = { chat?.removeAttachment(it) },
        onAnswer = { requestId, optionId, answers -> chat?.answer(requestId, optionId, answers) },
        onToggle = { chat?.toggle(it) },
        onResend = { chat?.resend() },
        onDiscard = { chat?.discard() },
        onLink = { url ->
            try {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            } catch (_: ActivityNotFoundException) {
                viewModel.showNotice("No app on this phone opens that link.")
            }
        },
    )
}
