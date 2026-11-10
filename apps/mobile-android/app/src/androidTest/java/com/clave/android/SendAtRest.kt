package com.clave.android

import android.os.SystemClock
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.AndroidComposeTestRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Send, tapped as a person taps it: once the keyboard the typing opened is up and the composer has
 * stopped moving with it. performTextInput can return before a slow keyboard starts to animate, and
 * performClick's own idle wait does not cover that animation, so a tap injected at once can land
 * where Send was a frame earlier and never become a click: Send enabled at every frame, nothing
 * sent, the text left in the field. The probe of 10 November on both emulators lost 5 of 360 taps,
 * each one injected while Send was moving by more than 63 px with the keyboard; none of the 355 made
 * with Send still was lost, and the 160 ordinary taps made at rest were all taken. The tap stays an
 * ordinary touch, so an app that does not send on it still fails the test that taps. A keyboard that
 * never comes up fails the wait, by name.
 */
internal fun AndroidComposeTestRule<*, out ComponentActivity>.tapSendAtRest(timeoutMs: Long) {
    val send = onNodeWithContentDescription("Send message")
    waitUntil("the keyboard up and Send at rest", timeoutMs) {
        val before = send.fetchSemanticsNode().boundsInWindow
        SystemClock.sleep(300)
        imeBottom() > 0 && before == send.fetchSemanticsNode().boundsInWindow
    }
    send.performClick()
}

private fun AndroidComposeTestRule<*, out ComponentActivity>.imeBottom(): Int = runOnUiThread {
    ViewCompat.getRootWindowInsets(activity.window.decorView)?.getInsets(WindowInsetsCompat.Type.ime())?.bottom ?: 0
}
