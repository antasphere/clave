package com.clave.core.contract

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The shell's reads decode the shapes `@clave/contract` sends (sidebar/overview, the account
 * lists, the usage snapshots, server-info), each expected value written by hand so a decoder
 * that drops or renames a field cannot agree with itself.
 */
class ShellReadsTest {
    private fun json(text: String): JsonElement = Json.parseToJsonElement(text)

    @Test
    fun overviewKeepsEveryWindowAndTheSidebarOrder() {
        val overview = ShellDecode.sidebarOverview(
            json(
                """{"windows":[
                  {"windowKey":"main","workspaceId":"ws1","displayOrder":["g2","s9","g1"],
                   "groups":[{"id":"g1","name":"Auth","color":"blue","collapsed":true,"sessionIds":["s1","s2"]},
                             {"id":"g2","name":"Docs","collapsed":false,"workspaceId":"ws2","sessionIds":[],"extra":1}]},
                  {"windowKey":"server","displayOrder":[],"groups":[]}
                ]}""",
            ),
        )
        assertEquals(
            SidebarOverview(
                listOf(
                    SidebarWindowView(
                        windowKey = "main",
                        workspaceId = "ws1",
                        displayOrder = listOf("g2", "s9", "g1"),
                        groups = listOf(
                            SidebarGroupView("g1", "Auth", "blue", collapsed = true, sessionIds = listOf("s1", "s2")),
                            SidebarGroupView("g2", "Docs", null, collapsed = false, workspaceId = "ws2", sessionIds = emptyList()),
                        ),
                    ),
                    SidebarWindowView("server", null, emptyList(), emptyList()),
                ),
            ),
            overview,
        )
    }

    @Test
    fun aGroupWithoutTheCollapsedFlagReadsOpen() {
        val overview = ShellDecode.sidebarOverview(
            json("""{"windows":[{"windowKey":"w","displayOrder":["g"],"groups":[{"id":"g","name":"G","sessionIds":["s"]}]}]}"""),
        )
        assertEquals(false, overview.windows.single().groups.single().collapsed)
    }

    @Test
    fun aGroupMissingItsSessionsIsRefusedByPath() {
        try {
            ShellDecode.sidebarOverview(json("""{"windows":[{"windowKey":"w","displayOrder":[],"groups":[{"id":"g","name":"G"}]}]}"""))
            fail("expected a DecodeError")
        } catch (e: DecodeError) {
            assertTrue(e.message.orEmpty(), e.message.orEmpty().contains("overview.windows[0].groups[0].sessionIds"))
        }
    }

    @Test
    fun accountListsReadBareOrWrapped() {
        val claude = """[{"id":"a1","label":"Work","hasToken":true,"tokenSetAt":10,"tokenExpiresAt":null,"tokenInvalid":false}]"""
        val expected = listOf(ClaudeAccountView("a1", "Work", hasToken = true, tokenSetAt = 10, tokenExpiresAt = null, tokenInvalid = false))
        assertEquals(expected, ShellDecode.claudeAccounts(json(claude)))
        assertEquals(expected, ShellDecode.claudeAccounts(json("""{"accounts":$claude}""")))
        assertEquals(
            listOf(CodexAccountView("c1", "Personal", "chatgpt", hasCredential = false)),
            ShellDecode.codexAccounts(json("""[{"id":"c1","label":"Personal","kind":"chatgpt","hasCredential":false}]""")),
        )
    }

    @Test
    fun aUsageSnapshotKeepsLimitsAndErrorsAndSkipsAnUnknownRead() {
        val snapshot = ShellDecode.usageSnapshot(
            json(
                """{
                  "a1":{"windows":[{"key":"five_hour","label":"5-hour","kind":"session","scope":null,"usedPercentage":42.5,"resetsAt":1000,"severity":"normal"},
                                   {"key":"weekly_fable","label":"Fable week","kind":"weekly_scoped","scope":"Fable","usedPercentage":99,"resetsAt":null,"severity":"lavender"}],
                        "fetchedAt":500},
                  "a2":{"error":"Token refused","reason":"unauthorized"},
                  "a3":{"something":"new"}
                }""",
            ),
        )
        assertEquals(
            mapOf(
                "a1" to UsageRead.Limits(
                    windows = listOf(
                        UsageWindow("five_hour", "5-hour", "session", null, 42.5, 1000, UsageSeverity.Normal),
                        // A severity this phone does not know reads as none, never as a failure.
                        UsageWindow("weekly_fable", "Fable week", "weekly_scoped", "Fable", 99.0, null, null),
                    ),
                    fetchedAt = 500,
                ),
                "a2" to UsageRead.Failed("Token refused", unauthorized = true),
            ),
            snapshot,
        )
    }

    @Test
    fun serverInfoReadsTheVersionAndTheOptionalName() {
        assertEquals(
            ServerInfoView("1.42.0", "studio-mac"),
            ShellDecode.serverInfo(json("""{"version":"1.42.0","installRef":null,"upgrade":{"state":"idle"},"name":"studio-mac"}""")),
        )
        assertEquals(ServerInfoView("1.41.0"), ShellDecode.serverInfo(json("""{"version":"1.41.0","installRef":null,"upgrade":{"state":"idle"}}""")))
    }
}
