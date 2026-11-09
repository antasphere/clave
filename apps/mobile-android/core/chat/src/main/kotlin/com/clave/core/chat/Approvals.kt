/**
 * The transcript's reading of an approval: what was asked, in words a reader understands,
 * and what the reader said; and which rows fold into a run.
 *
 * Ported from the phone's `apps/mobile/src/chat/approvals.ts` (itself the desktop's
 * `apps/plugins/chat-view/src/approvals.ts`, Clave, MIT), semantics unchanged.
 */
package com.clave.core.chat

import com.clave.core.contract.IdLabel
import com.clave.core.contract.SessionEvent

/** A command as the frame carries it: a line, argv joined, or the first action Codex
 *  parsed out of it. */
private fun commandText(p: kotlinx.serialization.json.JsonObject): String {
    stringOf(p["command"])?.let { return it }
    stringsOf(p["command"])?.let { return it.joinToString(" ") }
    val actions = (p["commandActions"] as? kotlinx.serialization.json.JsonArray)?.map(::record).orEmpty()
    return textOf(actions.firstOrNull()?.get("command"))
}

/** The Clave tool server as the Codex adapter binds it: `clave`, or `clave_` and twelve hex
 *  digits, a fresh name per connection that means nothing to the reader. */
private val CLAVE_SERVER = Regex("clave(_[a-f0-9]{12})?")
private val COMMAND_METHODS = setOf("item/commandExecution/requestApproval", "execCommandApproval")
private val EDIT_METHODS = setOf("item/fileChange/requestApproval", "applyPatchApproval")

/** The words of a decision id the adapter passed through as its own label. */
private val DECISION_WORDS = mapOf(
    "accept" to "Allowed",
    "acceptForSession" to "Allowed for the session",
    "approved" to "Allowed",
    "approved_for_session" to "Allowed for the session",
    "decline" to "Declined",
    "cancel" to "Cancelled",
    "abort" to "Cancelled",
)

/** A refusal, by the option's id (the words every provider uses) or, when the ids say
 *  nothing, by its label: Codex's extra-permissions choices carry JSON ids and "Deny extra
 *  permissions" as the label. */
private val REFUSAL_ID = Regex("deny|decline|cancel|reject|abort", RegexOption.IGNORE_CASE)
private val REFUSAL_LABEL = Regex("^(deny|decline|cancel|reject|abort|skip)\\b", RegexOption.IGNORE_CASE)

fun isRefusalOption(option: IdLabel): Boolean =
    REFUSAL_ID.containsMatchIn(option.id) || REFUSAL_LABEL.containsMatchIn(option.label)

fun refused(request: SessionEvent.PermissionRequest, answer: String): Boolean {
    val option = request.options.firstOrNull { it.id == answer }
    return if (option != null) isRefusalOption(option) else REFUSAL_ID.containsMatchIn(answer)
}

/** What the reader said, as the row shows it: the provider's own label when it has one,
 *  the words of a raw id otherwise. */
fun decisionWord(request: SessionEvent.PermissionRequest, answer: String): String {
    val option = request.options.firstOrNull { it.id == answer }
    if (option != null && option.label != option.id) return option.label
    return DECISION_WORDS[answer] ?: option?.label ?: answer
}

/** A request answered with words rather than allowed: one that asks questions, or one
 *  that names no tool. */
fun isQuestion(request: SessionEvent.PermissionRequest): Boolean =
    request.questions != null || request.toolName.isNullOrEmpty()

data class ApprovalDescription(val label: String, val target: String)

private val RUN_TOOL = Regex("run tool \"([^\"]+)\"")

/** What a Codex request asked, in the reader's words: a verb phrase and what it was about.
 *  Null for a request the view describes by its tool name (Claude's). */
fun describeApproval(request: SessionEvent.PermissionRequest): ApprovalDescription? {
    val method = request.toolName ?: ""
    val p = record(request.input)
    if (method in COMMAND_METHODS) {
        return ApprovalDescription("Run a command", commandText(p).ifEmpty { textOf(p["reason"]) })
    }
    if (method in EDIT_METHODS) {
        return ApprovalDescription("Edit files", textOf(p["reason"]).ifEmpty { textOf(p["grantRoot"]) })
    }
    if (method == "item/permissions/requestApproval") {
        return ApprovalDescription(
            "Extra permissions",
            textOf(p["reason"]).ifEmpty { record(p["permissions"]).keys.joinToString(", ") },
        )
    }
    if (method == "mcpServer/elicitation/request") {
        // Codex 0.166.0 names the tool in the message alone, its _meta carrying the kind;
        // a frame that names the tool under its own key is read first.
        val tool = textOf(record(p["_meta"])["tool_name"])
            .ifEmpty { RUN_TOOL.find(textOf(p["message"]))?.groupValues?.get(1) ?: "" }
        val server = textOf(p["serverName"])
        return ApprovalDescription(
            if (tool.isNotEmpty()) "Use $tool" else "Use a tool",
            if (CLAVE_SERVER.matches(server)) "Clave" else server.ifEmpty { textOf(p["message"]) },
        )
    }
    return null
}

/** An approval the reader allowed and nothing more is owed on: answered here, not a
 *  question, not a refusal. The rows that fold into a run. */
fun settledApproval(entry: Entry.Permission): Boolean {
    val answer = entry.answer ?: return false
    return !entry.answeredElsewhere && !isQuestion(entry.request) && !refused(entry.request, answer)
}

data class ApprovalRunSummary(val head: String, val detail: String)

/** The one line a closed run shows: how many were allowed, and of what. */
fun approvalRunSummary(approvals: List<Entry.Permission>): ApprovalRunSummary {
    val counts = linkedMapOf<String, Int>()
    for (entry in approvals) {
        val label = describeApproval(entry.request)?.label ?: entry.request.toolName ?: "request"
        counts[label] = (counts[label] ?: 0) + 1
    }
    return ApprovalRunSummary(
        head = "Allowed ${approvals.size} ${if (approvals.size == 1) "request" else "requests"}",
        detail = counts.entries.joinToString(" · ") { (label, n) -> if (n > 1) "$label ×$n" else label },
    )
}
