package com.clave.platform.auth

/**
 * The one pending sign-in's mailbox: the browser's redirect, or null when dismissed. A new
 * sign-in dismisses the one before it, and a redirect reaches one handler once.
 */
object OAuthCallbacks {
    private var pending: ((String?) -> Unit)? = null

    @Synchronized
    fun await(handler: (String?) -> Unit) {
        pending?.invoke(null)
        pending = handler
    }

    @Synchronized
    fun deliver(redirect: String?) {
        val handler = pending
        pending = null
        handler?.invoke(redirect)
    }

    /** Forgets [handler] without calling it, when it is still the pending one: a cancelled
     *  sign-in leaves the mailbox, and never empties a newer sign-in's. */
    @Synchronized
    fun release(handler: (String?) -> Unit) {
        if (pending === handler) pending = null
    }
}
