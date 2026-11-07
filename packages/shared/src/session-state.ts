/**
 * The mapping from Clave's deterministic agent run state (fed by Claude Code
 * lifecycle hooks, `AgentRunState` in the renderer's session-types) to the
 * exos workstream event stream's `session_state` values (spec §1.3):
 * working → working; idle and done → idle (a turn that ended and a tab
 * waiting for input are the same state to a reader); blocked (a permission
 * or input prompt is waiting) → blocked. A pty exit is `exited` with source
 * `pty` and has no hook word. Shared by the renderer (which emits the
 * events) and the tests.
 */

export type AgentRunStateWord = 'idle' | 'working' | 'blocked' | 'done'
export type CapturedSessionState = 'working' | 'idle' | 'blocked' | 'exited'

export function mapAgentState(state: AgentRunStateWord): CapturedSessionState {
  switch (state) {
    case 'working':
      return 'working'
    case 'blocked':
      return 'blocked'
    case 'idle':
    case 'done':
      return 'idle'
  }
}

/**
 * One event per TRANSITION, none on a no-op — measured on the MAPPED state:
 * Clave's `done` after `idle` (or the reverse) is the same captured state and
 * emits nothing. Returns the event's `previous`/`state` pair, or null when
 * nothing changed.
 */
export function sessionStateTransition(
  previous: AgentRunStateWord | undefined,
  next: AgentRunStateWord
): { previous: CapturedSessionState | null; state: CapturedSessionState } | null {
  const state = mapAgentState(next)
  const before = previous === undefined ? null : mapAgentState(previous)
  if (before === state) return null
  return { previous: before, state }
}
