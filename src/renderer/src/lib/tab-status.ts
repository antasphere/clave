import type { Session } from '../store/session-types'

/**
 * What a sidebar tab says about its session, and the one place that decides it.
 *
 * The provider logo carries a single signal at a time — motion means working,
 * colour means "go look" — and background work never touches the logo: it is a
 * counter on the row's right side. Everything the row paints comes from here.
 *
 *   needs-you → amber logo (a permission or a question waits on the reader)
 *   working   → grey logo inside a spinning ring
 *   unread    → blue logo (a turn finished while the tab was not in view, or
 *               another tab wrote to it); back to idle once the tab is opened
 *   idle      → grey logo
 *   ended     → dimmed logo
 *
 * Priority when several apply: needs-you > working > unread > idle; ended
 * overrides them all. Providers without a deterministic state signal
 * (Antigravity, plain terminals, remote agents) only ever read idle or unread,
 * the latter from a cross-tab message.
 */
export type TabStatus = 'needs-you' | 'working' | 'unread' | 'idle' | 'ended'

export interface TabIndicators {
  status: TabStatus
  /** Background shells and subagents still running past the turn; 0 for none. */
  background: number
}

type StatusFields = Pick<
  Session,
  | 'alive'
  | 'agentState'
  | 'backgroundTasks'
  | 'hasUnseenActivity'
  | 'injectedFrom'
  | 'sessionType'
  | 'claudeMode'
  | 'claudeAgentsMode'
  | 'antigravityMode'
  | 'codexMode'
  | 'piMode'
>

/** Whether the session reports a lifecycle (working / blocked / done) Clave can
 *  trust: local Claude Code, Codex and Pi. The others stay neutral. */
export function hasLifecycleState(session: StatusFields): boolean {
  if (session.sessionType !== 'local') return false
  const claudeCode =
    session.claudeMode === true &&
    !session.claudeAgentsMode &&
    !session.antigravityMode &&
    !session.codexMode &&
    !session.piMode
  return claudeCode || session.codexMode === true || session.piMode === true
}

export function tabIndicators(session: StatusFields): TabIndicators {
  const lifecycle = hasLifecycleState(session)
  if (lifecycle && !session.alive) return { status: 'ended', background: 0 }
  const state = session.agentState ?? 'idle'
  const background = lifecycle ? Math.max(0, session.backgroundTasks ?? 0) : 0
  // Pi's extension writes the same words, but only Claude and Codex have a
  // prompt Clave recognises as waiting on the reader.
  const canBlock = lifecycle && !session.piMode
  const status: TabStatus =
    canBlock && state === 'blocked'
      ? 'needs-you'
      : lifecycle && state === 'working'
        ? 'working'
        : session.injectedFrom || (lifecycle && session.hasUnseenActivity)
          ? 'unread'
          : 'idle'
  return { status, background }
}

/**
 * Whether a state change leaves something new to read: a turn that was running
 * (or waiting on the reader) has come to rest. Codex rests on `idle`, Claude and
 * Pi on `done`. A first state after a restore (undefined → done) is not news.
 */
export function finishesTurn(
  previous: Session['agentState'],
  next: Session['agentState']
): boolean {
  return (previous === 'working' || previous === 'blocked') && (next === 'done' || next === 'idle')
}
