/**
 * What a run of tool calls says between two messages, decided without a view.
 *
 * Ported from the phone's `apps/mobile/src/chat/tools.ts` (itself the desktop's
 * `apps/plugins/chat-view/src/tools.ts`, Clave, MIT), semantics unchanged: the grouping (a
 * message ends a run of tools, a permission card does not), the reading of a call (its
 * kind, label, target, detail and sections), the one-line summaries and the previews.
 */
package com.clave.core.chat

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/** What a transcript renders: an entry alone (never a tool), or a group of entries. */
sealed interface Block {
    /** A run of tools. [id] is the first tool's: stable as the run grows, which is what lets
     *  the reader's expansion survive a result arriving. */
    data class ToolGroup(val id: String, val tools: List<Entry.Tool>) : Block

    /** A run of approvals the reader allowed, one row that opens to its receipts. Two or
     *  more: a lone one stays the row it always was. */
    data class ApprovalGroup(val approvals: List<Entry.Permission>) : Block

    /** A run of consecutive messages from other tabs, holding the messages ALONE: what the
     *  agent says after them stays in the transcript, in its place. */
    data class DeliveryGroup(val messages: List<Entry.User>) : Block
}

/** An assistant turn that said nothing renders nowhere, so it may not end a run either;
 *  every view filters through THIS, so all break a run in the same place. */
fun visibleEntries(entries: List<Entry>): List<Entry> =
    entries.filter { e -> (e !is Entry.Assistant || e.text.trim() != "") && !(e is Entry.User && e.withdrawn) }

/** Messages from other tabs stack in one deck while they follow one another; approvals the
 *  reader allowed fold into one run; a MESSAGE ends a run of tools, a permission card or an
 *  error does not. */
fun groupEntries(entries: List<Entry>): List<Block> {
    val blocks = mutableListOf<Any>()
    var open: MutableList<Entry.Tool>? = null
    var allowed: MutableList<Entry.Permission>? = null
    var deliveries: MutableList<Entry.User>? = null
    for (entry in entries) {
        if (entry is Entry.User && parseDelivery(entry.text) != null) {
            val deck = deliveries ?: DeckOf(mutableListOf<Entry.User>()).also { blocks.add(it) }.list
            deliveries = deck
            deck.add(entry)
            open = null
            allowed = null
            continue
        }
        deliveries = null
        if (entry is Entry.Permission && settledApproval(entry)) {
            val run = allowed ?: AllowedOf(mutableListOf()).also { blocks.add(it) }.list
            allowed = run
            run.add(entry)
            continue
        }
        if (entry !is Entry.Tool) allowed = null
        if (entry is Entry.Tool) {
            val run = open ?: RunOf(entry.id, mutableListOf()).also { blocks.add(it) }.list
            open = run
            run.add(entry)
            continue
        }
        blocks.add(entry)
        if (entry is Entry.User || entry is Entry.Assistant) open = null
    }
    // A run of one approval is the row it always was.
    return blocks.map { block ->
        when (block) {
            is RunOf -> Block.ToolGroup(block.id, block.list.toList())
            is AllowedOf -> if (block.list.size == 1) block.list[0] else Block.ApprovalGroup(block.list.toList())
            is DeckOf -> Block.DeliveryGroup(block.list.toList())
            else -> block as Block
        }
    }
}

private class RunOf(val id: String, val list: MutableList<Entry.Tool>)
private class AllowedOf(val list: MutableList<Entry.Permission>)
private class DeckOf(val list: MutableList<Entry.User>)

/** The key a view renders a block under, stable for the block's life: a run of tools by its
 *  first call's id, every other block by its first entry's ordinal. A request's id is not a
 *  key: Codex's RPC counter restarts at zero in every process. */
fun blockKey(block: Block, ordinal: (Entry) -> Int?): String = when (block) {
    is Block.ToolGroup -> "tools-${block.id}"
    is Block.ApprovalGroup -> "approvals-${ordinal(block.approvals[0])}"
    is Block.DeliveryGroup -> "deliveries-${ordinal(block.messages[0])}"
    is Entry -> "entry-${ordinal(block)}"
}

enum class ToolKind(val wire: String) {
    Read("read"), Search("search"), Edit("edit"), Command("command"),
    Skill("skill"), Web("web"), Agent("agent"), Other("other"),
}

