import * as React from 'react'

/** The gap every floating surface keeps from the window's edges: a popover,
 *  a menu, a submenu, a tooltip. Radix positions these with a collision
 *  padding of 0 by default, so a menu that ran out of room was shifted until
 *  it lay flush against the window's edge. */
export const POPOVER_EDGE_GAP = 8

type CollisionPadding = number | Partial<Record<'top' | 'right' | 'bottom' | 'left', number>>

/** A Radix positioned content (`Content`, `SubContent`) whose collision
 *  padding defaults to `POPOVER_EDGE_GAP`; a value the caller passes wins.
 *  The returned component keeps the wrapped one's exact type. */
export function withEdgeGap<C extends React.ForwardRefExoticComponent<never>>(Content: C): C {
  const Kept = React.forwardRef<unknown, { collisionPadding?: CollisionPadding }>((props, ref) =>
    React.createElement(Content as unknown as React.ElementType, {
      ...props,
      ref,
      collisionPadding: props.collisionPadding ?? POPOVER_EDGE_GAP
    })
  )
  Kept.displayName = Content.displayName
  return Kept as unknown as C
}
