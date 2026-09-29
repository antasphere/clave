import { useCallback, useEffect, useRef, useState } from 'react'
import { useSessionStore, type SessionGroup } from '../store/session-store'

export interface DropIndicatorState {
  targetId: string
  position: 'before' | 'after' | 'inside'
}

interface DndRenderState {
  isDragging: boolean
  draggedIds: string[]
  dropIndicator: DropIndicatorState | null
  isOverPinnedZone: boolean
}

interface DragRef {
  ids: string[]
  isGroup: boolean
  startX: number
  startY: number
  started: boolean
  sourceEl: HTMLElement | null
  currentIndicator: DropIndicatorState | null
  scrollAnimFrame: number | null
  overlayWidth: number
  overPinnedZone: boolean
}

const DRAG_THRESHOLD = 5
const AUTO_SCROLL_ZONE = 40
const AUTO_SCROLL_SPEED = 10
const SETTLE_DURATION = 150 // ms for drop settle animation
const INDICATOR_DEBOUNCE = 32 // ms — absorbs layout-induced oscillation
// Fraction of a row's height the cursor must travel past a zone boundary
// before the indicator flips — a cursor resting on a midline stays put.
const ZONE_BAND = 0.08
// Pixels past a group card's bottom edge the cursor must travel, once the line
// is at the card's last position, before the target becomes "after the group".
const CARD_EXIT_BAND = 14

