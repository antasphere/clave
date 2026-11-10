package com.clave.ui.screens

import com.clave.core.chat.PhoneSessionState
import com.clave.core.contract.LaunchProfileView
import com.clave.core.contract.LauncherFamily
import com.clave.core.contract.MachinePlatform
import com.clave.core.devices.Machine
import com.clave.ui.theme.SessionStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import com.clave.core.chat.Reachability as CoreReachability
import com.clave.ui.theme.Reachability as UiReachability

class StatusMappingTest {
    private val now = 1_800_000_000_000L
    private val minute = 60_000L

    private fun machine(
        platform: MachinePlatform = MachinePlatform.Macos,
        version: String = "1.2.3",
        online: Boolean = false,
        lastSeen: Long? = null,
    ) = Machine("m1", "Studio", platform, version, online, lastSeen, "https://studio.local", "wss://studio.local")

    @Test
    fun anOnlineMachineSaysWhatItIsAndThatItIsOnline() {
        assertEquals("macOS · Clave 1.2.3 · online", describeMachine(machine(online = true), now))
        assertEquals("Linux · online", describeMachine(machine(MachinePlatform.Linux, version = "", online = true), now))
    }

    @Test
    fun anOfflineMachineSaysWhenItWasLastSeen() {
        val server = MachinePlatform.Unknown
        assertEquals("Clave server · never seen", describeMachine(machine(server, version = ""), now))
        assertEquals("Clave server · seen just now", describeMachine(machine(server, version = "", lastSeen = now - 20_000), now))
        assertEquals("Clave server · seen 5 min ago", describeMachine(machine(server, version = "", lastSeen = now - 5 * minute), now))
        assertEquals("Clave server · seen 3 h ago", describeMachine(machine(server, version = "", lastSeen = now - 180 * minute), now))
    }

    @Test
    fun aMachineSeenTwoDaysAgoOrMoreIsDated() {
        val seen = now - 72 * 60 * minute
        assertEquals(
            "macOS · Clave 1.2.3 · seen day $seen",
            describeMachine(machine(lastSeen = seen), now, date = { "day $it" }),
        )
    }

    @Test
    fun minutesAndHoursRoundHalfUpLikeThePrototype() {
        // 30 s rounds to one minute; 47.5 h rounds to 48, which is dated.
        assertEquals("macOS · Clave 1.2.3 · seen 1 min ago", describeMachine(machine(lastSeen = now - 30_000), now))
        assertEquals(
            "macOS · Clave 1.2.3 · seen dated",
            describeMachine(machine(lastSeen = now - (47 * 60 + 30) * minute), now, date = { "dated" }),
        )
    }

    @Test
    fun theBasenameIsTheLastSegment() {
        assertEquals("app", basename("/Users/me/code/app"))
        assertEquals("app", basename("/Users/me/code/app/"))
        assertEquals("/", basename("/"))
        assertEquals("notes", basename("notes"))
    }

    private fun profile(id: String) = LaunchProfileView(id, id, LauncherFamily.Claude, listOf("claude"), emptyList())

    @Test
    fun chatProfilesAreTheKnownIdsAndTheChatPrefix() {
        listOf("claude-chat", "codex-chat", "dev-echo-adapter", "chat:mine").forEach { assertTrue(it, isChatProfile(profile(it))) }
        listOf("claude", "codex", "my-chat", "Chat:upper").forEach { assertFalse(it, isChatProfile(profile(it))) }
    }

    @Test
    fun everySessionStateMapsToTheSameNamedStatus() {
        assertEquals(PhoneSessionState.entries.map { it.name }, PhoneSessionState.entries.map { it.toStatus().name })
        assertEquals(SessionStatus.entries.toSet(), PhoneSessionState.entries.map { it.toStatus() }.toSet())
        assertEquals("Waiting for you", PhoneSessionState.Waiting.toStatus().label)
    }

    @Test
    fun everyReachabilityMapsToTheSameNamedOne() {
        assertEquals(CoreReachability.entries.map { it.name }, CoreReachability.entries.map { it.toReachability().name })
        assertEquals(UiReachability.entries.toSet(), CoreReachability.entries.map { it.toReachability() }.toSet())
    }

    @Test
    fun theLaunchCaptionNamesTheSourceOnlyWhenItDiffers() {
        assertEquals("Runs on Studio · its own saved profiles", launchCaption("Studio", "Studio"))
        assertEquals("Runs on Build box · profiles of Studio", launchCaption("Build box", "Studio"))
        assertEquals("Runs on Studio · its own saved profiles", launchCaption("Studio", null))
    }

    @Test
    fun thePairingCountdownIsMinutesAndSecondsAndNeverNegative() {
        assertEquals("4:05", expiresIn(now + 245_000, now))
        assertEquals("0:00", expiresIn(now - 10_000, now))
    }
}
