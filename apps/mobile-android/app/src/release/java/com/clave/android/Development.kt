package com.clave.android

import androidx.compose.runtime.Composable
import androidx.navigation.NavController
import androidx.navigation.NavGraphBuilder
import com.clave.android.ui.ClaveViewModel
import com.clave.core.ports.KeyValueStore

/**
 * What a release build offers of the development tools: nothing. The sign-in is the
 * Antasphere hub's, no developer screen is registered, and the Machines screen carries no
 * developer card, so the release APK holds no class of the developer package at all.
 */
object Development {
    /** A release build signs in with the hub only. */
    @Suppress("UNUSED_PARAMETER", "RedundantSuspendModifier")
    suspend fun issuerOverride(kv: KeyValueStore): String? = null

    /** A release build registers no development destination. */
    @Suppress("UNUSED_PARAMETER")
    fun routes(builder: NavGraphBuilder, services: AppServices, viewModel: ClaveViewModel, navController: NavController) = Unit

    /** No developer card on the Machines screen. */
    val machinesCard: (@Composable (onOpen: () -> Unit) -> Unit)? = null
}
