/**
 * Which row of a menu the pointer means while a sibling's submenu is open
 * (PRDCT-4659).
 *
 * Radix keeps an open submenu while the pointer crosses other rows on its
 * way there: leaving the submenu's trigger arms a 300 ms triangle from the
 * exit point to the whole submenu, and every other row is ignored while the
 * pointer is inside it and last moved toward the submenu. A submenu several
 * rows tall (the launcher's Connection and Model panels) makes the triangle
 * cover the rows under its trigger, so a pointer moved onto the next model
 * and on toward the panel still landed in the first model's panel.
 *
 * The menu wrapper (`components/dropdown-menu.tsx`) adds two rules on top:
 * a row the pointer moves onto takes over at once unless the pointer is
 * heading into the open submenu, and a row the pointer stays on for
 * `AIM_REST_MS` takes over whatever its heading. Crossing a row on the way
 * to a lower entry of the open submenu takes a few frames, so it keeps the
 * submenu it was heading for.
 */

export interface AimPoint {
  x: number
  y: number
}

export interface AimRect {
  top: number
  bottom: number
  left: number
  right: number
}

/** The side of its menu a submenu opens on, Radix's `data-side`. */
export type AimSide = 'left' | 'right'

/** How long a row the pointer stays on waits before taking over from a
 *  sibling's open submenu the pointer was heading into: Radix's own delay
 *  before it opens a submenu on hover, and longer than crossing a row on the
 *  way to a lower entry of the open one. */
export const AIM_REST_MS = 100

/** How many pointer samples the heading is read across. A single move is a
 *  pixel or two, too few to say where the pointer is going. */
export const AIM_TRAIL = 4

/**
 * Whether a pointer moving from `from` to `to` is heading into the submenu
 * `rect` that opens on `side` of its menu: moving toward that side, along a
 * line that meets the submenu's near edge between its top and its bottom.
 * A pointer already level with the submenu heads into it while it is
 * within the submenu's height.
 */
export function headsInto(from: AimPoint, to: AimPoint, rect: AimRect, side: AimSide): boolean {
  const dx = to.x - from.x
  if (side === 'right' ? dx <= 0 : dx >= 0) return false
  const edge = side === 'right' ? rect.left : rect.right
  const ahead = edge - to.x
  if (side === 'right' ? ahead <= 0 : ahead >= 0) return to.y >= rect.top && to.y <= rect.bottom
  const y = to.y + ((to.y - from.y) / dx) * ahead
  return y >= rect.top && y <= rect.bottom
}

/** Records a pointer position over one menu surface, keeping the last
 *  `AIM_TRAIL`. */
export function recordAim(trail: AimPoint[], point: AimPoint): void {
  trail.push(point)
  if (trail.length > AIM_TRAIL) trail.splice(0, trail.length - AIM_TRAIL)
}

/**
 * What a move onto a row decides while a sibling's submenu is open: `take`,
 * the row takes over now; `wait`, the pointer is on its way into the open
 * submenu, which stays, and the row takes over only if the pointer is still
 * on it `AIM_REST_MS` later. `trail` is the pointer's last positions over the
 * row's menu, the oldest first; `open` is the open submenu's box and side, or
 * null when it has none to aim at.
 */
export function aimVerdict(
  trail: readonly AimPoint[],
  to: AimPoint,
  open: { rect: AimRect; side: AimSide } | null
): 'take' | 'wait' {
  const from = trail[0]
  if (!open || !from) return 'take'
  return headsInto(from, to, open.rect, open.side) ? 'wait' : 'take'
}
