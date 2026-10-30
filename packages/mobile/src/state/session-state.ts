/**
 * The five states the phone shows, mapped from the server's (decision 6 of
 * the spec, the lane's brief): `working` is working, `blocked` is waiting
 * for the person, `idle` is idle, `done` and `ended` are finished, and
 * `error` is the last fatal error event the stream carried, which the
 * server's own state never says. Whether the machine is reachable is shown
 * apart (`Reachability`), never folded into a session's state.
 */
import type { AgentState, Session } from '../contract/types'

export type PhoneSessionState = 'working' | 'waiting' | 'idle' | 'finished' | 'error'

export function phoneSessionState(
  server: AgentState,
  fatalError?: string | null
): PhoneSessionState {
  if (fatalError) return 'error'
  switch (server) {
    case 'working':
      return 'working'
    case 'blocked':
      return 'waiting'
    case 'idle':
      return 'idle'
    case 'done':
    case 'ended':
      return 'finished'
  }
}

export const SESSION_STATE_LABEL: Record<PhoneSessionState, string> = {
  working: 'Working',
  waiting: 'Waiting for you',
  idle: 'Idle',
  finished: 'Finished',
  error: 'Error'
}

/** Whether the chosen machine answers, apart from any session's state. */
export type Reachability = 'connecting' | 'reachable' | 'unreachable' | 'refused'

export const REACHABILITY_LABEL: Record<Reachability, string> = {
  connecting: 'Connecting',
  reachable: 'Reachable',
  unreachable: 'Not reachable',
  refused: 'Token refused'
}

/** Chats first (the events transport), then the terminals, each group by
 *  creation, newest first. A terminal is listed read-only on the phone. */
export function orderSessions(sessions: readonly Session[]): Session[] {
  const rank = (s: Session): number => (s.transport === 'events' ? 0 : 1)
  return [...sessions].sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt)
}

/**
 * Only the host's explicit stamp identifies a workspace. An unstamped
 * session, including one from an older server, remains visible in every
 * workspace. A working folder is never workspace identity.
 */
export function workspaceOfSession(
  _session: Pick<Session, 'cwd'>,
  stampedWorkspaceId: string | undefined,
  _workspaces: readonly { id: string; rootDir: string }[]
): string | null {
  void _workspaces
  return stampedWorkspaceId ?? null
}

export function sessionsOfWorkspace(
  sessions: readonly Session[],
  stamps: ReadonlyMap<string, string | undefined>,
  workspaces: readonly { id: string; rootDir: string }[],
  workspaceId: string
): Session[] {
  return orderSessions(
    sessions.filter((s) => {
      const home = workspaceOfSession(s, stamps.get(s.id), workspaces)
      return home === null || home === workspaceId
    })
  )
}
