/**
 * Dragging a sidebar tab or group onto a pane. The sidebar's drag is
 * pointer-based (`hooks/use-sidebar-dnd.ts`), not the DOM's drag-and-drop, so
 * a pane that takes sessions cannot listen for `drop`: it marks its root with
 * `data-drop-sessions` and listens for the three events the drag dispatches
 * on it — entered, left, dropped. The enter says what hovers (tabs or a
 * group); the drop carries the tab ids, or the group's id: a group arrives
 * as itself, never as its tabs one by one (PRDCT-5032). The attribute
 * `data-drop-sessions-over` is set on the target while the drag hovers it, for
 * the stylesheet.
 */

export const DROP_SESSIONS_ATTR = 'data-drop-sessions'
export const DROP_SESSIONS_OVER_ATTR = 'data-drop-sessions-over'
export const SESSIONS_DRAG_ENTER = 'clave:sessions-drag-enter'
export const SESSIONS_DRAG_LEAVE = 'clave:sessions-drag-leave'
export const SESSIONS_DROP = 'clave:sessions-drop'

/** What a sidebar drag carries: one tab, several picked together
 *  (PRDCT-5094), or one group. */
export type SidebarDragKind = 'session' | 'sessions' | 'group'

export type SessionsDropDetail =
  | { kind: 'session'; sessionIds: string[] }
  | { kind: 'group'; groupId: string }

/** The session drop target under a point, if any. */
export function sessionDropTargetAt(x: number, y: number): HTMLElement | null {
  const el = document.elementFromPoint(x, y)
  return el?.closest<HTMLElement>(`[${DROP_SESSIONS_ATTR}]`) ?? null
}

export function enterSessionDropTarget(target: HTMLElement, kind: SidebarDragKind): void {
  target.setAttribute(DROP_SESSIONS_OVER_ATTR, 'true')
  target.dispatchEvent(new CustomEvent<SidebarDragKind>(SESSIONS_DRAG_ENTER, { detail: kind }))
}

export function leaveSessionDropTarget(target: HTMLElement): void {
  target.removeAttribute(DROP_SESSIONS_OVER_ATTR)
  target.dispatchEvent(new CustomEvent(SESSIONS_DRAG_LEAVE))
}

export function dropSessionsOn(target: HTMLElement, detail: SessionsDropDetail): void {
  target.removeAttribute(DROP_SESSIONS_OVER_ATTR)
  target.dispatchEvent(new CustomEvent<SessionsDropDetail>(SESSIONS_DROP, { detail }))
}

/** Subscribe a pane root to the drag: `onHover(kind)` on enter, `false` on
 *  leave, `onDrop(detail)` on the drop. Returns the unsubscribe. */
export function onSessionsDrag(
  target: HTMLElement,
  handlers: {
    onHover: (over: SidebarDragKind | false) => void
    onDrop: (detail: SessionsDropDetail) => void
  }
): () => void {
  const enter = (event: Event): void =>
    handlers.onHover((event as CustomEvent<SidebarDragKind>).detail ?? 'session')
  const leave = (): void => handlers.onHover(false)
  const drop = (event: Event): void => {
    const detail = (event as CustomEvent<SessionsDropDetail>).detail
    // The drop ends the hover: no leave event follows it.
    handlers.onHover(false)
    if (detail) handlers.onDrop(detail)
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
