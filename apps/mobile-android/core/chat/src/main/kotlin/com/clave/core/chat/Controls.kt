/**
 * What the composer's status row says and offers: the model, its effort, the permission mode
 * and the context meter, in the desktop's words. Ported from the desktop chat view's
 * `models.ts`, `terminal-status.ts` (`compactTokens`) and `src/shared/claude-models.ts`; the
 * desktop's files are the original.
 */
package com.clave.core.chat

import com.clave.core.contract.EffortOption
import com.clave.core.contract.IdLabel
import com.clave.core.contract.ModelOption

/** One Claude model Clave names: what `set_model` takes, how it reads, the context it reads. */
data class ClaudeModel(val id: String, val name: String, val alias: String, val window: Long)

/** The desktop's `CLAUDE_MODELS`, edited by hand there when a model ships or retires. */
val CLAUDE_MODELS: List<ClaudeModel> = listOf(
    ClaudeModel("claude-opus-5-5", "Opus 5.5", "opus", 1_000_000),
    ClaudeModel("claude-fable-5-1[1m]", "Fable 5.1", "fable", 1_000_000),
    ClaudeModel("claude-fable-5[1m]", "Fable 5", "fable", 1_000_000),
    ClaudeModel("claude-sonnet-5-5", "Sonnet 5.5", "sonnet", 1_000_000),
    ClaudeModel("claude-haiku-4-5-20251001", "Haiku 4.5", "haiku", 200_000),
)

private val CONTEXT_SUFFIX = Regex("\\[[^\\]]*]$")
private val DATE_STAMP = Regex("-\\d{8}$")
private val FAMILY = Regex("^claude-([a-z]+)-(\\d+)(?:-(\\d{1,2}))?$")

/** An id without its context suffix (`[1m]`) and its date stamp. */
private fun bare(id: String): String = id.replace(CONTEXT_SUFFIX, "").replace(DATE_STAMP, "")

/** Whether two ids name one model, a context suffix or a date stamp aside. */
fun sameModelId(reported: String, id: String): Boolean = bare(reported) == bare(id)

fun findClaudeModel(id: String?): ClaudeModel? {
    if (id.isNullOrEmpty()) return null
    val plain = bare(id)
    return CLAUDE_MODELS.firstOrNull { it.id == id }
        ?: CLAUDE_MODELS.firstOrNull { bare(it.id) == plain }
        ?: CLAUDE_MODELS.firstOrNull { it.alias == plain }
}

/**
 * How a model id reads: "claude-opus-5-5" and "opus" both read "Opus 5.5", an id the list
 * does not know yet reads from its own shape ("claude-opus-6-20270101" → "Opus 6"), anything
 * else as it came. The CLI's `default` alias names no model: null.
 */
fun claudeModelName(id: String?): String? {
    if (id.isNullOrEmpty()) return null
    if (bare(id) == "default") return null
    findClaudeModel(id)?.let { return it.name }
    val shape = FAMILY.find(bare(id)) ?: return id
    val family = shape.groupValues[1].replaceFirstChar { it.uppercase() }
    val minor = shape.groupValues[3]
    return "$family ${shape.groupValues[2]}${if (minor.isNotEmpty()) ".$minor" else ""}"
}

/** The context window of a model, when it is known before any turn says so. */
fun claudeContextWindow(id: String?): Long? {
    if (id.isNullOrEmpty()) return null
    if (id.lowercase().endsWith("[1m]")) return 1_000_000
    return findClaudeModel(id)?.window
}

/** The option a reported model is: the one named exactly, then the first whose model it resolves to. */
fun currentModelOption(reported: String?, options: List<ModelOption>?): ModelOption? {
    if (reported == null || options == null) return null
    return options.firstOrNull { it.id == reported }
        ?: options.firstOrNull { sameModelId(reported, it.id) || (it.resolved != null && sameModelId(reported, it.resolved!!)) }
}

/** The word the chip shows while no model is known yet; never "Default", which names none. */
const val MODEL_PENDING: String = "…"

private val TRAILING_GLOSS = Regex("\\s*\\([^)]*\\)\\s*$")

/** How the chip names the model: the option's label once the list is in, else the name the id reads as. */
fun modelChipLabel(model: String?, options: List<ModelOption>?): String =
    (currentModelOption(model, options)?.label ?: claudeModelName(model) ?: MODEL_PENDING).replace(TRAILING_GLOSS, "")

/** The effort levels the session's model offers and the one to mark; null hides the chip. */
data class EffortChoice(val efforts: List<EffortOption>, val current: EffortOption?)

