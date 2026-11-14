package com.clave.core.chat

import com.clave.core.contract.EffortOption
import com.clave.core.contract.IdLabel
import com.clave.core.contract.ModelOption
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ControlsTest {
    private val options = listOf(
        ModelOption(id = "default", label = "Default (recommended)", resolved = "claude-opus-5-5",
            efforts = listOf(EffortOption("low", "Low"), EffortOption("high", "High")), defaultEffort = "high"),
        ModelOption(id = "claude-fable-5-1[1m]", label = "Fable 5.1"),
        ModelOption(id = "claude-haiku-4-5-20251001", label = "Haiku 4.5"),
    )

    @Test
    fun `a model id reads as its name, an unknown one by its shape`() {
        assertEquals("Opus 5.5", claudeModelName("claude-opus-5-5"))
        assertEquals("Opus 5.5", claudeModelName("opus"))
        assertEquals("Fable 5.1", claudeModelName("claude-fable-5-1"))
        assertEquals("Opus 6", claudeModelName("claude-opus-6-20270101"))
        assertEquals("gpt-5.3-codex", claudeModelName("gpt-5.3-codex"))
        assertNull(claudeModelName("default[1m]"))
        assertNull(claudeModelName(null))
    }

    @Test
    fun `the chip names the option, else the id's name, else waits`() {
        assertEquals("Default", modelChipLabel("default", options))
        assertEquals("Default", modelChipLabel("claude-opus-5-5", options))
        assertEquals("Haiku 4.5", modelChipLabel("claude-haiku-4-5", options))
        assertEquals("Sonnet 5.5", modelChipLabel("claude-sonnet-5-5", null))
        assertEquals(MODEL_PENDING, modelChipLabel(null, options))
    }

    @Test
    fun `the effort chip offers the model's levels and marks the reported one or the default`() {
        val choice = effortChoice("claude-opus-5-5", "low", options)!!
        assertEquals(listOf("low", "high"), choice.efforts.map { it.id })
        assertEquals("low", choice.current?.id)
        assertEquals("high", effortChoice("default", null, options)?.current?.id)
        assertNull(effortChoice("claude-fable-5-1[1m]", "high", options))
        assertNull(effortChoice("claude-opus-5-5", "high", null))
        assertEquals("High", effortWord("high"))
        assertNull(effortWord(null))
    }

    @Test
    fun `the context meter writes tokens the desktop's way`() {
        assertEquals("950", compactTokens(950))
        assertEquals("12k", compactTokens(12_400))
        assertEquals("1M", compactTokens(1_000_000))
        assertEquals("1.2M", compactTokens(1_234_567))
        assertEquals("50k/200k", contextMeterLabel(50_000, 200_000))
        assertEquals("0/1M", contextMeterLabel(null, 1_000_000))
        assertEquals("—", contextMeterLabel(null, null))
        assertEquals("3k", contextMeterLabel(3_000, null))
        assertEquals(0.25f, contextRatio(50_000, 200_000), 0.0001f)
        assertEquals(1f, contextRatio(300, 200), 0.0001f)
        assertEquals(0f, contextRatio(null, 200), 0.0001f)
        assertEquals(1_000_000L, claudeContextWindow("claude-opus-5-5"))
        assertEquals(1_000_000L, claudeContextWindow("whatever[1m]"))
        assertEquals(200_000L, claudeContextWindow("haiku"))
        assertNull(claudeContextWindow("gpt-5"))
    }

    @Test
    fun `a mode reads by its label and a provider by its name`() {
        assertEquals("Plan", permissionModeLabel("plan", listOf(IdLabel("default", "Ask"), IdLabel("plan", "Plan"))))
        assertEquals("bypass", permissionModeLabel("bypass", emptyList()))
        assertEquals("Claude", providerLabel("claude"))
        assertEquals("other", providerLabel("other"))
    }
}

class RelativeTimeTest {
    private val zone = java.time.ZoneOffset.UTC
    private val now = java.time.LocalDateTime.of(2026, 11, 14, 15, 0).toInstant(zone).toEpochMilli()
    private val minute = 60_000L

    @Test
    fun `a turn is stamped relative to now, then by its day`() {
        assertEquals("just now", relativeTime(now - 20_000, now, zone))
        assertEquals("just now", relativeTime(now + 5 * minute, now, zone))
        assertEquals("5 min ago", relativeTime(now - 5 * minute, now, zone))
        assertEquals("3 h ago", relativeTime(now - 180 * minute, now, zone))
        assertEquals("yesterday", relativeTime(now - 20 * 60 * minute, now, zone))
        assertEquals("10 Nov", relativeTime(now - 4 * 24 * 60 * minute, now, zone))
        assertEquals("14 Nov 2025", relativeTime(now - 365L * 24 * 60 * minute, now, zone))
    }
}

class ElapsedTest {
    @Test
    fun `background work counts seconds, then minutes, then hours`() {
        assertEquals("0s", elapsed(1_000, 500))
        assertEquals("42s", elapsed(0, 42_900))
        assertEquals("3m 5s", elapsed(0, 185_000))
        assertEquals("1h 12m", elapsed(0, 72 * 60_000L))
    }
}

class SlashTest {
    private val commands = listOf(
        com.clave.core.contract.CommandOption("compact", "Compact the context", "/compact "),
        com.clave.core.contract.CommandOption("review", insert = "/review "),
        com.clave.core.contract.CommandOption("mcp:docs", insert = "/mcp:docs "),
    )

    @Test
    fun `a slash at the start lists the commands, filtered as it is typed`() {
        assertEquals(3, slashMatches("/", commands).size)
        assertEquals(listOf("compact"), slashMatches("/com", commands).map { it.name })
        assertEquals(listOf("mcp:docs"), slashMatches("/MCP:", commands).map { it.name })
        assertEquals(emptyList<Any>(), slashMatches("/compact now", commands))
        assertEquals(emptyList<Any>(), slashMatches("hello /com", commands))
        assertEquals(emptyList<Any>(), slashMatches("/", null))
        assertEquals("", slashQuery("/"))
        assertEquals(null, slashQuery("/a\nb"))
    }
}
