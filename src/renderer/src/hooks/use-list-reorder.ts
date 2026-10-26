import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { DropPosition } from '../../../shared/workspace-order'

/**
 * Drag-to-reorder for a short vertical list whose rows are clickable (#257:
 * the workspace switcher and Settings → Workspaces). Pointer events rather
 * than HTML drag and drop, as the sidebar does: the row stays a button, a
 * press that never travels past the threshold is still its click, and the
 * click a drag ends on is swallowed.
 *
 * Each row spreads `rowProps(id, scope)`. A row only takes a drop from a row
 * of the same scope (a workspace never crosses from one machine's list into
 * another's), a drop that would leave the list as it is shows nothing, and
 * the line is withdrawn once the pointer leaves the list: released there, or
 * after Escape, the drag changes nothing and its release clicks nothing.
 * Controls inside a row (inputs, selects, buttons, `[data-no-drag]`) never
 * start a drag. The nearest scrolling ancestor scrolls while the pointer
 * rests near its top or bottom edge.
 */

const DRAG_THRESHOLD = 4
const EDGE_ZONE = 28
const EDGE_SPEED = 8
const NO_DRAG = 'input, textarea, select, button, a, [role="button"], [data-no-drag]'

export interface ReorderIndicator {
  targetId: string
  position: DropPosition
}

interface Press {
  id: string
  scope: string
  row: HTMLElement
  x: number
  y: number
  pointerId: number
  started: boolean
  indicator: ReorderIndicator | null
  scroller: HTMLElement | null
  lastY: number
  frame: number | null
}

export interface ReorderRowProps {
  'data-reorder-id': string
  'data-reorder-scope': string
  'data-dragging'?: true
  'data-drop'?: DropPosition
  onPointerDown: (e: React.PointerEvent<HTMLElement>) => void
  onClickCapture: (e: React.MouseEvent<HTMLElement>) => void
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight)
      return node
  }
  return null
}

/** One frame of the edge scroll, rescheduling itself until the press ends. */
function autoScroll(press: { current: Press | null }): void {
  const p = press.current
  if (!p || !p.scroller) return
  const rect = p.scroller.getBoundingClientRect()
  let delta = 0
  if (p.lastY < rect.top + EDGE_ZONE) delta = -EDGE_SPEED
  else if (p.lastY > rect.bottom - EDGE_ZONE) delta = EDGE_SPEED
  if (delta !== 0) p.scroller.scrollTop += delta
  p.frame = requestAnimationFrame(() => autoScroll(press))
}

function rowsOf(scope: string, near: HTMLElement): HTMLElement[] {
  const root = near.parentElement ?? document
  return Array.from(root.querySelectorAll<HTMLElement>('[data-reorder-id]')).filter(
    (el) => el.dataset.reorderScope === scope
  )
}

/** Where a drop at `y` over `target` would land, or null when it would leave
 *  the list unchanged (onto the row itself, or right beside it). */
function indicatorAt(press: Press, target: HTMLElement, y: number): ReorderIndicator | null {
  const targetId = target.dataset.reorderId!
  if (targetId === press.id || target.dataset.reorderScope !== press.scope) return null
  const rect = target.getBoundingClientRect()
  const position: DropPosition = y < rect.top + rect.height / 2 ? 'before' : 'after'
  const rows = rowsOf(press.scope, press.row)
  const from = rows.indexOf(press.row)
  const to = rows.indexOf(target)
  if (position === 'before' && to === from + 1) return null
  if (position === 'after' && to === from - 1) return null
  return { targetId, position }
}

