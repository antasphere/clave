package com.clave.platform.push

import android.content.Context
import android.os.Build
import androidx.core.app.NotificationManagerCompat
import com.clave.core.state.PushPermission

/**
 * The core's [PushPermission] on the platform: granted when the app's notifications are
 * enabled; otherwise, when the core asks to prompt and the system has a runtime permission for
 * it (API 33 and later), the app's activity is asked through [request] and its answer stands.
 * Never prompts on its own.
 */
class NotificationPermission(
    private val context: Context,
    private val request: suspend () -> Boolean,
) : PushPermission {
    override suspend fun granted(request: Boolean): Boolean {
        if (NotificationManagerCompat.from(context).areNotificationsEnabled()) return true
        if (request && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return this.request()
        return false
    }
}