fun effortChoice(model: String?, effort: String?, options: List<ModelOption>?): EffortChoice? {
    val option = currentModelOption(model, options) ?: return null
    val efforts = option.efforts?.takeIf { it.isNotEmpty() } ?: return null
    val current = efforts.firstOrNull { it.id == effort } ?: efforts.firstOrNull { it.id == option.defaultEffort }
    return EffortChoice(efforts, current)
}

/**
 * The effort chip's word before the model list is in: the level the provider reported,
 * capitalised ("high" → "High"); null when it has said none.
 */
fun effortWord(effort: String?): String? = effort?.takeIf { it.isNotBlank() }?.replaceFirstChar { it.uppercase() }

/** The mode's label among the provider's modes, else its id. */
fun permissionModeLabel(mode: String, modes: List<IdLabel>): String = modes.firstOrNull { it.id == mode }?.label ?: mode

private val PROVIDER_LABELS = mapOf("claude" to "Claude", "codex" to "Codex", "pi" to "Pi", "echo" to "Echo", "antigravity" to "Antigravity")

/** How a provider reads: the agent's name. */
fun providerLabel(provider: String): String = PROVIDER_LABELS[provider] ?: provider

/** A token count as the meter writes it: 950, 12k, 1.2M. */
fun compactTokens(value: Long): String = when {
    value >= 1_000_000 -> {
        val millions = Math.round(value / 100_000.0) / 10.0
        if (millions == Math.floor(millions)) "${millions.toLong()}M" else "${millions}M"
    }
    value >= 1_000 -> "${Math.round(value / 1_000.0)}k"
    else -> value.toString()
}

/** The meter's words: "12k/200k", "0/200k" before the first answer, "—" when nothing is known. */
fun contextMeterLabel(used: Long?, window: Long?): String = when {
    used == null && window != null && window > 0 -> "0/${compactTokens(window)}"
    used == null -> "—"
    window != null && window > 0 -> "${compactTokens(used)}/${compactTokens(window)}"
    else -> compactTokens(used)
}

/** The meter's fill, 0 to 1; 0 while either side is unknown. */
fun contextRatio(used: Long?, window: Long?): Float =
    if (used == null || window == null || window <= 0) 0f else (used.toDouble() / window).coerceIn(0.0, 1.0).toFloat()

/**
 * When a turn was said, the way the chat stamps it: "just now", "5 min ago", "3 h ago",
 * "yesterday", then the day ("12 Nov"). [now] and [at] are epoch milliseconds; a turn from the
 * future (a clock ahead of the phone's) reads "just now".
 */
fun relativeTime(at: Long, now: Long, zone: java.time.ZoneId = java.time.ZoneId.systemDefault()): String {
    val minutes = (now - at) / 60_000
    if (minutes < 1) return "just now"
    if (minutes < 60) return "$minutes min ago"
    val hours = minutes / 60
    val day = java.time.Instant.ofEpochMilli(at).atZone(zone).toLocalDate()
    val today = java.time.Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
    if (day == today) return "$hours h ago"
    if (day == today.minusDays(1)) return "yesterday"
    val month = day.month.getDisplayName(java.time.format.TextStyle.SHORT, java.util.Locale.ENGLISH)
    return if (day.year == today.year) "${day.dayOfMonth} $month" else "${day.dayOfMonth} $month ${day.year}"
}

/** How long background work has run, the desktop's work card figure: "42s", "3m 5s", "1h 12m". */
fun elapsed(since: Long, now: Long): String {
    val seconds = maxOf(0L, (now - since) / 1000)
    if (seconds < 60) return "${seconds}s"
    val minutes = seconds / 60
    return if (minutes < 60) "${minutes}m ${seconds % 60}s" else "${minutes / 60}h ${minutes % 60}m"
}

private val SLASH_QUERY = Regex("^/([\\w:-]*)$")

/** What follows the "/" while a command is being named: the draft is one line starting with
 *  a slash and no space yet. Null at any other moment. */
fun slashQuery(draft: String): String? = SLASH_QUERY.find(draft)?.groupValues?.get(1)

/** The commands the composer lists under a "/": those whose name holds what follows it. */
fun slashMatches(draft: String, commands: List<com.clave.core.contract.CommandOption>?): List<com.clave.core.contract.CommandOption> {
    val query = slashQuery(draft)?.lowercase() ?: return emptyList()
    return commands.orEmpty().filter { it.name.lowercase().contains(query) }
}
