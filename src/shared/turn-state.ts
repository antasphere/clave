import type { AgentState } from './session-model'

/**
 * Whether a state change leaves something new to read: a turn that was running
 * (or waiting on the reader) has come to rest. Codex rests on `idle`, Claude and
 * Pi on `done`. A first state after a restore (undefined → done) is not news.
 *
 * Shared (PRDCT-4472): the sidebar marks a tab unread by it, and the server
 * that owns a session's artefact saves a version by it, so the two never
 * disagree on what a finished turn is.
 */
export function finishesTurn(
  previous: AgentState | undefined,
  next: AgentState | undefined
): boolean {
  return (previous === 'working' || previous === 'blocked') && (next === 'done' || next === 'idle')
}
