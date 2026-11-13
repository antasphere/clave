/**
 * Dragging a sidebar tab onto a pane. The sidebar's drag is pointer-based
 * (`hooks/use-sidebar-dnd.ts`), not the DOM's drag-and-drop, so a pane that
 * takes sessions cannot listen for `drop`: it marks its root with
 * `data-drop-sessions` and listens for the three events the drag dispatches
 * on it — entered, left, dropped — the last carrying the session ids (a group
 * dragged carries every session of the group, in order). The attribute
 * `data-drop-sessions-over` is set on the target while the drag hovers it, for
 * the stylesheet.
 */

export const DROP_SESSIONS_ATTR = 'data-drop-sessions'
export const DROP_SESSIONS_OVER_ATTR = 'data-drop-sessions-over'
export const SESSIONS_DRAG_ENTER = 'clave:sessions-drag-enter'
export const SESSIONS_DRAG_LEAVE = 'clave:sessions-drag-leave'
export const SESSIONS_DROP = 'clave:sessions-drop'

export interface SessionsDropDetail {
  sessionIds: string[]
}

/** The session drop target under a point, if any. */
export function sessionDropTargetAt(x: number, y: number): HTMLElement | null {
  const el = document.elementFromPoint(x, y)
  return el?.closest<HTMLElement>(`[${DROP_SESSIONS_ATTR}]`) ?? null
}

export function enterSessionDropTarget(target: HTMLElement): void {
  target.setAttribute(DROP_SESSIONS_OVER_ATTR, 'true')
  target.dispatchEvent(new CustomEvent(SESSIONS_DRAG_ENTER))
}

export function leaveSessionDropTarget(target: HTMLElement): void {
  target.removeAttribute(DROP_SESSIONS_OVER_ATTR)
  target.dispatchEvent(new CustomEvent(SESSIONS_DRAG_LEAVE))
}

export function dropSessionsOn(target: HTMLElement, sessionIds: string[]): void {
  target.removeAttribute(DROP_SESSIONS_OVER_ATTR)
  target.dispatchEvent(
    new CustomEvent<SessionsDropDetail>(SESSIONS_DROP, { detail: { sessionIds } })
  )
}

/** Subscribe a pane root to the drag: `onHover(true)` on enter, `false` on
 *  leave, `onDrop(ids)` on the drop. Returns the unsubscribe. */
export function onSessionsDrag(
  target: HTMLElement,
  handlers: { onHover: (over: boolean) => void; onDrop: (sessionIds: string[]) => void }
): () => void {
  const enter = (): void => handlers.onHover(true)
  const leave = (): void => handlers.onHover(false)
  const drop = (event: Event): void => {
    const detail = (event as CustomEvent<SessionsDropDetail>).detail
    // The drop ends the hover: no leave event follows it.
    handlers.onHover(false)
    handlers.onDrop(detail?.sessionIds ?? [])
  }
  target.setAttribute(DROP_SESSIONS_ATTR, 'true')
  target.addEventListener(SESSIONS_DRAG_ENTER, enter)
  target.addEventListener(SESSIONS_DRAG_LEAVE, leave)
  target.addEventListener(SESSIONS_DROP, drop)
  return () => {
    target.removeAttribute(DROP_SESSIONS_ATTR)
    target.removeAttribute(DROP_SESSIONS_OVER_ATTR)
    target.removeEventListener(SESSIONS_DRAG_ENTER, enter)
    target.removeEventListener(SESSIONS_DRAG_LEAVE, leave)
    target.removeEventListener(SESSIONS_DROP, drop)
  }
}