export function useListReorder(
  onMove: (id: string, targetId: string, position: DropPosition) => void
): {
  draggingId: string | null
  indicator: ReorderIndicator | null
  rowProps: (id: string, scope?: string) => ReorderRowProps
} {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [indicator, setIndicator] = useState<ReorderIndicator | null>(null)
  const press = useRef<Press | null>(null)
  const swallowClick = useRef(false)
  const onMoveRef = useRef(onMove)
  useLayoutEffect(() => {
    onMoveRef.current = onMove
  })
  const detach = useRef<(() => void) | null>(null)
  const awaitRelease = useRef<(() => void) | null>(null)

  /** End the press. `released` says the button is already up; otherwise
   *  (Escape, the window losing focus) the click its later release produces
   *  is still the drag's, and is swallowed when it comes. */
  const end = useCallback((commit: boolean, released = true) => {
    const p = press.current
    press.current = null
    detach.current?.()
    detach.current = null
    if (!p) return
    if (p.frame !== null) cancelAnimationFrame(p.frame)
    if (p.started) {
      document.body.classList.remove('reorder-dragging')
      swallowClick.current = true
      // The click a release produces (if any) arrives before this fires.
      const clearAfterClick = (): void => {
        setTimeout(() => {
          swallowClick.current = false
        }, 0)
      }
      if (released) clearAfterClick()
      else {
        const onRelease = (): void => {
          awaitRelease.current?.()
          clearAfterClick()
        }
        window.addEventListener('pointerup', onRelease, true)
        awaitRelease.current = () => {
          window.removeEventListener('pointerup', onRelease, true)
          awaitRelease.current = null
        }
      }
      setDraggingId(null)
      setIndicator(null)
      if (commit && p.indicator) onMoveRef.current(p.id, p.indicator.targetId, p.indicator.position)
    }
  }, [])

  useEffect(
    () => () => {
      end(false)
      awaitRelease.current?.()
    },
    [end]
  )

  const track = useCallback((x: number, y: number) => {
    const p = press.current
    if (!p) return
    p.lastY = y
    const hit = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-reorder-id]')
    // Between two rows the line stays; outside the list it is withdrawn.
    const list = p.row.parentElement?.getBoundingClientRect()
    const inList = !!list && x >= list.left && x <= list.right && y >= list.top && y <= list.bottom
    const next = hit ? indicatorAt(p, hit, y) : inList ? p.indicator : null
    if (next?.targetId !== p.indicator?.targetId || next?.position !== p.indicator?.position) {
      p.indicator = next
      setIndicator(next)
    }
  }, [])

  const rowProps = useCallback(
    (id: string, scope = ''): ReorderRowProps => ({
      'data-reorder-id': id,
      'data-reorder-scope': scope,
      ...(draggingId === id ? { 'data-dragging': true as const } : {}),
      ...(indicator?.targetId === id ? { 'data-drop': indicator.position } : {}),
      onPointerDown: (e) => {
        if (e.button !== 0 || press.current) return
        const from = e.target as HTMLElement
        const within = from.closest(NO_DRAG)
        if (within && within !== e.currentTarget && e.currentTarget.contains(within)) return
        // A new press is never the leftover of an earlier drag.
        awaitRelease.current?.()
        swallowClick.current = false
        press.current = {
          id,
          scope,
          row: e.currentTarget,
          x: e.clientX,
          y: e.clientY,
          pointerId: e.pointerId,
          started: false,
          indicator: null,
          scroller: null,
          lastY: e.clientY,
          frame: null
        }
        const move = (ev: PointerEvent): void => {
          const p = press.current
          if (!p || ev.pointerId !== p.pointerId) return
          if (!p.started) {
            if (Math.hypot(ev.clientX - p.x, ev.clientY - p.y) < DRAG_THRESHOLD) return
            p.started = true
            p.scroller = scrollParent(p.row)
            document.body.classList.add('reorder-dragging')
            setDraggingId(p.id)
            p.frame = requestAnimationFrame(() => autoScroll(press))
          }
          ev.preventDefault()
          track(ev.clientX, ev.clientY)
        }
        const up = (ev: PointerEvent): void => {
          if (ev.pointerId === press.current?.pointerId) end(true)
        }
        const cancel = (): void => end(false)
        const lost = (): void => end(false, false)
        const key = (ev: KeyboardEvent): void => {
          if (ev.key !== 'Escape' || !press.current?.started) return
          // Escape ends the drag, not the popover or dialog holding the list.
          ev.preventDefault()
          ev.stopPropagation()
          end(false, false)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
        window.addEventListener('pointercancel', cancel)
        window.addEventListener('blur', lost)
        window.addEventListener('keydown', key, true)
        detach.current = () => {
          window.removeEventListener('pointermove', move)
          window.removeEventListener('pointerup', up)
          window.removeEventListener('pointercancel', cancel)
          window.removeEventListener('blur', lost)
          window.removeEventListener('keydown', key, true)
        }
      },
      onClickCapture: (e) => {
        if (!swallowClick.current) return
        swallowClick.current = false
        e.preventDefault()
        e.stopPropagation()
      }
    }),
    [draggingId, indicator, end, track]
  )

  return { draggingId, indicator, rowProps }
}
