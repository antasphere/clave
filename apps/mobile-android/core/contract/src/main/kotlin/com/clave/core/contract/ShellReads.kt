/**
 * The reads the phone's shell (Home, Sessions, Settings, Accounts & limits) makes beside the
 * conversation: the desktop's sidebar groups, the agent accounts and their usage limits, and
 * the server's own version. Mirrored from `@clave/contract` (sidebar/overview, settings/accounts,
 * server-info) as plain Kotlin, kept apart from Types.kt so the session events and these reads
 * change on their own.
 *
 * The same two rules as Types.kt: a field the shape does not name is left out of the typed
 * value, and absence and JSON null differ only where the contract says so. Every value here
 * is secret-free by contract: an account says whether it has a token, never the token.
 */
package com.clave.core.contract

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// ── sidebar/overview ──

/** One desktop sidebar group: its name, colour and the sessions in it, in the sidebar's order. */
data class SidebarGroupView(
    val id: String,
    val name: String,
    /** A colour name of the desktop's palette (`blue`, `teal`) or a `#rrggbb`; null when none is set. */
    val color: String? = null,
    val collapsed: Boolean,
    val workspaceId: String? = null,
    val sessionIds: List<String>,
)

/** One desktop window's sidebar: the top level in order (group ids and loose session ids) and its groups. */
data class SidebarWindowView(
    val windowKey: String,
    val workspaceId: String? = null,
    val displayOrder: List<String>,
    val groups: List<SidebarGroupView>,
)

/** `GET /sidebar/overview`: every window's sidebar, without terminals, prompts or folders. */
data class SidebarOverview(val windows: List<SidebarWindowView>)

// ── settings/accounts ──

/** A Claude account as the server lists it: whether it holds a token, never the token. */
data class ClaudeAccountView(
    val id: String,
    val label: String,
    val hasToken: Boolean,
    val tokenSetAt: Long? = null,
    val tokenExpiresAt: Long? = null,
    /** The service refused the token on its last read. */
    val tokenInvalid: Boolean,
)

/** A Codex account as the server lists it: its kind and whether it holds a credential. */
data class CodexAccountView(
    val id: String,
    val label: String,
    /** `chatgpt` or `apiKey`; kept as the wire says it so a new kind still lists. */
    val kind: String,
    val hasCredential: Boolean,
)

enum class UsageSeverity(val wire: String) {
    Normal("normal"), Warning("warning"), Critical("critical");
    companion object { fun of(wire: String?): UsageSeverity? = entries.firstOrNull { it.wire == wire } }
}

/** One metered cap of an account: the 5-hour block, the weekly cap, a family's weekly cap. */
data class UsageWindow(
    val key: String,
    val label: String,
    /** `session`, `weekly_all`, `weekly_scoped`, or whatever the service adds. */
    val kind: String,
    /** The model family a scoped cap belongs to (`Fable`, `Opus`), else null. */
    val scope: String? = null,
    val usedPercentage: Double,
    val resetsAt: Long? = null,
    val severity: UsageSeverity? = null,
)

/** An account's last usage read: its windows, or the reason there are none. */
sealed interface UsageRead {
    data class Limits(val windows: List<UsageWindow>, val fetchedAt: Long, val message: String? = null) : UsageRead

    /** [unauthorized]: the service refused the account's credential itself. */
    data class Failed(val error: String, val unauthorized: Boolean = false) : UsageRead
}

// ── server-info ──

/** `GET /server/info`, the part the phone shows: the version and the server's own name. */
data class ServerInfoView(val version: String, val name: String? = null)

/**
 * The decoders of the shell's reads, in Decode.kt's manner (a [DecodeError] naming the path),
 * but lenient where a newer server may add: an unknown severity reads as none, an unknown
 * usage read is skipped rather than failing the whole snapshot.
 */
object ShellDecode {
    private fun fail(path: String, expected: String): Nothing = throw DecodeError(path, expected)

    private fun obj(value: JsonElement?, path: String): JsonObject = value as? JsonObject ?: fail(path, "an object")

    private fun arr(value: JsonElement?, path: String): JsonArray = value as? JsonArray ?: fail(path, "an array")

    private fun str(value: JsonElement?, path: String): String =
        (value as? JsonPrimitive)?.takeIf { it !is JsonNull && it.isString }?.content ?: fail(path, "a string")

    /** Absent or null both read as none: the optional and the nullable fields here mean the same to the phone. */
    private fun optStr(value: JsonElement?, path: String): String? =
        if (value == null || value is JsonNull) null else str(value, path)

    private fun bool(value: JsonElement?, path: String): Boolean {
        val p = value as? JsonPrimitive
        if (p == null || p is JsonNull || p.isString) fail(path, "a boolean")
        return when (p.content) {
            "true" -> true
            "false" -> false
            else -> fail(path, "a boolean")
        }
    }

    private fun num(value: JsonElement?, path: String): Double {
        val p = value as? JsonPrimitive
        if (p == null || p is JsonNull || p.isString) fail(path, "a number")
        return p.content.toDoubleOrNull()?.takeIf { it.isFinite() } ?: fail(path, "a number")
    }

    private fun long(value: JsonElement?, path: String): Long {
        val d = num(value, path)
        return (value as JsonPrimitive).content.toLongOrNull() ?: d.toLong()
    }