data class Section(val label: String, val text: String)

data class ToolDescription(
    val kind: ToolKind,
    val label: String,
    val target: String,
    val detail: String? = null,
    val sections: List<Section>,
)

/** What the summary line needs, and nothing more. */
data class ToolHead(val kind: ToolKind, val label: String, val target: String)

private val READ = setOf("read", "readfile")
private val SEARCH = setOf("grep", "glob", "search", "searchfiles", "find", "ripgrep")
private val EDIT = setOf("edit", "write", "writefile", "applypatch", "filechange", "multiedit")
private val COMMAND = setOf("bash", "shell", "commandexecution", "execcommand", "runcommand")
private val SKILL = setOf("skill")
private val WEB = setOf("webfetch", "websearch")
private val AGENT = setOf("task", "agent")

/** An MCP tool arrives as `mcp__<server>__<tool>`: the reader knows it by the tool. */
private val MCP = Regex("mcp__(.+?)__(.+)")
private val SEPARATORS = Regex("[\\s_-]")

private fun field(data: JsonObject, vararg keys: String): String {
    for (key in keys) {
        val value = data[key]
        stringOf(value)?.let { if (it.isNotEmpty()) return it }
        // argv rather than a command line: Codex sends `command` as an array.
        stringsOf(value)?.let { if (it.isNotEmpty()) return it.joinToString(" ") }
    }
    return ""
}

/* The argument a human recognises a call by, when the kind's own keys found nothing. */
private val GENERIC_KEYS = arrayOf("url", "description", "prompt", "title", "name", "id")

private fun anyTarget(data: JsonObject): String {
    val known = field(data, *GENERIC_KEYS)
    if (known.isNotEmpty()) return known
    for ((_, value) in data) {
        val text = stringOf(value)
        if (!text.isNullOrEmpty()) return text
    }
    return ""
}

private fun numberField(data: JsonObject, vararg keys: String): Double? {
    for (key in keys) numberOf(data[key])?.let { return it }
    return null
}

/** Plain text blocks are common to several tools; anything else stays readable JSON. A
 *  JsonElement cannot point back at itself, so no cycle guard is needed here. */
fun content(value: JsonElement?): String {
    if (value == null || value is JsonNull) return ""
    if (value is JsonPrimitive) {
        if (value.isString) return value.content
        if (value.booleanOrNull != null) return value.content
        return numberOf(value)?.let(::jsNumber) ?: value.content
    }
    if (value is JsonArray) return value.map(::content).filter { it.isNotEmpty() }.joinToString("\n")
    val data = value as JsonObject
    stringOf(data["text"])?.let { return it }
    if (data.containsKey("content")) return content(data["content"])
    val stdout = stringOf(data["stdout"])
    val stderr = stringOf(data["stderr"])
    if (stdout != null || stderr != null) return listOfNotNull(stdout, stderr).filter { it.isNotEmpty() }.joinToString("\n")
    return safeJson(value)
}

/** `JSON.stringify(value, null, indent)`: '' for an absent value; never throws. */
fun safeJson(value: JsonElement?, indent: Int = 2): String {
    if (value == null) return ""
    if (indent <= 0) return value.toString()
    val out = StringBuilder()
    writeJson(value, " ".repeat(indent), 0, out)
    return out.toString()
}

private fun writeJson(value: JsonElement, indent: String, depth: Int, out: StringBuilder) {
    when (value) {
        is JsonPrimitive -> out.append(value.toString())
        is JsonArray -> {
            if (value.isEmpty()) { out.append("[]"); return }
            out.append("[\n")
            value.forEachIndexed { i, item ->
                if (i > 0) out.append(",\n")
                out.append(indent.repeat(depth + 1))
                writeJson(item, indent, depth + 1, out)
            }
            out.append("\n").append(indent.repeat(depth)).append("]")
        }
        is JsonObject -> {
            if (value.isEmpty()) { out.append("{}"); return }
            out.append("{\n")
            var i = 0
            for ((key, item) in value) {
                if (i++ > 0) out.append(",\n")
                out.append(indent.repeat(depth + 1)).append(JsonPrimitive(key).toString()).append(": ")
                writeJson(item, indent, depth + 1, out)
            }
            out.append("\n").append(indent.repeat(depth)).append("}")
        }
    }
}

