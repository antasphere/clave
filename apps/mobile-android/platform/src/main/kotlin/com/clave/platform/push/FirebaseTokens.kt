package com.clave.platform.push

import android.content.Context
import com.clave.core.contract.DevicePlatform
import com.clave.core.notifications.DeviceToken
import com.clave.core.notifications.PushTokenSource
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * The core's [PushTokenSource] on Firebase Cloud Messaging. A build without a Firebase
 * project hands no token (the core reports Unsupported) and never touches
 * [FirebaseMessaging], which would throw; a build with one answers the FCM token as an
 * Android device token. The token is handed to the core and never logged here.
 */
class FirebaseTokens(private val context: Context) : PushTokenSource {
    // getToken() is deprecated in firebase-messaging 26 with no public replacement for the FCM token.
    @Suppress("DEPRECATION")
    override suspend fun deviceToken(): DeviceToken? {
        if (FirebaseApp.getApps(context).isEmpty()) return null
        val token = suspendCancellableCoroutine { continuation ->
            FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                if (task.isSuccessful) {
                    continuation.resume(task.result)
                } else {
                    continuation.resumeWithException(task.exception ?: IllegalStateException("Firebase handed no token."))
                }
            }
        }
        return DeviceToken(DevicePlatform.Android.wire, token)
    }
}
