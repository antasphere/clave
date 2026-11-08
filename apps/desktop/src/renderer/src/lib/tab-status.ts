import type { Session } from '../store/session-types'

/**
 * What a sidebar tab says about its session, and the one place that decides it.
 *
 * The row carries a single signal at a time, in the status slot on its right
 * (`tabStatusPresentation` below says what the slot draws): motion means
 * working, colour means "go look". Subagents still at work keep it turning
 * (their count inside the spinner); commands left running are named in its
 * tooltip. Everything the row paints comes from here.
 *
 *   needs-you → a permission or a question waits on the reader
 *   working   → the agent is on a turn, or its subagents still are
 *   unread    → a turn finished while the tab was not in view, or another tab
 *               wrote to it; back to idle once the tab is opened
 *   idle      → at rest
 *   ended     → the process has exited
 *
 * Priority when several apply: needs-you > working > unread > idle; ended
 * overrides them all. Providers without a deterministic state signal
 * (Antigravity, plain terminals, remote agents) only ever read idle or unread,
 * the latter from a cross-tab message.
 */
export type TabStatus = 'needs-you' | 'working' | 'unread' | 'idle' | 'ended'

export interface TabIndicators {
  status: TabStatus
  /** Background shells and other tasks still running past the turn (named in
   *  the status glyph's tooltip); subagents are not among them, see `agents`.
   *  0 for none. */
  background: number
  /** Subagents still at work past the turn. While one runs the tab reads
   *  working, not done, and the spinner carries their count. 0 for none. */
  agents: number
}

type StatusFields = Pick<
  Session,
  | 'alive'
  | 'agentState'
  | 'backgroundTasks'
  | 'backgroundAgents'
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
  if (lifecycle && !session.alive) return { status: 'ended', background: 0, agents: 0 }
  const state = session.agentState ?? 'idle'
  const tasks = lifecycle ? Math.max(0, session.backgroundTasks ?? 0) : 0
  const agents = lifecycle ? Math.min(tasks, Math.max(0, session.backgroundAgents ?? 0)) : 0
  const background = tasks - agents
  // Pi's extension writes the same words, but only Claude and Codex have a
  // prompt Clave recognises as waiting on the reader.
  const canBlock = lifecycle && !session.piMode
  const status: TabStatus =
    canBlock && state === 'blocked'
      ? 'needs-you'
      : lifecycle && (state === 'working' || agents > 0)
        ? 'working'
        : session.injectedFrom || (lifecycle && session.hasUnseenActivity)
          ? 'unread'
          : 'idle'
  return { status, background, agents }
}

/**
 * What the row's trailing status slot draws (PRDCT-3933): the glyph, its ink
 * and the words its tooltip and a screen reader get, from the one status
 * above. One place, so the row, its tests and the specs agree.
 *
 *   working   → a segmented spinner, grey; while subagents run past the turn,
 *               the spinner still turns (the agent is at work, not done) with
 *               their count inside its ring
 *   needs-you → a question mark in a circle, amber
 *   unread    → a check in a circle, blue, whatever brought the news: a turn
 *               finished out of view or another tab's message (the label
 *               names the tab; the envelope it once drew went with PRDCT-4078)
 *   idle      → a check in a circle, grey, once a turn has finished and been
 *               read (Claude and Pi rest on `done`; Codex rests on `idle` and
 *               reads as fresh again); nothing on a fresh tab
 *   ended     → a minus in a circle, dimmed
 */
export type TabGlyph = 'spinner' | 'question' | 'check' | 'minus'
export type TabTone = 'grey' | 'amber' | 'blue' | 'dim'

export interface TabStatusPresentation {
  status: TabStatus
  /** Null draws nothing: the slot stays, empty. */
  glyph: TabGlyph | null
  tone: TabTone
  /** The tooltip and the accessible name; null when there is nothing to say. */
  label: string | null
  /** Subagents at work, drawn as a number inside the spinner; absent for none. */
  agents?: number
}

export function tabStatusPresentation(session: StatusFields): TabStatusPresentation {
  const { status } = tabIndicators(session)
  switch (status) {
    case 'needs-you':
      return { status, glyph: 'question', tone: 'amber', label: 'Waiting on you' }
    case 'working': {
      const { agents } = tabIndicators(session)
      return {
        status,
        glyph: 'spinner',
        tone: 'grey',
        label: agents
          ? `Working · ${agents} ${agents === 1 ? 'subagent' : 'subagents'} running`
          : 'Working',
        agents
      }
    }
    case 'unread':
      // One glyph for one piece of news, whatever brought it (PRDCT-4078): the
      // envelope that stood for another tab's message read as a second signal
      // beside the check. The label still names the tab that wrote.
      return {
        status,
        glyph: 'check',
        tone: 'blue',
        label: session.injectedFrom
          ? `Message from ${session.injectedFrom}`
          : 'Finished while you were away'
      }
    case 'ended':
      return { status, glyph: 'minus', tone: 'dim', label: 'Ended' }
    case 'idle': {
      // Commands a turn left running (a dev server, a watcher) do not keep the
      // tab working; the row says them in the tooltip, not in a counter.
      const { background } = tabIndicators(session)
      const still = background
        ? `${background} ${background === 1 ? 'command' : 'commands'} still running`
        : null
      return hasLifecycleState(session) && session.agentState === 'done'
        ? {
            status,
            glyph: 'check',
            tone: 'grey',
            label: still ? `Finished · ${still}` : 'Finished'
          }
        : { status, glyph: null, tone: 'grey', label: still }
    }
  }
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
