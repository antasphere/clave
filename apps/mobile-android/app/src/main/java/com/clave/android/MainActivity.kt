package com.clave.android

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.clave.android.ui.ClaveApp
import com.clave.android.ui.ClaveViewModel
import com.clave.ui.theme.claveColorsFor
import com.clave.ui.theme.themeFor

/**
 * The one activity: edge to edge, the notification permission's launcher registered before
 * any content, and the app. The URL it was launched with goes to the app's own cold-launch
 * rule and is taken off the intent, so the navigation library never handles it a second
 * time; a VIEW intent that arrives while it runs is handed to the app's navigation.
 */
class MainActivity : ComponentActivity() {
    private val viewModel: ClaveViewModel by viewModels { ClaveViewModel.factory(services(this)) }

    // Firebase's play-services-basement pulls androidx.fragment 1.1.0 onto the classpath; this
    // activity is a ComponentActivity with no fragment, so the result never routes through one.
    @SuppressLint("InvalidFragmentVersionForActivityResult")
    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        NotificationPermissionRequests.answer(granted)
    }

    private val askNotifications: () -> Unit = { notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS) }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        NotificationPermissionRequests.attach(askNotifications)
        val launchUrl = if (savedInstanceState == null) intent?.dataString else null
        intent?.data = null
        val services = services(this)
        setContent {
            val appearance by viewModel.appearance.collectAsStateWithLifecycle()
            val dark = claveColorsFor(themeFor(appearance, isSystemInDarkTheme())).isDark
            val view = LocalView.current
            SideEffect {
                val bars = WindowCompat.getInsetsController(window, view)
                bars.isAppearanceLightStatusBars = !dark
                bars.isAppearanceLightNavigationBars = !dark
            }
            ClaveApp(services, launchUrl, viewModel)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        intent.dataString?.let(viewModel::receiveUrl)
    }

    override fun onDestroy() {
        NotificationPermissionRequests.detach(askNotifications)
        super.onDestroy()
    }
}
