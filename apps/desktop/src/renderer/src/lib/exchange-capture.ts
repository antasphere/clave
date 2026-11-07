/**
 * The renderer side of the exchange capture: identities and the two kinds
 * the renderer alone can emit, `session_state` and `tab_closed`.
 *
 * The renderer OWNS every identity fact (tab name, cwd, group membership,
 * model) and every lifecycle fact (the agent-run-state word from the hooks,
 * the pty exit, who closed a tab), so events are stamped here and sent to
 * the main process over fire-and-forget IPC, exactly like `message` and
 * `tab_spawn`. Nothing here waits on the main process, and nothing here
 * throws into a caller: capture is observability.
 *
 * Store-free on purpose: every function takes the session and the groups it
 * needs, so the session store can call into this module without an import
 * cycle and the helpers stay testable on plain data.
 */

import { mapAgentState, sessionStateTransition } from '../../../../../../packages/shared/src/session-state'
import type { AgentRunStateWord } from '../../../../../../packages/shared/src/session-state'
import type { Session, SessionGroup } from '../store/session-types'
import { AGENT_CAPABILITIES } from '../../../../../../packages/shared/src/agent-launch'

export type SessionMode = 'claude' | 'antigravity' | 'codex' | 'pi' | 'claude-agents' | 'terminal'

export function sessionMode(s: Session): SessionMode {
  if (s.antigravityMode) return 'antigravity'
  if (s.codexMode) return 'codex'
  if (s.piMode) return 'pi'
  if (s.claudeAgentsMode) return 'claude-agents'
  if (s.claudeMode) return 'claude'
  return 'terminal'
}

export function groupOfSession(
  groups: SessionGroup[],
  sessionId: string
): SessionGroup | undefined {
  return groups.find((g) => g.sessionIds.includes(sessionId))
}

/** Identity stamped on exchange-capture events — read at event time, so the
 *  record keeps the names and group membership that were true when the event
 *  happened and survives later renames, moves, and deletions. `model` is the
 *  model the tab was opened with when Clave knows it (v2, additive); null
 *  means the CLI's default. */
export function captureEndpoint(
  s: Session,
  groups: SessionGroup[]
): {
  sessionId: string
  name: string
  mode: Exclude<SessionMode, 'pi'>
  cwd: string
  claudeSessionId: string | null
  groupId: string | null
  groupName: string | null
  model: string | null
} {
  const group = groupOfSession(groups, s.id)
  const mode = sessionMode(s)
  if (mode === 'pi') throw new Error('Pi exchange capture is unsupported')
  return {
    sessionId: s.id,
    name: s.name,
    mode,
    cwd: s.cwd,
    claudeSessionId: s.claudeSessionId ?? null,
    groupId: group?.id ?? null,
    groupName: group?.name ?? null,
    model: s.model ?? null
  }
}

/** Terminals are not agents: like tab_spawn, their lifecycle is not captured. */
function isAgentTab(s: Session): boolean {
  const mode = sessionMode(s)
  if (mode === 'terminal' || mode === 'pi') return false
  return (
    AGENT_CAPABILITIES[mode === 'claude-agents' ? 'claude' : mode].exchangeCapture === 'supported'
  )
}

/**
 * A hook word arrived for a session. Emits one `session_state` per
 * TRANSITION of the MAPPED state (Clave's `done` and `idle` are both `idle`
 * to the record) — call it BEFORE the store applies the new word, so the
 * session's current `agentState` is the transition's `previous`.
 */
export function emitAgentStateWord(
  s: Session,
  groups: SessionGroup[],
  word: AgentRunStateWord
): void {
  if (!isAgentTab(s)) return
  const transition = sessionStateTransition(s.agentState, word)
  if (transition === null) return
  try {
    window.electronAPI.captureSessionState({
      ts: new Date().toISOString(),
      session: captureEndpoint(s, groups),
      state: transition.state,
      previous: transition.previous,
      source: 'hooks'
    })
  } catch {
    // capture is observability; never a reason to break the state update
  }
}

/** The pty exited for good: `exited`, source `pty`; `previous` is the last
 *  mapped hook state. Call it while the session still carries its identity. */
export function emitSessionExited(s: Session, groups: SessionGroup[]): void {
  if (!isAgentTab(s)) return
  try {
    window.electronAPI.captureSessionState({
      ts: new Date().toISOString(),
      session: captureEndpoint(s, groups),
      state: 'exited',
      previous: s.agentState === undefined ? null : mapAgentState(s.agentState),
      source: 'pty'
    })
  } catch {
    // see above
  }
}

/**
 * A tab is being closed. `by`: `user` (sidebar, header, Cmd+Backspace;
 * `closer` null), `agent` (clave_close_session; `closer` = the calling tab),
 * `app` (a kill-all). An app QUIT emits nothing — the session survives in
 * tmux and is re-adopted. Call it BEFORE the kill, while the identity and
 * the group membership are still in the store.
 */
export function emitTabClosed(
  s: Session,
  groups: SessionGroup[],
  by: 'user' | 'agent' | 'app',
  closer: Session | null
): void {
  if (!isAgentTab(s)) return
  try {
    window.electronAPI.captureTabClosed({
      ts: new Date().toISOString(),
      session: captureEndpoint(s, groups),
      by,
      closer: closer === null ? null : captureEndpoint(closer, groups)
    })
  } catch {
    // see above
  }
}
