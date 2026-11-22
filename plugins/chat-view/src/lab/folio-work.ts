import type { WorkFigures, WorkRow } from '../work'

/* Folio's work dock (FolioWork.tsx), its pure rules: which marks the closed
   pill shows, and when the dock opens and closes. The component feeds the
   reducer events and runs its two timers; nothing here touches the DOM. */

/** The marks the closed pill shows: the first `max` rows in the strip's
 *  order (running, then leaving), and how many running rows are past them. */
export function dockMarks(rows: WorkRow[], max = 4): { marks: WorkRow[]; overflow: number } {
  return {
    marks: rows.slice(0, max),
    overflow: rows.slice(max).filter((row) => !row.gone).length
  }
}

/** The model a dock row names in its figures: the one it runs on once it
 *  is known, else nothing. The strip's "…" read as a line cut short at the
 *  end of a row of figures. */
export const dockModel = (figures: WorkFigures): string | null =>
  figures.modelKnown ? figures.model : null

/** How long the pointer rests on the pill before the card opens, and how
 *  long after it has left both before the card closes, so the way from the
 *  pill into the card never closes it. */
export const OPEN_BEAT_MS = 120
export const CLOSE_BEAT_MS = 280

/** Why the dock is open: the pointer over it, the keyboard's focus inside
 *  it, or a click on the pill that pinned it; and what a timer will do when
 *  it comes due. `held`: a window onto a row's work (or its relaunch
 *  dialog) is open over the card, which stays open under it. */
export interface DockState {
  open: null | 'hover' | 'focus' | 'pinned'
  pending: 'open' | 'close' | null
  held: boolean
}
export type DockEvent =
  | 'pointer-in'
  | 'pointer-out'
  | 'focus-in'
  | 'focus-out'
  | 'pill-click'
  | 'escape'
  | 'outside'
  | 'window-open'
  | 'window-close'
  | 'beat'

export const closedDock: DockState = { open: null, pending: null, held: false }

const shut = (state: DockState): DockState => ({ ...state, open: null, pending: null })

/** One event, the dock's next state. Pinned outranks focus, focus outranks
 *  hover: the pointer leaving never closes a pinned dock or one the keyboard
 *  is in, and a held dock closes on nothing but its window closing first. */
export function nextDock(state: DockState, event: DockEvent): DockState {
  switch (event) {
    case 'pointer-in':
      // Closed: open after the beat. Open: a close on its way is called off.
      return state.open === null
        ? { ...state, pending: 'open' }
        : state.pending === 'close'
          ? { ...state, pending: null }
          : state
    case 'pointer-out':
      if (state.open === null) return state.pending === 'open' ? { ...state, pending: null } : state
      return state.open === 'hover' && !state.held ? { ...state, pending: 'close' } : state
    case 'beat':
      if (state.pending === 'open') return { ...state, open: state.open ?? 'hover', pending: null }
      if (state.pending === 'close') return state.held ? { ...state, pending: null } : shut(state)
      return state
    case 'focus-in':
      return state.open === 'pinned' ? state : { ...state, open: 'focus', pending: null }
    case 'focus-out':
      return state.open === 'focus' && !state.held ? shut(state) : state
    case 'pill-click':
      return state.open === 'pinned' ? shut(state) : { ...state, open: 'pinned', pending: null }
    case 'escape':
    case 'outside':
      // A window open over the card takes the Escape and the click first.
      return state.held ? state : shut(state)
    case 'window-open':
      return { ...state, held: true, pending: null }
    case 'window-close':
      return { ...state, held: false }
  }
}
