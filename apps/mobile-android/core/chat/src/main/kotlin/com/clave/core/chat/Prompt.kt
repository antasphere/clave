/**
 * The request the agent waits on, as the chat's docked card says it: the request in the
 * reader's words ("Allow Claude to run a command?"), its command or its change as code, and
 * the host's reading of what it does (`permission_explained`). Ported from the desktop chat
 * view's `PromptDock.tsx` (`describeRequest`) and `PermissionReading.tsx`; the level is the
 * reading's own, since the desktop's path rules (`permission-risk.ts`) run on the host.
 */
package com.clave.core.chat

import com.clave.core.contract.AskedMatch
import com.clave.core.contract.RiskLevel
import com.clave.core.contract.SessionEvent

/** What the reader can still answer, in the order asked: the dock shows the head of it. */
fun openRequests(entries: List<Entry>): List<SessionEvent.PermissionRequest> =
    entries.mapNotNull { e -> (e as? Entry.Permission)?.takeIf { it.answer == null && !it.answeredElsewhere }?.request }

data class RequestDescription(
    val title: String,
    val target: String,
    val kind: ToolKind,
    /** The command or the change, as code; null when the request carries neither. */
    val code: String? = null,
    /** "bash" for a command, "diff" for a change written as one, else null. */
    val language: String? = null,
)

private val VERBS = mapOf(
    ToolKind.Read to "read",
    ToolKind.Search to "search",
    ToolKind.Edit to "edit",
    ToolKind.Command to "run a command",
    ToolKind.Skill to "load the skill",
    ToolKind.Web to "fetch",
    ToolKind.Agent to "start a subagent",
)
private val WRITE = Regex("write", RegexOption.IGNORE_CASE)
private val DIFF_LINES = Regex("^[-+] ", RegexOption.MULTILINE)

private fun basename(path: String): String = path.split('/').lastOrNull { it.isNotEmpty() } ?: path

/** "Allow Claude to write notes.txt?" for a tool the chat knows; the provider's own sentence otherwise. */
fun describeRequest(request: SessionEvent.PermissionRequest, agent: String): RequestDescription {
    val toolName = request.toolName
    if (toolName.isNullOrEmpty()) return RequestDescription(request.description, "", ToolKind.Other)
    // A Codex approval names a method, never a tool: its own description reads better.
    describeApproval(request)?.let { approval ->
        val command = approval.label == "Run a command" && approval.target.isNotEmpty()
        return RequestDescription(
            title = approval.label,
            target = if (command) "" else approval.target,
            kind = if (command) ToolKind.Command else ToolKind.Other,
            code = if (command) approval.target else null,
            language = if (command) "bash" else null,
        )
    }
    val tool = describeTool(Entry.Tool(id = request.id, name = toolName, input = request.input, complete = false, at = 0))
    if (tool.kind == ToolKind.Other && !toolName.startsWith("mcp__")) {
        return RequestDescription(request.description, "", ToolKind.Other)
    }
    val verb = when {
        tool.kind == ToolKind.Edit && WRITE.containsMatchIn(toolName) -> "write"
        tool.kind == ToolKind.Other -> "use ${tool.label}"
        else -> VERBS.getValue(tool.kind)
    }
    val named = if (tool.kind == ToolKind.Command || tool.target.isEmpty()) "" else " ${basename(tool.target)}"
    val change = tool.sections.firstOrNull { it.label != "Target" && it.label != "Command" }
    val code: String?
    val language: String?
    when {
        tool.kind == ToolKind.Command && tool.target.isNotEmpty() -> {
            code = tool.target
            language = "bash"
        }
        change != null -> {
            code = change.text
            language = if (DIFF_LINES.containsMatchIn(change.text)) "diff" else null
        }
        else -> {
            code = null
            language = null
        }
    }
    return RequestDescription(
        title = "Allow $agent to $verb$named?",
        target = if (tool.kind == ToolKind.Command) "" else tool.target,
        kind = tool.kind,
        code = code,
        language = language,
    )
}

/** The level in words, the desktop's `RISK_LABELS`. Never "safe": the lowest is neutral. */
fun riskLabel(level: RiskLevel): String = when (level) {
    RiskLevel.Reads -> "Reads only"
    RiskLevel.Project -> "Changes files of the project"
    RiskLevel.Outside -> "Reaches outside the project"
    RiskLevel.Irreversible -> "Hard to undo"
}

/** Whether the host reads a request at all: a tool's, not a question, not a form. */
fun isExplainable(request: SessionEvent.PermissionRequest): Boolean {
    val tool = request.toolName
    if (tool.isNullOrEmpty() || !request.questions.isNullOrEmpty()) return false
    return tool != "mcpServer/elicitation/request" && tool != "AskUserQuestion" && tool != "clave_request_input"
}

/**
 * The reading as the card draws it: the level's words, the plain sentence (said as a model's
 * reading when no level vouches for it), "Not what you asked for" when it does not match the
 * ask, and one quiet note while the reading is coming or when it failed.
 */
data class ReadingView(
    val level: RiskLevel? = null,
    val levelLabel: String? = null,
    val sentence: String? = null,
    val mismatch: Boolean = false,
    val note: String? = null,
)

fun readingOf(request: SessionEvent.PermissionRequest, reading: SessionEvent.PermissionExplained?, open: Boolean): ReadingView? {
    if (!isExplainable(request)) return null
    val level = reading?.level
    val sentence = reading?.sentence?.takeIf { it.isNotBlank() }
    return when {
        sentence != null -> ReadingView(
            level = level,
            levelLabel = level?.let(::riskLabel),
            sentence = if (level == null) "Not verified. Clave could not check this; a model reads it as: $sentence" else sentence,
            mismatch = reading.asked == AskedMatch.No,
        )
        reading?.failed != null -> ReadingView(level, level?.let(::riskLabel), note = "Could not read what this does")
        level != null -> ReadingView(level, riskLabel(level))
        open -> ReadingView(note = "Reading what this does…")
        else -> null
    }
}
