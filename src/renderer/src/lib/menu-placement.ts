// The gap a menu always keeps from the window's edges.
export const MENU_EDGE_PADDING = 8

/** Where a menu of size w×h opens for a click at (x, y): below and to the
 *  right of the cursor (raised by `lift`), flipped left or up when that side
 *  has no room, then clamped so every edge stays inside the window. A menu
 *  taller than the window is pinned to the top and scrolls. */
export function placeMenu(
  x: number,
  y: number,
  w: number,
  h: number,
  lift: number,
  viewport = { width: window.innerWidth, height: window.innerHeight }
): { left: number; top: number } {
  const clamp = (v: number, max: number): number =>
    Math.max(MENU_EDGE_PADDING, Math.min(v, max - MENU_EDGE_PADDING))
  const fitsRight = x + w <= viewport.width - MENU_EDGE_PADDING
  const left = clamp(fitsRight ? x : x - w, viewport.width - w)
  const below = y - lift
  const fitsBelow = below + h <= viewport.height - MENU_EDGE_PADDING
  const top = clamp(fitsBelow ? below : y - h, viewport.height - h)
  return { left, top }
}