/* Kept apart from describeTool because a CLOSED run still summarises itself on every render,
   and describeTool's last act is to turn every output into text. */
fun describeToolHead(tool: Entry.Tool): ToolHead {
    val d = describeTool(tool, withSections = false)
    return ToolHead(d.kind, d.label, d.target)
}

fun describeTool(tool: Entry.Tool, withSections: Boolean = true): ToolDescription {
    val name = (tool.name ?: "").lowercase().replace(SEPARATORS, "")
    val kind = when (name) {
        in READ -> ToolKind.Read
        in SEARCH -> ToolKind.Search
        in EDIT -> ToolKind.Edit
        in COMMAND -> ToolKind.Command
        in SKILL -> ToolKind.Skill
        in WEB -> ToolKind.Web
        in AGENT -> ToolKind.Agent
        else -> ToolKind.Other
    }
    val label = when (kind) {
        ToolKind.Read -> "Read"
        ToolKind.Search -> "Search"
        ToolKind.Edit -> "Edit"
        ToolKind.Command -> "Shell"
        ToolKind.Skill -> "Skill"
        ToolKind.Web -> if (name == "websearch") "Web search" else "Fetch"
        ToolKind.Agent -> "Agent"
        ToolKind.Other -> MCP.matchEntire(tool.name ?: "")?.groupValues?.get(2) ?: tool.name ?: "Tool"
    }
    val input = tool.input
    val data = record(input)
    val path = field(data, "file_path", "filePath", "path", "filename")
    val query = field(data, "pattern", "query", "glob")
    val command = field(data, "command", "cmd")
    val literal = stringOf(input) ?: ""
    val byKind = when (kind) {
        ToolKind.Search -> query.ifEmpty { literal.ifEmpty { path } }
        ToolKind.Command -> command.ifEmpty { literal }
        ToolKind.Skill -> field(data, "skill", "name").ifEmpty { literal }
        ToolKind.Web -> field(data, "url", "query").ifEmpty { literal }
        else -> path.ifEmpty { literal }
    }
    val target = byKind.ifEmpty { anyTarget(data) }
    val sections = mutableListOf<Section>()
    if (withSections && (target.contains('\n') || target.length > 200)) {
        sections.add(Section(if (kind == ToolKind.Command) "Command" else "Target", target))
    }
    var detail: String? = null
    if (kind == ToolKind.Read) {
        val start = numberField(data, "offset", "start_line", "startLine")
        val limit = numberField(data, "limit")
        val end = numberField(data, "end_line", "endLine")
            ?: if (start != null && limit != null) start + limit - 1 else null
        if (start != null) {
            detail = if (end != null) "Lines ${jsNumber(start)}–${jsNumber(end)}" else "From line ${jsNumber(start)}"
        } else if (limit != null) detail = "Up to ${jsNumber(limit)} lines"
    } else if (kind == ToolKind.Search) {
        if (path.isNotEmpty() && path != target) detail = "In $path"
    } else if (kind == ToolKind.Edit && withSections) {
        val changes = if (input is JsonArray) input.map(::record) else listOf(data)
        for (change in changes) {
            val diff = field(change, "diff", "patch")
            val before = field(change, "old_string", "oldText", "old_text")
            val after = field(change, "new_string", "newText", "new_text")
            val text = diff.ifEmpty {
                if (before.isNotEmpty() || after.isNotEmpty()) {
                    (
                        (if (before.isNotEmpty()) before.split("\n").map { "- $it" } else emptyList()) +
                            (if (after.isNotEmpty()) after.split("\n").map { "+ $it" } else emptyList())
                        ).joinToString("\n")
                } else field(change, "content")
            }
            if (text.isNotEmpty()) sections.add(Section(field(change, "path", "file_path").ifEmpty { "Changes" }, text))
        }
    }
    val exit = numberField(record(tool.output), "exit_code", "exitCode")
    if (kind == ToolKind.Command && exit != null) detail = "Exit ${jsNumber(exit)}"
    val outputText = if (withSections && tool.complete) content(tool.output) else ""
    if (outputText.isNotEmpty()) {
        sections.add(
            Section(
                when (kind) { ToolKind.Read -> "Content"; ToolKind.Search -> "Matches"; else -> "Output" },
                outputText,
            ),
        )
    }
    if (withSections && sections.isEmpty() && target.isEmpty() && tool.input != null) {
        val inputText = content(input)
        if (inputText.isNotEmpty()) sections.add(Section("Input", inputText))
    }
    return ToolDescription(kind, label, target, detail, sections)
}

