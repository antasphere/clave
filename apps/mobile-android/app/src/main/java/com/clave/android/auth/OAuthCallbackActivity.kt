package com.clave.android.auth

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.clave.platform.auth.OAuthCallbacks

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
