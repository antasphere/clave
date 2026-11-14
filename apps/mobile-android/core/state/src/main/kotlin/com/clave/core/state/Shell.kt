package com.clave.core.state

import com.clave.core.chat.WorkspaceRoot
import com.clave.core.chat.workspaceOfSession
import com.clave.core.contract.LaunchProfilePreferencesView
import com.clave.core.contract.LaunchProfileView
import com.clave.core.contract.LauncherFamily
import com.clave.core.contract.Session
import com.clave.core.contract.SidebarOverview
import com.clave.core.contract.UsageRead
import com.clave.core.contract.UsageSeverity
import com.clave.core.contract.UsageWindow
import com.clave.core.contract.WorkspaceView

/*
 * The rules of the phone's shell (Home, Sessions, Accounts & limits) as pure functions over
 * the server's values: no clock read, no store touched, so each is tested on its own and the
 * screens only draw what these answer.
 */

// ── the desktop's groups ──

/** One section of the session list: a desktop group, or the sessions in none. */
public data class SessionSection(
    /** The group's id; null for the last section, the sessions no group holds. */
    val groupId: String?,
    val name: String,
    /** The group's colour as the desktop names it (`blue`, `#3b82f6`), null when none is set. */
    val color: String?,
    /** Whether the desktop shows the group folded; the phone's own choice overrides it. */
    val collapsedOnDesktop: Boolean,
    val sessions: List<Session>,
)

/** The name of the section of sessions in no group. */
public const val OTHER_SESSIONS: String = "Other sessions"

/** A session is in a workspace when its stamp says so; an unstamped one is in every workspace (the core's rule). */
private fun inWorkspace(session: Session, workspaceId: String?, stamps: Map<String, String?>, roots: List<WorkspaceRoot>): Boolean {
    if (workspaceId == null) return true
    val home = workspaceOfSession(session, stamps[session.id] ?: session.workspaceId, roots)
    return home == null || home == workspaceId
}

/**
 * The session list as the desktop's sidebar orders it: every window's top level in turn
 * (`displayOrder`, the windows in the overview's order), a group where its id stands with
 * its sessions in the group's own order, and a loose session where its id stands, kept for
 * the last section. A group the top level does not name follows its window's named ones. A
 * session two groups claim is listed in the first. Every session no group holds goes last,
 * under [OTHER_SESSIONS]: first the loose ones in the sidebar's order, then the rest newest
 * first.
 *
 * With a [workspaceId], a group stamped for another workspace (its own stamp, else its
 * window's) is left out, and so is a session of another workspace; a group with no session
 * left to show is not shown. Without an overview (an older Mac) every session is in the one
 * last section.
 */
public fun sessionSections(
    overview: SidebarOverview?,
    sessions: List<Session>,
    workspaceId: String? = null,
    stamps: Map<String, String?> = emptyMap(),
    roots: List<WorkspaceRoot> = emptyList(),
): List<SessionSection> {
    val visible = sessions.filter { inWorkspace(it, workspaceId, stamps, roots) }
    val byId = visible.associateBy { it.id }
    val placed = HashSet<String>()
    val looseOrder = mutableListOf<String>()
    val sections = mutableListOf<SessionSection>()
    for (window in overview?.windows.orEmpty()) {
        val groups = window.groups.associateBy { it.id }
        val named = window.displayOrder.filter { it in groups }.toSet()
        val order = window.displayOrder + window.groups.map { it.id }.filter { it !in named }
        val seenHere = HashSet<String>()
        for (id in order) {
            if (!seenHere.add(id)) continue
            val group = groups[id]
            if (group == null) {
                looseOrder += id
                continue
            }
            val home = group.workspaceId ?: window.workspaceId
            if (workspaceId != null && home != null && home != workspaceId) continue
            val members = group.sessionIds.mapNotNull { sid -> byId[sid]?.takeIf { placed.add(sid) } }
            if (members.isEmpty()) continue
            sections += SessionSection(group.id, group.name, group.color, group.collapsed, members)
        }
    }
    val rest = looseOrder.mapNotNull { id -> byId[id]?.takeIf { placed.add(id) } } +
        visible.filter { it.id !in placed }.sortedByDescending { it.createdAt }
    if (rest.isNotEmpty()) sections += SessionSection(null, OTHER_SESSIONS, null, false, rest)
    return sections
}

