package com.clave.core.state

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/** persistence.test.ts, on the Android app's own scheme. */
class LaunchTest {
    @Test
    fun `a cold launch opens Machines then the Workspaces of the current machine`() {
        assertEquals(
            RouteState(1, listOf(LaunchRoute("Machines"), LaunchRoute("Workspaces", mapOf("machineId" to "m1")))),
            coldLaunchState("m1"),
        )
        assertEquals(RouteState(0, listOf(LaunchRoute("Machines"))), coldLaunchState(null))
    }

    @Test
    fun `a new process opens Workspaces whatever the app showed before, no saved screen is read`() {
        // The only inputs of a cold launch are the current machine and a deep link.
        assertFalse(coldLaunchState("m1").routes.map { it.name }.contains("Chat"))
    }

    @Test
    fun `a deep link opens the conversation from a cold start, over its machine's workspaces`() {
        val expected = deepLinkState("m1", "s1")
        assertEquals(expected, stateForPath("clave-android://chat/m1/s1"))
        assertEquals(expected, stateForPath("chat/m1/s1"))
        assertEquals(expected, stateForPath("/chat/m1/s1?from=notification"))
        assertEquals(listOf("Machines", "Workspaces", "Chat"), expected.routes.map { it.name })
        assertEquals(mapOf("machineId" to "m1", "sessionId" to "s1"), expected.routes[2].params)
    }

    @Test
    fun `round-trips the ids a link carries, encoded`() {
        val path = chatPath("dev:127.0.0.1:43201", "sess/with slash")
        assertEquals("chat/dev%3A127.0.0.1%3A43201/sess%2Fwith%20slash", path)
        assertEquals(
            mapOf("machineId" to "dev:127.0.0.1:43201", "sessionId" to "sess/with slash"),
            stateForPath("clave-android://$path")?.routes?.get(2)?.params,
        )
    }

    @Test
    fun `a link the app does not know opens nothing`() {
        assertNull(stateForPath("clave-android://settings"))
        assertNull(stateForPath("clave-android://chat/m1"))
        assertNull(stateForPath("clave-android://chat/%E0%A4%A/s1"))
        assertNull(stateForPath(""))
    }

    @Test
    fun `names the machine of a screen tree`() {
        assertEquals("m1", machineIdOf(deepLinkState("m1", "s1")))
        assertNull(machineIdOf(coldLaunchState(null)))
        assertNull(machineIdOf(null))
    }

    @Test
    fun `opens a notification conversation instead of the selected machine on a new process`() {
        assertEquals(deepLinkState("new-machine", "s1"), initialLaunchState("old-machine", "clave-android://chat/new-machine/s1"))
        assertEquals(coldLaunchState("old-machine"), initialLaunchState("old-machine", null))
        assertEquals(coldLaunchState("old-machine"), initialLaunchState("old-machine", "clave-android://unknown"))
        // The iOS app's scheme is another install's link, not this one's.
        assertEquals(coldLaunchState("old-machine"), initialLaunchState("old-machine", "clave://chat/new-machine/s1"))
        assertEquals("clave.last-machine", LAST_MACHINE_KEY)
    }
}