private fun times(n: Int): String = when (n) { 1 -> "once"; 2 -> "twice"; else -> "$n times" }

/** The one line a closed group shows: what the agent did, counted by kind. A lone tool
 *  names itself instead, because "Read 1 file" tells a reader less than the path does. */
fun toolGroupSummary(tools: List<Entry.Tool>): String {
    if (tools.isEmpty()) return ""
    if (tools.size == 1) {
        val head = describeToolHead(tools[0])
        return if (head.target.isNotEmpty()) "${head.label} · ${head.target}" else head.label
    }
    class Count(val kind: ToolKind, val label: String, var count: Int = 0, val targets: LinkedHashSet<String> = linkedSetOf(), var named: Int = 0)
    val counts = linkedMapOf<String, Count>()
    for (tool in tools) {
        val (kind, label, target) = describeToolHead(tool)
        val key = if (kind == ToolKind.Other) "other:$label" else kind.wire
        val c = counts.getOrPut(key) { Count(kind, label) }
        c.count += 1
        if (target.isNotEmpty()) c.targets.add(target)
        // "Read 2 files" may only be said when every read named a file.
        if (target.isNotEmpty()) c.named += 1
    }
    return counts.values.joinToString(" · ") { c ->
        fun files(verb: String): String =
            if (c.targets.isNotEmpty() && c.named == c.count) {
                "$verb ${c.targets.size} ${if (c.targets.size == 1) "file" else "files"}"
            } else "$verb ${times(c.count)}"
        when (c.kind) {
            ToolKind.Read -> files("Read")
            ToolKind.Edit -> files("Edited")
            ToolKind.Command -> "Ran ${c.count} ${if (c.count == 1) "command" else "commands"}"
            ToolKind.Search -> "Searched ${times(c.count)}"
            ToolKind.Skill ->
                if (c.count == 1 && c.targets.size == 1) "Loaded the ${c.targets.first()} skill" else "Loaded ${c.count} skills"
            ToolKind.Web -> "Browsed the web ${times(c.count)}"
            ToolKind.Agent -> "Ran ${c.count} ${if (c.count == 1) "subagent" else "subagents"}"
            ToolKind.Other -> "${c.label} × ${c.count}"
        }
    }
}

enum class GroupStatus(val wire: String) { Running("running"), Failed("failed"), Complete("complete") }

/** Running wins over failed: something is still in flight and the row must say so. */
fun groupStatus(tools: List<Entry.Tool>): GroupStatus {
    if (tools.any { !it.complete }) return GroupStatus.Running
    return if (tools.any { it.failed }) GroupStatus.Failed else GroupStatus.Complete
}

fun failureCount(tools: List<Entry.Tool>): Int = tools.count { it.failed }

const val PREVIEW_LINES: Int = 8
const val PREVIEW_CHARS: Int = 2000

data class ToolPreview(val text: String, val truncated: Boolean)

/** What an opened tool shows before the reader asks for the rest. */
fun toolPreview(text: String): ToolPreview {
    var preview = text.split("\n").take(PREVIEW_LINES).joinToString("\n").take(PREVIEW_CHARS)
    // A cut at PREVIEW_CHARS can land between the two halves of an astral character; the
    // lone surrogate left behind would render as U+FFFD.
    if (preview.isNotEmpty() && preview.last().isHighSurrogate()) preview = preview.dropLast(1)
    return ToolPreview(preview, preview.length < text.length)
}

/** The verb a row opens with, the way Codex writes it: "Ran npm test". */
fun toolVerb(kind: ToolKind, label: String): String = when (kind) {
    ToolKind.Read -> "Read"
    ToolKind.Search -> "Searched"
    ToolKind.Edit -> "Edited"
    ToolKind.Command -> "Ran"
    ToolKind.Skill -> "Loaded skill"
    ToolKind.Web -> if (label == "Web search") "Searched the web for" else "Fetched"
    ToolKind.Agent -> "Ran agent"
    ToolKind.Other -> label
}