export function useSidebarDnd(opts: {
  containerRef: React.RefObject<HTMLElement | null>
  moveItems: (ids: string[], targetId: string, position: 'before' | 'after' | 'inside') => void
  pinnedZoneRef?: React.RefObject<HTMLElement | null>
  onPinnedDrop?: (groupId: string) => void
}): {
  isDragging: boolean
  draggedIds: string[]
  dropIndicator: DropIndicatorState | null
  isOverPinnedZone: boolean
  handlePointerDown: (e: React.PointerEvent, itemId: string, isGroup: boolean) => void
} {
  const { containerRef, moveItems, pinnedZoneRef, onPinnedDrop } = opts

  const [dndState, setDndState] = useState<DndRenderState>({
    isDragging: false,
    draggedIds: [],
    dropIndicator: null,
    isOverPinnedZone: false
  })

  const dragRef = useRef<DragRef | null>(null)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const indicatorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Create/destroy overlay element
  const createOverlay = useCallback((sourceEl: HTMLElement) => {
    const overlay = document.createElement('div')
    overlay.className = 'sidebar-drag-overlay'

    // Clone the button content from the source
    const button = sourceEl.querySelector('button')
    if (button) {
      const clone = button.cloneNode(true) as HTMLElement
      // Strip event listeners by re-creating as innerHTML
      overlay.innerHTML = ''
      overlay.appendChild(clone)
      clone.style.pointerEvents = 'none'
      clone.style.opacity = '1'
      // Match the source width
      overlay.style.width = `${button.getBoundingClientRect().width}px`
    }

    // Try to pick up the group's background color from the parent container
    let overlayBg = 'var(--color-surface-100)'
    const groupContainer = sourceEl.closest<HTMLElement>('.rounded-xl.border')
    if (groupContainer?.style.backgroundColor) {
      overlayBg = groupContainer.style.backgroundColor
    }

    Object.assign(overlay.style, {
      position: 'fixed',
      zIndex: '99999',
      pointerEvents: 'none',
      // Translucent enough for the drop line to read through it: the line
      // takes no space, so it sits under the cursor — under the ghost.
      opacity: '0.55',
      transform: 'scale(1.02)',
      borderRadius: '8px',
      background: overlayBg,
      boxShadow: '0 8px 24px rgba(0,0,0,0.15), 0 2px 8px rgba(0,0,0,0.1)',
      transition: 'opacity 150ms, transform 150ms',
      willChange: 'left, top'
    })

    document.body.appendChild(overlay)
    overlayRef.current = overlay
  }, [])

  const destroyOverlay = useCallback(() => {
    if (overlayRef.current) {
      overlayRef.current.remove()
      overlayRef.current = null
    }
  }, [])

  // Hit-test: find the row under the cursor and decide where a drop would land.
  //
  // Every row offers exactly two zones, top half = before it, bottom half =
  // after it — the same for a row of the dragged item's own group, of another
  // group, or of the top level. That is what makes a group's FIRST and LAST
  // position reachable from outside: earlier, a foreign drag over the first
  // row was redirected to "inside" (which appends at the END) and the last row
  // was cut into three 10px bands, so neither edge could be aimed at.
  //
  // Group headers keep their own zones (before / inside), and the group's
  // "New session" row is an explicit "after the last row" zone (30px tall, a
  // full row's worth of "last position"). Leaving a group is aimed at what
  // comes after it: the next item's top half, or the empty space below.
  //
  // Two things keep the indicator from jumping between neighbours:
  //   - the drop line takes no space (see DropGap in Sidebar), so nothing
  //     ever shifts under a cursor that has not moved;
  //   - hysteresis: a zone boundary is crossed only by a margin (ZONE_BAND),
  //     and a card is left only past CARD_EXIT_BAND.
  const hitTest = useCallback(
    (clientX: number, clientY: number, drag: DragRef) => {
      const container = containerRef.current
      if (!container) return

      // Every row the user can SEE. A collapsed group keeps its rows in the
      // DOM (a height-0 grid track clipped by overflow), and their bounding
      // rects still extend over whatever is rendered below the group — so an
      // unfiltered walk in DOM order matched an invisible row first, and a
      // drop aimed at the group underneath landed inside the collapsed one.
      const visible = (el: Element): boolean => !el.closest('[data-group-collapsed="true"]')
      const items = [...container.querySelectorAll<HTMLElement>('[data-sidebar-item-id]')].filter(
        visible
      )
      if (items.length === 0) return

      const state = useSessionStore.getState()
      const groupOf = (rowId: string): SessionGroup | undefined =>
        state.groups.find((g) => g.sessionIds.includes(rowId))
      const cur = drag.currentIndicator
      // Sticky split: which side of `boundary` (as a fraction of the row) the
      // cursor is on, holding the current side until it is left by ZONE_BAND.
      const side = (frac: number, boundary: number, held: 'lo' | 'hi' | null): 'lo' | 'hi' => {
        if (held === 'lo') return frac > boundary + ZONE_BAND ? 'hi' : 'lo'
        if (held === 'hi') return frac < boundary - ZONE_BAND ? 'lo' : 'hi'
        return frac < boundary ? 'lo' : 'hi'
      }

      let newIndicator: DropIndicatorState | null = null
      // A decision was made — including the decision "stay where you are"
      // (null). Without this a "stay" fell through to the fallbacks below,
      // which read the empty spot as "after the row above → after the GROUP":
      // hovering your own faded row, or your group's header when you are its
      // only row, meant leaving the group — and a single-row group could not
      // take its row back at all.
      let resolved = false
      // The card (group container) a row belongs to.
      const cardRectOf = (groupId: string): { top: number; bottom: number } | null => {
        const headerEl = container.querySelector<HTMLElement>(`[data-sidebar-item-id="${groupId}"]`)
        const card = headerEl?.closest<HTMLElement>('.group-scope')
        if (!card) return null
        const r = card.getBoundingClientRect()
        return { top: r.top, bottom: r.bottom }
      }

      // The exit band: while the target is inside a card (a line at one of
      // its rows, or "stay" for a row of that card), the CARD_EXIT_BAND pixels
      // under the card's bottom edge keep that target, whatever is rendered
      // there — the next card's header sits right below, and the old
      // behaviour offered the row outside the moment the cursor touched it.
      // Leaving is a deliberate move past the band.
      {
        const holdGroup = cur
          ? cur.position === 'inside'
            ? null
            : groupOf(cur.targetId)
          : drag.isGroup
            ? undefined
            : groupOf(drag.ids[0])
        const card = holdGroup ? cardRectOf(holdGroup.id) : null
        if (card && clientY > card.bottom && clientY <= card.bottom + CARD_EXIT_BAND) {
          newIndicator = cur
          resolved = true
        }
      }

      for (const itemEl of resolved ? [] : items) {
        const rect = itemEl.getBoundingClientRect()
        if (clientX < rect.left || clientX > rect.right) continue
        if (clientY < rect.top - 2 || clientY > rect.bottom + 2) continue

        const itemId = itemEl.dataset.sidebarItemId!
        const isGroup = itemEl.dataset.sidebarItemType === 'group'
        // Over itself (the faded row left in place): the row's own place is
        // always a valid target, and it means "stay" — no line, no move.
        if (drag.ids.includes(itemId)) {
          resolved = true
          break
        }

        const frac = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height))
        let position: 'before' | 'after' | 'inside'
        let targetId = itemId

        if (isGroup) {
          const group = state.groups.find((g) => g.id === itemId)
          const held = cur?.targetId === itemId ? cur.position : null
          const fromInside =
            !!group && !drag.isGroup && drag.ids.every((id) => group.sessionIds.includes(id))
          if (group && !group.collapsed && fromInside) {
            // The row already lives here, so "into the group" means nothing —
            // and its old reading, append at the END, was the trap: dragging
            // the last row up past the first one hit the header and sent it
            // straight back to the bottom. From inside, the header IS the
            // first position. (Leaving the group upward is the item above's
            // bottom half.)
            const first = group.sessionIds.find((sid) => !drag.ids.includes(sid))
            // The only row of its group: the header means "stay", exactly
            // like hovering the row itself.
            if (first) newIndicator = { targetId: first, position: 'before' }
            resolved = true
            break
          }
          if (group && !group.collapsed) {
            // Expanded: a generous top edge = before the group, the rest =
            // into the group (appended). A dragged group can never nest.
            const lo = held === 'before' ? 'lo' : held === 'inside' ? 'hi' : null
            position = side(frac, 0.35, lo) === 'lo' ? 'before' : 'inside'
          } else {
            // Collapsed: before / inside / after, held with the same margin.
            if (held === 'before')
              position = frac > 0.3 + ZONE_BAND ? (frac > 0.7 ? 'after' : 'inside') : 'before'
            else if (held === 'after')
              position = frac < 0.7 - ZONE_BAND ? (frac < 0.3 ? 'before' : 'inside') : 'after'
            else if (held === 'inside')
              position =
                frac < 0.3 - ZONE_BAND ? 'before' : frac > 0.7 + ZONE_BAND ? 'after' : 'inside'
            else position = frac < 0.3 ? 'before' : frac > 0.7 ? 'after' : 'inside'
          }
          if (position === 'inside' && drag.isGroup) position = frac < 0.5 ? 'before' : 'after'
        } else {
          const held =
            cur?.targetId === itemId
              ? cur.position === 'before'
                ? 'lo'
                : cur.position === 'after'
                  ? 'hi'
                  : null
              : null
          position = side(frac, 0.5, held) === 'lo' ? 'before' : 'after'
          if (drag.isGroup) {
            // A group dropped on a row inside another group lands beside that
            // group, never within it.
            const parent = groupOf(itemId)
            if (parent) {
              targetId = parent.id
              position =
                parent.sessionIds[0] === itemId && position === 'before' ? 'before' : 'after'
            }
          }
        }

        newIndicator = { targetId, position }
        resolved = true
        break
      }

      // The strip at the foot of an expanded group: the last position of that
      // group.
      if (!resolved) {
        const zones = [
          ...container.querySelectorAll<HTMLElement>('[data-sidebar-drop-zone="group-end"]')
        ].filter(visible)
        for (const zoneEl of zones) {
          const rect = zoneEl.getBoundingClientRect()
          if (clientX < rect.left || clientX > rect.right) continue
          if (clientY < rect.top || clientY > rect.bottom) continue
          const group = state.groups.find((g) => g.id === zoneEl.dataset.groupId)
          if (!group) break
          resolved = true
          if (drag.isGroup) {
            newIndicator = { targetId: group.id, position: 'after' }
            break
          }
          // An EMPTY group's zone is its "No sessions" row: a row dropped there
          // joins the group (its first member). Otherwise the last row not
          // being dragged; with none (the dragged row is the only one) the
          // strip means "stay".
          if (group.sessionIds.length === 0) {
            newIndicator = { targetId: group.id, position: 'inside' }
            break
          }
          const anchor = [...group.sessionIds].reverse().find((sid) => !drag.ids.includes(sid))
          if (anchor) newIndicator = { targetId: anchor, position: 'after' }
          break
        }
      }

      // Nothing hit: the container's edges and the space between cards.
      if (!resolved) {
        const containerRect = container.getBoundingClientRect()
        if (clientX >= containerRect.left && clientX <= containerRect.right) {
          const first = items[0].getBoundingClientRect()
          const lastItem = items[items.length - 1]
          const last = lastItem.getBoundingClientRect()

          // Between two rows or two cards, or below everything: after the
          // item above. If that item is a row inside a group, this is "after
          // the row" while the cursor is still within the card (the 2px seam
          // between two rows, the card's padding) and "after the GROUP" once
          // it is outside — the seam between rows used to read as leaving.
          const resolveAfter = (itemId: string): DropIndicatorState | null => {
            if (drag.ids.includes(itemId)) {
              // Under the dragged row's own faded place: inside its card this
              // is "after the row above it" (a line, the row's own slot);
              // with no other row, or outside the card, it is "stay".
              const own = groupOf(itemId)
              const card = own ? cardRectOf(own.id) : null
              if (!own || !card || clientY < card.top || clientY > card.bottom + CARD_EXIT_BAND)
                return null
              const idx = own.sessionIds.indexOf(itemId)
              const above = own.sessionIds
                .slice(0, idx)
                .reverse()
                .find((sid) => !drag.ids.includes(sid))
              if (above) return { targetId: above, position: 'after' }
              const below = own.sessionIds.slice(idx + 1).find((sid) => !drag.ids.includes(sid))
              return below ? { targetId: below, position: 'before' } : null
            }
            const parent = groupOf(itemId)
            if (parent) {
              const card = cardRectOf(parent.id)
              // Leaving the card is a deliberate move: while the line already
              // sits at the last position INSIDE, the cursor must travel
              // CARD_EXIT_BAND past the card's bottom edge before the target
              // becomes "after the group" — a hand hovering near its own last
              // row must not see the row offered outside on a twitch.
              const holdInside = cur?.targetId === itemId && cur.position === 'after'
              const withinCard =
                !!card &&
                clientY >= card.top &&
                clientY <= card.bottom + (holdInside ? CARD_EXIT_BAND : 0)
              return withinCard
                ? { targetId: itemId, position: 'after' }
                : { targetId: parent.id, position: 'after' }
            }
            return { targetId: itemId, position: 'after' }
          }

          if (clientY < first.top) {
            const firstId = items[0].dataset.sidebarItemId!
            if (!drag.ids.includes(firstId))
              newIndicator = { targetId: firstId, position: 'before' }
          } else if (clientY > last.bottom) {
            newIndicator = resolveAfter(lastItem.dataset.sidebarItemId!)
            if (!newIndicator && items.length > 1) {
              newIndicator = resolveAfter(items[items.length - 2].dataset.sidebarItemId!)
            }
          } else {
            let closestAbove: HTMLElement | null = null
            let closestAboveBottom = -Infinity
            for (const itemEl of items) {
              const bottom = itemEl.getBoundingClientRect().bottom
              if (bottom <= clientY && bottom > closestAboveBottom) {
                closestAbove = itemEl
                closestAboveBottom = bottom
              }
            }
            if (closestAbove) newIndicator = resolveAfter(closestAbove.dataset.sidebarItemId!)
          }
        }
      }

      // Update the indicator only when it changed. The ref updates at once (a
      // drop always uses the latest); the React state that renders the gap is
      // debounced so a layout-induced oscillation cannot reach the screen.
      const changed =
        !cur && !newIndicator
          ? false
          : !cur ||
            !newIndicator ||
            cur.targetId !== newIndicator.targetId ||
            cur.position !== newIndicator.position

      if (changed) {
        drag.currentIndicator = newIndicator

        if (indicatorTimerRef.current) {
          clearTimeout(indicatorTimerRef.current)
        }
        indicatorTimerRef.current = setTimeout(() => {
          indicatorTimerRef.current = null
          setDndState((prev) => ({ ...prev, dropIndicator: newIndicator }))
        }, INDICATOR_DEBOUNCE)
      }
    },
    [containerRef]
  )

  // The trackpad tick — the same alignment haptic Finder gives — fires when
  // the LINE moves, not when the internal target changes: the target updates
  // on every pointer move while the line renders after a debounce, and two
  // targets can draw the same bar ("after X" and "before the row under X").
  // Ticking from the hit-test therefore felt out of sync. This effect runs
  // after React committed the render and reads the rendered line's identity
  // from the DOM — which bar, or which card outline — and ticks only when
  // that identity changed. Appearing counts as a move; disappearing does not.
  const lastLineKeyRef = useRef<string | null>(null)
  useEffect(() => {
    const container = containerRef.current
    if (!dndState.isDragging || !container) {
      lastLineKeyRef.current = null
      return
    }
    let key: string | null = null
    const gap = container.querySelector<HTMLElement>('.sidebar-drop-gap-active')
    if (gap) {
      const itemId =
        gap.parentElement?.querySelector<HTMLElement>('[data-sidebar-item-id]')?.dataset
          .sidebarItemId
      key = `${gap.classList.contains('sidebar-drop-gap--after') ? 'after' : 'before'}:${itemId ?? '?'}`
    } else {
      const outline = container.querySelector<HTMLElement>('.group-scope > .border-accent')
      const groupId = outline?.parentElement?.querySelector<HTMLElement>(
        '[data-sidebar-item-type="group"]'
      )?.dataset.sidebarItemId
      if (outline) key = `inside:${groupId ?? '?'}`
    }
    if (key && key !== lastLineKeyRef.current) window.electronAPI?.hapticTick?.('alignment')
    lastLineKeyRef.current = key
  }, [dndState.dropIndicator, dndState.isDragging, containerRef])

  // Auto-scroll when near container edges
  const autoScroll = useCallback(
    (clientY: number, drag: DragRef) => {
      const container = containerRef.current
      if (!container) return

      if (drag.scrollAnimFrame) {
        cancelAnimationFrame(drag.scrollAnimFrame)
        drag.scrollAnimFrame = null
      }

      const rect = container.getBoundingClientRect()
      const topDist = clientY - rect.top
      const bottomDist = rect.bottom - clientY

      let scrollDelta = 0
      if (topDist < AUTO_SCROLL_ZONE && topDist > 0) {
        scrollDelta = -AUTO_SCROLL_SPEED * (1 - topDist / AUTO_SCROLL_ZONE)
      } else if (bottomDist < AUTO_SCROLL_ZONE && bottomDist > 0) {
        scrollDelta = AUTO_SCROLL_SPEED * (1 - bottomDist / AUTO_SCROLL_ZONE)
      }

      if (scrollDelta !== 0) {
        const scroll = (): void => {
          container.scrollTop += scrollDelta
          drag.scrollAnimFrame = requestAnimationFrame(scroll)
        }
        drag.scrollAnimFrame = requestAnimationFrame(scroll)
      }
    },
    [containerRef]
  )

  // Pointer event handlers
  const handlePointerDown = useCallback(
    (e: React.PointerEvent, itemId: string, isGroup: boolean) => {
      // Only left button, not during editing
      if (e.button !== 0) return
      if ((e.target as HTMLElement).tagName === 'INPUT') return

      // A drag carries the row under the cursor and nothing else. The
      // selection is a VIEW (which terminals tile the main pane — clicking a
      // group header selects every one of its rows), not an edit selection:
      // reading it as the drag payload meant that dragging any single row of
      // the group you were looking at emptied the whole group into the drop
      // target. Several sessions move together by grouping them (Cmd+G) and
      // dragging the group.
      dragRef.current = {
        ids: [itemId],
        isGroup,
        startX: e.clientX,
        startY: e.clientY,
        started: false,
        sourceEl: e.currentTarget as HTMLElement,
        currentIndicator: null,
        scrollAnimFrame: null,
        overlayWidth: 0,
        overPinnedZone: false
      }
    },
    []
  )

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent): void => {
      const drag = dragRef.current
      if (!drag) return

      if (!drag.started) {
        const dx = e.clientX - drag.startX
        const dy = e.clientY - drag.startY
        if (Math.sqrt(dx * dx + dy * dy) < DRAG_THRESHOLD) return

        // Start dragging
        drag.started = true
        if (drag.sourceEl) {
          createOverlay(drag.sourceEl)
          drag.overlayWidth = overlayRef.current?.getBoundingClientRect().width ?? 0
        }
        setDndState({
          isDragging: true,
          draggedIds: drag.ids,
          dropIndicator: null,
          isOverPinnedZone: false
        })

        // Prevent the click event that would fire on pointer up
        const preventClick = (evt: Event): void => {
          evt.stopPropagation()
          evt.preventDefault()
        }
        document.addEventListener('click', preventClick, { capture: true, once: true })
        // Safety: remove if not fired within 500ms (click fires async after pointerup)
        setTimeout(
          () => document.removeEventListener('click', preventClick, { capture: true }),
          500
        )
      }

      // Update overlay position (uses cached width to avoid layout thrashing)
      if (overlayRef.current) {
        overlayRef.current.style.left = `${e.clientX - drag.overlayWidth / 2}px`
        overlayRef.current.style.top = `${e.clientY - 20}px`
      }

      // Check if hovering over pinned zone (only for group drags)
      if (drag.isGroup && pinnedZoneRef?.current) {
        const pinnedRect = pinnedZoneRef.current.getBoundingClientRect()
        const over =
          e.clientX >= pinnedRect.left &&
          e.clientX <= pinnedRect.right &&
          e.clientY >= pinnedRect.top &&
          e.clientY <= pinnedRect.bottom
        if (over !== drag.overPinnedZone) {
          drag.overPinnedZone = over
          setDndState((prev) => ({ ...prev, isOverPinnedZone: over }))
        }
        if (over) {
          // Clear normal drop indicator when over pinned zone
          if (drag.currentIndicator) {
            drag.currentIndicator = null
            if (indicatorTimerRef.current) {
              clearTimeout(indicatorTimerRef.current)
              indicatorTimerRef.current = null
            }
            setDndState((prev) => ({ ...prev, dropIndicator: null }))
          }
          return // skip normal hit-test and auto-scroll
        }
      }

      // Hit test
      hitTest(e.clientX, e.clientY, drag)

      // Auto-scroll
      autoScroll(e.clientY, drag)
    }

    const handlePointerUp = (): void => {
      const drag = dragRef.current
      if (!drag) return

      if (drag.scrollAnimFrame) {
        cancelAnimationFrame(drag.scrollAnimFrame)
      }

      // Flush any pending debounced indicator so the gap is rendered for settle animation
      if (indicatorTimerRef.current) {
        clearTimeout(indicatorTimerRef.current)
        indicatorTimerRef.current = null
        if (drag.currentIndicator) {
          setDndState((prev) => ({ ...prev, dropIndicator: drag.currentIndicator }))
        }
      }

      // Handle drop on pinned zone
      if (drag.started && drag.isGroup && drag.overPinnedZone && onPinnedDrop) {
        dragRef.current = null
        onPinnedDrop(drag.ids[0])
        destroyOverlay()
        setDndState({
          isDragging: false,
          draggedIds: [],
          dropIndicator: null,
          isOverPinnedZone: false
        })
        return
      }

      if (drag.started && drag.currentIndicator) {
        const indicator = drag.currentIndicator
        const overlay = overlayRef.current

        // Find the gap element to animate toward
        const container = containerRef.current
        const gapEl = container?.querySelector<HTMLElement>('.sidebar-drop-line')
        const gapRect = gapEl?.getBoundingClientRect()

        if (overlay && gapRect && gapRect.height > 0) {
          // Animate overlay settling into the gap position
          Object.assign(overlay.style, {
            transition: `left ${SETTLE_DURATION}ms ease-out, top ${SETTLE_DURATION}ms ease-out, transform ${SETTLE_DURATION}ms ease-out, opacity ${SETTLE_DURATION}ms ease-out`,
            left: `${gapRect.left}px`,
            top: `${gapRect.top}px`,
            transform: 'scale(1)',
            opacity: '0.6'
          })

          // Commit after animation completes
          dragRef.current = null
          setTimeout(() => {
            moveItems(drag.ids, indicator.targetId, indicator.position)
            destroyOverlay()
            setDndState({
              isDragging: false,
              draggedIds: [],
              dropIndicator: null,
              isOverPinnedZone: false
            })
          }, SETTLE_DURATION)
        } else {
          // No gap visible (e.g. "inside" drop) — commit immediately
          dragRef.current = null
          moveItems(drag.ids, indicator.targetId, indicator.position)
          destroyOverlay()
          setDndState({
            isDragging: false,
            draggedIds: [],
            dropIndicator: null,
            isOverPinnedZone: false
          })
        }
      } else {
        // Drag didn't start or no valid target — just clean up
        dragRef.current = null
        destroyOverlay()
        setDndState({
          isDragging: false,
          draggedIds: [],
          dropIndicator: null,
          isOverPinnedZone: false
        })
      }
    }

    // ESC to cancel drag
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && dragRef.current?.started) {
        e.preventDefault()
        if (dragRef.current.scrollAnimFrame) {
          cancelAnimationFrame(dragRef.current.scrollAnimFrame)
        }
        if (indicatorTimerRef.current) {
          clearTimeout(indicatorTimerRef.current)
          indicatorTimerRef.current = null
        }
        dragRef.current = null
        destroyOverlay()
        setDndState({
          isDragging: false,
          draggedIds: [],
          dropIndicator: null,
          isOverPinnedZone: false
        })
      }
    }

    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('pointerup', handlePointerUp)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('pointerup', handlePointerUp)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [
    createOverlay,
    destroyOverlay,
    hitTest,
    autoScroll,
    moveItems,
    containerRef,
    pinnedZoneRef,
    onPinnedDrop
  ])

  return {
    isDragging: dndState.isDragging,
    draggedIds: dndState.draggedIds,
    dropIndicator: dndState.dropIndicator,
    isOverPinnedZone: dndState.isOverPinnedZone,
    handlePointerDown
  }
}
