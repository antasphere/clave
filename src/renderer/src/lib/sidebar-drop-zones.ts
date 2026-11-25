/**
 * Where a drop over a session row of the sidebar lands (PRDCT-4997): before
 * the row, after it, or onto it (the dragged tab is nested under it). Pure,
 * so the zones and their holds are pinned by a unit test; the drag hook
 * (`hooks/use-sidebar-dnd.ts`) measures the row and asks this.
 */

/** Fraction of a row's height the cursor must travel past a zone boundary
 *  before the zone flips: a cursor resting on a boundary stays put. */
export const ZONE_BAND = 0.08

/** The top of a nestable row is "before it" down to here... */
const ONTO_TOP = 0.3
/** ...and its bottom "after it" from here; the middle means "into it", the
 *  same numbers as a collapsed group's three zones on purpose. */
const ONTO_BOTTOM = 0.7

export type RowZone = 'before' | 'onto' | 'after'

/**
 * The zone of a session row under the cursor.
 *
 * - `frac`: the cursor's place in the row, 0 at its top and 1 at its bottom;
 * - `held`: the zone this same row held on the previous move, or null;
 * - `nestable`: the dragged tab may be nested under this row;
 * - `nestOpen`: the row's own nested rows are unfolded under it, so there is
 *   no "after" zone: a line is never drawn between a parent and its rows.
 */
export function rowZone({
  frac,
  held,
  nestable,
  nestOpen
}: {
  frac: number
  held: RowZone | null
  nestable: boolean
  nestOpen: boolean
}): RowZone {
  if (!nestable) {
    // Two halves, the held one kept until the cursor is ZONE_BAND past the
    // middle. A held "onto" (the row stopped being nestable) reads as none.
    if (held === 'before') return frac > 0.5 + ZONE_BAND ? 'after' : 'before'
    if (held === 'after') return frac < 0.5 - ZONE_BAND ? 'before' : 'after'
    return frac < 0.5 ? 'before' : 'after'
  }
  if (nestOpen) {
    // Before, then onto down to the bottom: one boundary, held the same way.
    if (held === 'before') return frac > ONTO_TOP + ZONE_BAND ? 'onto' : 'before'
    if (held === 'onto' || held === 'after') return frac < ONTO_TOP - ZONE_BAND ? 'before' : 'onto'
    return frac < ONTO_TOP ? 'before' : 'onto'
  }
  if (held === 'before')
    return frac > ONTO_TOP + ZONE_BAND ? (frac > ONTO_BOTTOM ? 'after' : 'onto') : 'before'
  if (held === 'after')
    return frac < ONTO_BOTTOM - ZONE_BAND ? (frac < ONTO_TOP ? 'before' : 'onto') : 'after'
  if (held === 'onto')
    return frac < ONTO_TOP - ZONE_BAND
      ? 'before'
      : frac > ONTO_BOTTOM + ZONE_BAND
        ? 'after'
        : 'onto'
  return frac < ONTO_TOP ? 'before' : frac > ONTO_BOTTOM ? 'after' : 'onto'
}