    private fun optLong(value: JsonElement?, path: String): Long? =
        if (value == null || value is JsonNull) null else long(value, path)

    private fun strings(value: JsonElement?, path: String): List<String> =
        arr(value, path).mapIndexed { i, v -> str(v, "$path[$i]") }

    fun sidebarOverview(value: JsonElement, path: String = "overview"): SidebarOverview {
        val o = obj(value, path)
        return SidebarOverview(
            arr(o["windows"], "$path.windows").mapIndexed { i, w -> windowOf(w, "$path.windows[$i]") },
        )
    }

    private fun windowOf(value: JsonElement, path: String): SidebarWindowView {
        val o = obj(value, path)
        return SidebarWindowView(
            windowKey = str(o["windowKey"], "$path.windowKey"),
            workspaceId = optStr(o["workspaceId"], "$path.workspaceId"),
            displayOrder = strings(o["displayOrder"], "$path.displayOrder"),
            groups = arr(o["groups"], "$path.groups").mapIndexed { i, g -> groupOf(g, "$path.groups[$i]") },
        )
    }

    private fun groupOf(value: JsonElement, path: String): SidebarGroupView {
        val o = obj(value, path)
        return SidebarGroupView(
            id = str(o["id"], "$path.id"),
            name = str(o["name"], "$path.name"),
            color = optStr(o["color"], "$path.color"),
            collapsed = o["collapsed"]?.let { bool(it, "$path.collapsed") } ?: false,
            workspaceId = optStr(o["workspaceId"], "$path.workspaceId"),
            sessionIds = strings(o["sessionIds"], "$path.sessionIds"),
        )
    }

    /** The account list, bare as the contract sends it, or inside `{accounts: [...]}`. */
    private fun accountList(value: JsonElement, path: String): JsonArray =
        (value as? JsonObject)?.get("accounts") as? JsonArray ?: arr(value, path)

    fun claudeAccounts(value: JsonElement, path: String = "claudeAccounts"): List<ClaudeAccountView> =
        accountList(value, path).mapIndexed { i, a ->
            val p = "$path[$i]"
            val o = obj(a, p)
            ClaudeAccountView(
                id = str(o["id"], "$p.id"),
                label = str(o["label"], "$p.label"),
                hasToken = bool(o["hasToken"], "$p.hasToken"),
                tokenSetAt = optLong(o["tokenSetAt"], "$p.tokenSetAt"),
                tokenExpiresAt = optLong(o["tokenExpiresAt"], "$p.tokenExpiresAt"),
                tokenInvalid = o["tokenInvalid"]?.let { bool(it, "$p.tokenInvalid") } ?: false,
            )
        }

    fun codexAccounts(value: JsonElement, path: String = "codexAccounts"): List<CodexAccountView> =
        accountList(value, path).mapIndexed { i, a ->
            val p = "$path[$i]"
            val o = obj(a, p)
            CodexAccountView(
                id = str(o["id"], "$p.id"),
                label = str(o["label"], "$p.label"),
                kind = str(o["kind"], "$p.kind"),
                hasCredential = bool(o["hasCredential"], "$p.hasCredential"),
            )
        }

    fun usageRead(value: JsonElement, path: String = "usage"): UsageRead {
        val o = obj(value, path)
        val error = o["error"]
        if (error != null && error !is JsonNull) {
            return UsageRead.Failed(
                error = str(error, "$path.error"),
                unauthorized = optStr(o["reason"], "$path.reason") == "unauthorized",
            )
        }
        return UsageRead.Limits(
            windows = arr(o["windows"], "$path.windows").mapIndexed { i, w -> usageWindowOf(w, "$path.windows[$i]") },
            fetchedAt = long(o["fetchedAt"], "$path.fetchedAt"),
            message = optStr(o["message"], "$path.message"),
        )
    }

    private fun usageWindowOf(value: JsonElement, path: String): UsageWindow {
        val o = obj(value, path)
        return UsageWindow(
            key = str(o["key"], "$path.key"),
            label = str(o["label"], "$path.label"),
            kind = str(o["kind"], "$path.kind"),
            scope = optStr(o["scope"], "$path.scope"),
            usedPercentage = num(o["usedPercentage"], "$path.usedPercentage"),
            resetsAt = optLong(o["resetsAt"], "$path.resetsAt"),
            severity = UsageSeverity.of(optStr(o["severity"], "$path.severity")),
        )
    }

    /**
     * Every account's last read, by account id. One read of a shape this phone does not know
     * is left out, so a newer server's addition hides one account's bars, not the page.
     */
    fun usageSnapshot(value: JsonElement, path: String = "snapshot"): Map<String, UsageRead> {
        val o = obj(value, path)
        val out = LinkedHashMap<String, UsageRead>()
        for ((id, read) in o) {
            try {
                out[id] = usageRead(read, "$path.$id")
            } catch (_: DecodeError) {
                // Skipped: see the doc above.
            }
        }
        return out
    }

    fun serverInfo(value: JsonElement, path: String = "serverInfo"): ServerInfoView {
        val o = obj(value, path)
        return ServerInfoView(version = str(o["version"], "$path.version"), name = optStr(o["name"], "$path.name"))
    }
}
