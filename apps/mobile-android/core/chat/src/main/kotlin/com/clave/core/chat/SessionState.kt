/**
 * The five states the phone shows, mapped from the server's (decision 6 of the spec):
 * `working` is working, `blocked` is waiting for the person, `idle` is idle, `done` and
 * `ended` are finished, and `error` is the last fatal error event the stream carried, which
 * the server's own state never says. Whether the machine is reachable is shown apart
 * ([Reachability]), never folded into a session's state. Ported from
 * `apps/mobile/src/state/session-state.ts`.
 */
package com.clave.core.chat

import com.clave.core.contract.AgentState
import com.clave.core.contract.Session
import com.clave.core.contract.Transport

enum class PhoneSessionState(val wire: String) {
    Working("working"), Waiting("waiting"), Idle("idle"), Finished("finished"), Error("error"),
}

fun phoneSessionState(server: AgentState, fatalError: String? = null): PhoneSessionState {
    if (!fatalError.isNullOrEmpty()) return PhoneSessionState.Error
    return when (server) {
        AgentState.Working -> PhoneSessionState.Working
        AgentState.Blocked -> PhoneSessionState.Waiting
        AgentState.Idle -> PhoneSessionState.Idle
        AgentState.Done, AgentState.Ended -> PhoneSessionState.Finished
    }
}

val SESSION_STATE_LABEL: Map<PhoneSessionState, String> = mapOf(
    PhoneSessionState.Working to "Working",
    PhoneSessionState.Waiting to "Waiting for you",
    PhoneSessionState.Idle to "Idle",
    PhoneSessionState.Finished to "Finished",
    PhoneSessionState.Error to "Error",
)

/** Whether the chosen machine answers, apart from any session's state. */
enum class Reachability(val wire: String) {
    Connecting("connecting"), Reachable("reachable"), Unreachable("unreachable"), Refused("refused"),
}

val REACHABILITY_LABEL: Map<Reachability, String> = mapOf(
    Reachability.Connecting to "Connecting",
    Reachability.Reachable to "Reachable",
    Reachability.Unreachable to "Not reachable",
    Reachability.Refused to "Token refused",
)

/** Chats first (the events transport), then the terminals, each group by creation, newest
 *  first. A terminal is listed read-only on the phone. */
fun orderSessions(sessions: List<Session>): List<Session> =
    sessions.sortedWith(
        compareBy<Session> { if (it.transport == Transport.Events) 0 else 1 }.thenByDescending { it.createdAt },
    )

/** A workspace as the session filter sees it. */
data class WorkspaceRoot(val id: String, val rootDir: String)

/**
 * Only the host's explicit stamp identifies a workspace. An unstamped session, including one
 * from an older server, remains visible in every workspace. A working folder is never
 * workspace identity, which is why [session] and [workspaces] are not read.
 */
@Suppress("UNUSED_PARAMETER")
fun workspaceOfSession(session: Session, stampedWorkspaceId: String?, workspaces: List<WorkspaceRoot>): String? =
    stampedWorkspaceId

fun sessionsOfWorkspace(
    sessions: List<Session>,
    stamps: Map<String, String?>,
    workspaces: List<WorkspaceRoot>,
    workspaceId: String,
): List<Session> = orderSessions(
    sessions.filter { s ->
        val home = workspaceOfSession(s, stamps[s.id], workspaces)
        home == null || home == workspaceId
    },
)
