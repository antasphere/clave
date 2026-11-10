package com.clave.platform.auth

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.browser.customtabs.CustomTabsIntent
import com.clave.core.auth.OpenAuthSession
import com.clave.platform.app.ForegroundActivity
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

/**
 * The core's [OpenAuthSession] in the system browser: a Custom Tab (a plain browser view when
 * no browser offers one), launched from the resumed activity, answered by [callbacks] when
 * the browser comes back on the redirect. The person can also come back without signing in:
 * when one of the app's activities other than [callbackActivity] resumes and no redirect has
 * arrived [dismissGraceMs] later, the session answers null. Whichever answer comes first is
 * the only one; a cancelled session answers nothing and leaves the mailbox.
 */
class CustomTabsAuthSession(
    private val foreground: ForegroundActivity,
    private val callbacks: OAuthCallbacks = OAuthCallbacks,
    private val dismissGraceMs: Long = 1_500,
    /** The activity the redirect lands on; its resume is not a dismissal. */
    private val callbackActivity: Class<out Activity>? = null,
) {
    val open: OpenAuthSession = { url, redirectUri -> open(url, redirectUri) }

    @Suppress("UNUSED_PARAMETER")
    suspend fun open(url: String, redirectUri: String): String? = withContext(Dispatchers.Main) {
        val activity = foreground.current
            ?: throw IllegalStateException("No activity is in the foreground to open the sign-in.")
        val main = Handler(Looper.getMainLooper())
        suspendCancellableCoroutine { continuation ->
            val done = AtomicBoolean(false)
            var unsubscribe: () -> Unit = {}
            lateinit var handler: (String?) -> Unit
            // Answers this session only: a newer sign-in in the mailbox is left alone.
            val dismiss = Runnable {
                callbacks.release(handler)
                handler(null)
            }
            handler = { redirect ->
                if (done.compareAndSet(false, true)) {
                    main.removeCallbacks(dismiss)
                    main.post { unsubscribe() }
                    continuation.resume(redirect)
                }
            }
            callbacks.await(handler)
            unsubscribe = foreground.onResumed { resumed ->
                if (callbackActivity?.isInstance(resumed) != true && !done.get()) {
                    main.removeCallbacks(dismiss)
                    main.postDelayed(dismiss, dismissGraceMs)
                }
            }
            continuation.invokeOnCancellation {
                done.set(true)
                main.removeCallbacks(dismiss)
                callbacks.release(handler)
                main.post { unsubscribe() }
            }
            val uri = Uri.parse(url)
            try {
                CustomTabsIntent.Builder()
                    .setShowTitle(false)
                    .setShareState(CustomTabsIntent.SHARE_STATE_OFF)
                    .build()
                    .launchUrl(activity, uri)
            } catch (_: ActivityNotFoundException) {
                try {
                    activity.startActivity(Intent(Intent.ACTION_VIEW, uri))
                } catch (e: ActivityNotFoundException) {
                    done.set(true)
                    callbacks.release(handler)
                    unsubscribe()
                    throw e
                }
            }
        }
    }
}
