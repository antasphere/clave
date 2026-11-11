package com.clave.android

import androidx.compose.runtime.Composable
import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder
import androidx.navigation.compose.composable
import com.clave.android.developer.DeveloperCard
import com.clave.android.developer.DeveloperScreen
import com.clave.android.developer.DevelopmentIssuer
import com.clave.android.ui.ClaveViewModel
import com.clave.android.ui.Routes
import com.clave.core.ports.KeyValueStore

/**
 * The development build's tools, behind the one symbol the main source set reaches: the
 * sign-in issuer override (a local test provider), the developer screen (a standalone server
 * by address and token, and the issuer), and its card on the Machines screen. The release
 * build defines the same object with none of them.
 */
object Development {
    /** The stored issuer override; blank or absent is the Antasphere hub. */
    suspend fun issuerOverride(kv: KeyValueStore): String? = DevelopmentIssuer.read(kv)

    /** Adds the developer destination. */
    fun routes(builder: NavGraphBuilder, services: AppServices, viewModel: ClaveViewModel, navController: NavController) {
        builder.composable(Routes.DEVELOPER) {
            DeveloperScreen(services = services, viewModel = viewModel, onBack = { navController.popBackStack() })
        }
    }

    /** The Machines screen's developer slot: a row that opens the developer screen. */
    val machinesCard: (@Composable (onOpen: () -> Unit) -> Unit)? = { onOpen -> DeveloperCard(onOpen) }
}
