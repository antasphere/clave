package com.clave.android.auth

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * Where the browser lands after the sign-in (clave-android://oauth/callback?…): the
 * redirect URL is handed to the app's one pending sign-in and this activity finishes at
 * once. It shows nothing and keeps nothing.
 */
class OAuthCallbackActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uri = intent?.data
        if (uri != null) OAuthCallbacks.deliver(uri.toString())
        startActivity(
            Intent(this, com.clave.android.MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        )
        finish()
    }
}

/** The one pending sign-in's mailbox: the browser's redirect, or null when dismissed. */
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
}