/** The few words a row says on a long press: what kind of external call it was. */
fun toolHint(tool: Entry.Tool): String {
    val kind = describeToolHead(tool).kind
    val server = if (kind == ToolKind.Other) MCP.matchEntire(tool.name ?: "")?.groupValues?.get(1) else null
    if (!server.isNullOrEmpty()) return "Tool call · $server MCP"
    return when (kind) {
        ToolKind.Read -> "File read"
        ToolKind.Search -> "Search"
        ToolKind.Edit -> "File edit"
        ToolKind.Command -> "Command run"
        ToolKind.Skill -> "Skill loaded"
        ToolKind.Web -> "Web request"
        ToolKind.Agent -> "Subagent run"
        ToolKind.Other -> "Tool call"
    }
}

/** The kind a whole run shows by: its own when every call shares it, a plain tool call
 *  when they differ. */
fun groupKind(tools: List<Entry.Tool>): ToolKind {
    val kinds = tools.map { describeToolHead(it).kind }.toSet()
    return if (kinds.size == 1) kinds.first() else ToolKind.Other
}

fun groupHint(tools: List<Entry.Tool>): String {
    if (tools.size == 1) return toolHint(tools[0])
    val plural = when (groupKind(tools)) {
        ToolKind.Read -> "file reads"
        ToolKind.Search -> "searches"
        ToolKind.Edit -> "file edits"
        ToolKind.Command -> "commands run"
        ToolKind.Skill -> "skills loaded"
        ToolKind.Web -> "web requests"
        ToolKind.Agent -> "subagent runs"
        ToolKind.Other -> "external calls"
    }
    return "${tools.size} $plural"
}

private val DIFF_LINE = Regex("^[-+] ", RegexOption.MULTILINE)
private val EXTENSION = Regex("\\.([a-z0-9]+)\\z", RegexOption.IGNORE_CASE)

private fun extension(path: String): String? = EXTENSION.find(path)?.groupValues?.get(1)?.lowercase()

/** The language a section highlights as: a shell line as shell, a change as a diff, a file
 *  by its extension (an unknown one stays plain text). */
fun sectionLanguage(kind: ToolKind, section: Section, path: String): String? = when {
    kind == ToolKind.Command -> if (section.label == "Command") "bash" else null
    kind == ToolKind.Edit -> if (DIFF_LINE.containsMatchIn(section.text)) "diff" else extension(section.label)
    kind == ToolKind.Read && section.label == "Content" -> extension(path)
    else -> null
}

/** The Terminal view's title for a run, one sentence whatever its length: "Read 1 file",
 *  "Read 2 files, ran 5 commands". A lone call is counted like any other; parts come in the
 *  order their kind first appears. */
fun runTitle(tools: List<Entry.Tool>): String {
    class Count(val kind: ToolKind, var count: Int = 0, val files: MutableSet<String> = mutableSetOf(), var named: Boolean = true)
    val counts = linkedMapOf<ToolKind, Count>()
    for (tool in tools) {
        val head = describeToolHead(tool)
        val c = counts.getOrPut(head.kind) { Count(head.kind) }
        c.count += 1
        if (head.target.isNotEmpty()) c.files.add(head.target) else c.named = false
    }
    fun plural(n: Int, one: String, many: String = "${one}s"): String = "$n ${if (n == 1) one else many}"
    val sentence = counts.values.joinToString(", ") { c ->
        // A file touched twice is still one file; a call that named no file makes the part
        // count calls, so it never claims fewer files than there were.
        fun onFiles(verb: String): String =
            if (c.named) "$verb ${plural(c.files.size, "file")}" else "$verb ${plural(c.count, "time")}"
        when (c.kind) {
            ToolKind.Read -> onFiles("read")
            ToolKind.Edit -> onFiles("edited")
            ToolKind.Command -> "ran ${plural(c.count, "command")}"
            ToolKind.Search -> "ran ${plural(c.count, "search", "searches")}"
            ToolKind.Skill -> "loaded ${plural(c.count, "skill")}"
            ToolKind.Web -> "made ${plural(c.count, "web request")}"
            ToolKind.Agent -> "ran ${plural(c.count, "subagent")}"
            ToolKind.Other -> "used ${plural(c.count, "tool")}"
        }
    }
    return sentence.replaceFirstChar { it.uppercaseChar() }
}
