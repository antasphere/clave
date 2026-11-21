import type { AgentState } from '../../../../src/shared/session-model'
import type { PageStatus } from './pages'

/* What a Folio pane does when its agent's turn comes to rest (PRDCT-4832).
   The turn is tracked on the LIVE conversation state, never on the presented
   pages (frozen while the pane is hidden), so a hidden pane sees its answer
   finish, and a turn that started while hidden too. On the page, a new answer
   is read at once; off the page (the pane is the tab's chosen view but not on
   screen), it is filed as an update; otherwise nothing. Only an answer that
   ends `done` with words becomes either. Pure. */

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
}): TurnEndAction {
  const { wasRunning, state, page, visible, active, on } = input
  if (!wasRunning || turnRunning(state) || !on) return 'nothing'
  if (!page || page.status !== 'done' || !page.answer.trim()) return 'nothing'
  if (visible) return 'read'
  return active ? 'file' : 'nothing'
}