/** The name of the group a session is in, by the overview; null in none or without one. */
public fun groupNameOf(overview: SidebarOverview?, sessionId: String): String? =
    overview?.windows?.firstNotNullOfOrNull { w -> w.groups.firstOrNull { sessionId in it.sessionIds }?.name }

// ── recent sessions ──

/**
 * The sessions most recently active, across workspaces: by the last activity the phone heard
 * of ([activity], session id → epoch ms, from the push events' times), else by creation;
 * newest first, at most [limit].
 */
public fun recentSessions(sessions: List<Session>, activity: Map<String, Long>, limit: Int = 8): List<Session> =
    sessions
        .sortedWith(compareByDescending<Session> { maxOf(it.createdAt, activity[it.id] ?: 0) }.thenBy { it.id })
        .take(limit)

// ── usage limits (src/shared/account-pool.ts, src/shared/usage-summary.ts) ──

/** About this many percent left, or fewer, and a cap is about to stop what draws on it. */
public const val EXHAUSTED_LEFT_PERCENT: Double = 5.0

/** Whether one cap is about to stop what draws on it: the service calls it critical, or about five percent is left. */
public fun windowExhausted(w: UsageWindow): Boolean =
    w.severity == UsageSeverity.Critical || 100 - w.usedPercentage <= EXHAUSTED_LEFT_PERCENT

/** The family a window is scoped to (`Fable`, `Spark`), or null for a cap every model shares. */
public fun familyOf(w: UsageWindow): String? = w.scope?.trim()?.takeIf { it.isNotEmpty() }

private fun rank(s: UsageSeverity?): Int = when (s) {
    UsageSeverity.Critical -> 2
    UsageSeverity.Warning -> 1
    UsageSeverity.Normal, null -> 0
}

/** The desktop's `tighter`: a cap out ranks first, among those the one back last; then severity; then percent used. */
private fun tighter(w: UsageWindow, than: UsageWindow): Boolean {
    val outW = windowExhausted(w)
    val outT = windowExhausted(than)
    if (outW != outT) return outW
    if (outW) {
        val backW = w.resetsAt ?: Long.MIN_VALUE
        val backT = than.resetsAt ?: Long.MIN_VALUE
        if (backW != backT) return backW > backT
    }
    val a = rank(w.severity)
    val b = rank(than.severity)
    if (a != b) return a > b
    return w.usedPercentage > than.usedPercentage
}

/** The window about to stop a view, the desktop's one rule. */
public fun tightestOf(windows: List<UsageWindow>): UsageWindow? {
    var best: UsageWindow? = null
    for (w in windows) if (best == null || tighter(w, best)) best = w
    return best
}

/** An account's usage summed up the desktop's way, for its row and the Home strip. */
public data class AccountLimits(
    /** The tightest SHARED cap: the one that would stop the account. Null without a read. */
    val tightest: UsageWindow?,
    /** A shared cap is out: the account is exhausted. A family's cap out never is. */
    val exhausted: Boolean,
    /** The model families whose own cap is out (`Fable`): out for those models alone. */
    val familiesOut: List<String>,
)

/**
 * The ACCOUNT view of a read (`usageSummaryOf` with `isExhausted`): exhausted when its
 * tightest shared cap is out. Unknown usage (no read, a failed one) is never exhaustion.
 */
