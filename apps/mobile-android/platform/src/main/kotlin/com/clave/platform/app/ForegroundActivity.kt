package com.clave.platform.app

import android.app.Activity
import android.app.Application
import android.os.Bundle
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Which of the app's activities is in front, from the application's lifecycle callbacks:
 * [current] is the resumed activity and is cleared on its pause, so nothing launches from an
 * activity the person has left; [isForeground] holds while any activity is started. The
 * callbacks arrive on the main thread; listeners are called there, and each subscription
 * answers its own unsubscribe.
 */
class ForegroundActivity(application: Application) {
    @Volatile
    var current: Activity? = null
        private set

    @Volatile
    private var started = 0

    val isForeground: Boolean get() = started > 0

    private val resumedListeners = CopyOnWriteArrayList<(Activity) -> Unit>()
    private val foregroundListeners = CopyOnWriteArrayList<(Boolean) -> Unit>()

    init {
        application.registerActivityLifecycleCallbacks(
            object : Application.ActivityLifecycleCallbacks {
                override fun onActivityStarted(activity: Activity) {
                    started += 1
                    if (started == 1) foregroundListeners.forEach { it(true) }
                }

                override fun onActivityResumed(activity: Activity) {
                    current = activity
                    resumedListeners.forEach { it(activity) }
                }

                override fun onActivityPaused(activity: Activity) {
                    if (current === activity) current = null
                }

                override fun onActivityStopped(activity: Activity) {
                    started = maxOf(0, started - 1)
                    if (started == 0) foregroundListeners.forEach { it(false) }
                }

                override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}

                override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}

                override fun onActivityDestroyed(activity: Activity) {
                    if (current === activity) current = null
                }
            },
        )
    }

    fun onResumed(listener: (Activity) -> Unit): () -> Unit {
        resumedListeners += listener
        return { resumedListeners -= listener }
    }

    fun onForegroundChange(listener: (Boolean) -> Unit): () -> Unit {
        foregroundListeners += listener
        return { foregroundListeners -= listener }
    }
}
