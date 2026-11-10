package com.clave.android

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The one pending ask for the notification permission, served by the activity's
 * `RequestPermission` launcher: [ask] answers the person's choice, or false at once when no
 * activity is there to ask (a background registration never prompts). A new ask answers
 * the one before it false; the activity leaving answers the pending one false.
 */
object NotificationPermissionRequests {
    private var launch: (() -> Unit)? = null
    private var pending: CompletableDeferred<Boolean>? = null

    /** The activity offers its launcher; [launcher] must be called on the main thread. */
    @Synchronized
    fun attach(launcher: () -> Unit) {
        launch = launcher
    }

    /** The activity is gone: nothing is asked any more and the pending ask answers false. */
    @Synchronized
    fun detach(launcher: () -> Unit) {
        if (launch !== launcher) return
        launch = null
        pending?.complete(false)
        pending = null
    }

    /** Asks the person through the activity; false when none is attached. */
    suspend fun ask(): Boolean {
        val answer = CompletableDeferred<Boolean>()
        val launcher = synchronized(this) {
            val current = launch ?: return false
            pending?.complete(false)
            pending = answer
            current
        }
        withContext(Dispatchers.Main) { launcher() }
        return answer.await()
    }

    /** The launcher's result. */
    @Synchronized
    fun answer(granted: Boolean) {
        pending?.complete(granted)
        pending = null
    }
}