public fun accountLimitsOf(read: UsageRead?): AccountLimits? {
    if (read !is UsageRead.Limits) return null
    val shared = read.windows.filter { familyOf(it) == null }
    val tightest = tightestOf(shared)
    val families = LinkedHashMap<String, UsageWindow>()
    for (w in read.windows) {
        val family = familyOf(w) ?: continue
        val held = families[family]
        families[family] = if (held == null) w else tightestOf(listOf(held, w)) ?: w
    }
    return AccountLimits(
        tightest = tightest,
        exhausted = tightest != null && windowExhausted(tightest),
        familiesOut = families.filterValues(::windowExhausted).keys.toList(),
    )
}

// ── the quick composer's defaults ──

private fun isChatId(id: String): Boolean =
    id == "claude-chat" || id == "codex-chat" || id.startsWith("chat:") || id == "dev-echo-adapter"

private val CHAT_TEMPLATES = listOf(
    LaunchProfileView("claude-chat", "Claude (chat)", LauncherFamily.Claude, listOf("claude"), emptyList(), builtIn = true),
    LaunchProfileView("codex-chat", "Codex (chat)", LauncherFamily.Codex, listOf("codex"), emptyList(), builtIn = true),
)

/**
 * The chat profiles a new chat can start on, as the desktop's launcher offers them
 * (launch-profile-manager.ts `offeredChatProfiles`): the two built-ins (Claude and Codex in
 * a chat), then each saved profile of those two families as its chat twin
 * (`chat:<family>:<id>`, "<name> (chat)", its command and arguments), then the saved
 * profiles that are chats already (the echo fixture). The server resolves every one of
 * these ids itself; the built-ins are listed even when the Mac's Codex is not installed,
 * which the start then says in the server's words.
 */
public fun chatProfilesOf(prefs: LaunchProfilePreferencesView?): List<LaunchProfileView> {
    val custom = prefs?.customProfiles.orEmpty()
    val twins = custom.mapNotNull { p ->
        val template = CHAT_TEMPLATES.firstOrNull { it.family == p.family } ?: return@mapNotNull null
        if (p.builtIn == true || isChatId(p.id)) return@mapNotNull null
        LaunchProfileView(
            id = "chat:${p.family.wire}:${p.id}",
            name = "${p.name} (chat)",
            family = template.family,
            command = p.command,
            additionalArgs = p.additionalArgs,
            sourceProfileId = p.id,
        )
    }
    val already = custom.filter { isChatId(it.id) && CHAT_TEMPLATES.none { t -> t.id == it.id } }
    return CHAT_TEMPLATES + twins + already
}

/**
 * The workspace a new chat starts in: the one last used from the phone, else the one the
 * Mac was last active in, else the first; null without a workspace.
 */
public fun defaultWorkspace(workspaces: List<WorkspaceView>, lastUsed: String?, lastActive: String?): WorkspaceView? =
    workspaces.firstOrNull { it.id == lastUsed } ?: workspaces.firstOrNull { it.id == lastActive } ?: workspaces.firstOrNull()

/**
 * The profile a new chat starts on: the one last used from the phone, else the Mac's default
 * of a family (the workspace's own default first, Claude before Codex) when it names a chat
 * profile or a saved profile with a chat twin, else the first chat profile.
 */
public fun defaultChatProfile(
    profiles: List<LaunchProfileView>,
    prefs: LaunchProfilePreferencesView?,
    lastUsed: String?,
    workspaceId: String? = null,
): LaunchProfileView? {
    profiles.firstOrNull { it.id == lastUsed }?.let { return it }
    val defaults = listOfNotNull(workspaceId?.let { prefs?.workspaceOverrides?.get(it) }, prefs?.globalDefaults)
    for (family in listOf(LauncherFamily.Claude, LauncherFamily.Codex)) {
        for (map in defaults) {
            val id = map[family] ?: continue
            profiles.firstOrNull { it.id == id || it.sourceProfileId == id }?.let { return it }
        }
    }
    return profiles.firstOrNull()
}
