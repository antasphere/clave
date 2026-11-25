import type { AgentState, SessionEvent } from '../../../../src/shared/session-model'
import { finishesTurn } from '../../../../src/shared/turn-state'
import type { PageStatus } from './pages'

/* What a Folio pane does when its agent's turn comes to rest (PRDCT-4832).
   The turn is tracked on the LIVE conversation state, never on the presented
   pages (frozen while the pane is hidden), so a hidden pane sees its answer
   finish, and a turn that started while hidden too. On the page, a new answer
   is read at once; off the page (the pane is the tab's chosen view but not on
   screen), or on the page while another reading holds the voice, it is filed
   as an update; otherwise nothing. Only an answer that
   ends `done` with words becomes either. Pure. */

/** A turn of the LIVE stream (never the past a pane reads): whether it ran. */
export interface TurnTrack {
  ran: boolean
}

export const NO_TURN: TurnTrack = { ran: false }

/** One live event through the turn: it runs on a state change to working or
 *  blocked, or on a main-thread text or call (a subagent's frames, with a
 *  `parent`, are not the conversation's turn); a state change to done or idle
 *  ends it when it ran (`finishesTurn`, the app's own rule); `ended` resets it
 *  and ends nothing. Pure. */
export function trackTurn(
  track: TurnTrack,
  event: SessionEvent
): { track: TurnTrack; ended: boolean } {
  if (event.type === 'state_change') {
    if (event.state === 'working' || event.state === 'blocked')
      return { track: track.ran ? track : { ran: true }, ended: false }
    if (event.state === 'ended') return { track: NO_TURN, ended: false }
    const ended = track.ran && finishesTurn('working', event.state)
    return { track: ended ? NO_TURN : track, ended }
  }
  if ((event.type === 'assistant_text' || event.type === 'tool_call') && !event.parent)
    return { track: track.ran ? track : { ran: true }, ended: false }
  return { track, ended: false }
}

export type TurnEndAction = 'read' | 'file' | 'nothing'

/** Whether the agent state is a turn running. Pure. */
export const turnRunning = (state: AgentState): boolean =>
  state === 'working' || state === 'blocked'

export function turnEndAction(input: {
  /** A turn was seen running since the last rest. */
  wasRunning: boolean
  state: AgentState
  page: { status: PageStatus; answer: string } | null | undefined
  visible: boolean
  active: boolean
  /** The play mode. */
  on: boolean
  /** A reading is in progress in this window: an automatic reading never
   *  cuts it, the answer is filed instead. */
  busy: boolean
}): TurnEndAction {
  const { wasRunning, state, page, visible, active, on, busy } = input
  if (!wasRunning || turnRunning(state) || !on) return 'nothing'
  if (!page || page.status !== 'done' || !page.answer.trim()) return 'nothing'
  if (visible && !busy) return 'read'
  return active ? 'file' : 'nothing'
}
