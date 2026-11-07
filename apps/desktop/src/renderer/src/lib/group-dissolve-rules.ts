import type { Session, SessionGroup } from '../store/session-types'

/**
 * The PURE half of dissolving a group (Delete or Ungroup): what dies, and
 * whether to ask first. Kept apart from `group-dissolve.ts` — which imports
 * the session store and so needs a window — so vitest can pin these rules
 * in the node environment. See that file for the why.
 */

export type DissolveMode = 'delete' | 'ungroup'

type GroupLike = Pick<SessionGroup, 'id' | 'sessionIds' | 'terminals'>
type SessionLike = Pick<Session, 'id' | 'alive'>

/** The quick-launch terminal sessions of the group that are actually running. */
export function runningTerminalSessions(group: GroupLike, sessions: SessionLike[]): string[] {
  return group.terminals
    .map((t) => t.sessionId)
    .filter((id): id is string => id !== null)
    .filter((id) => sessions.some((s) => s.id === id && s.alive))
}

/**
 * Every session to kill when the group dissolves: its terminals in both
 * modes (running or not — a dead one still holds a record), plus its members
 * on Delete. Ungroup keeps the members: they become tabs.
 */
export function sessionsToKillOnDissolve(group: GroupLike, mode: DissolveMode): string[] {
  const terminals = group.terminals
    .map((t) => t.sessionId)
    .filter((id): id is string => id !== null)
  return mode === 'delete' ? [...new Set([...group.sessionIds, ...terminals])] : terminals
}

export interface DissolveConfirmation {
  title: string
  message: string
  confirmLabel: string
}

/**
 * The question to ask before dissolving, or null when nothing running would
 * be stopped silently. Delete and Ungroup are both immediate today; the
 * prompt exists ONLY for the case the user cannot see coming — a running
 * terminal behind the group row that the action is about to stop.
 */
export function dissolveConfirmation(
  group: GroupLike,
  sessions: SessionLike[],
  mode: DissolveMode
): DissolveConfirmation | null {
  const running = runningTerminalSessions(group, sessions).length
  if (running === 0) return null
  const what = running === 1 ? '1 running terminal' : `${running} running terminals`
  return mode === 'delete'
    ? {
        title: 'Delete group',
        message: `This group has ${what}. Deleting it closes its sessions and stops ${running === 1 ? 'that terminal' : 'those terminals'}.`,
        confirmLabel: 'Delete'
      }
    : {
        title: 'Ungroup',
        message: `This group has ${what}. Ungrouping keeps its sessions as tabs but stops ${running === 1 ? 'that terminal' : 'those terminals'}.`,
        confirmLabel: 'Ungroup'
      }
}
