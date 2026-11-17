import * as React from 'react'

/** The mark of an open menu or popover, read by `system.css`: while one is on
 *  the page, the window's drag areas (`.window-drag`) stop moving the window.
 *  macOS takes a press on a drag area for itself and never hands it to the
 *  page, so a surface that closes on a press outside it never heard a press on
 *  the title bar and stayed open (PRDCT-4667). With the areas off, the first
 *  press closes the menu and the next one moves the window, as a native menu
 *  does. A hand-rolled popover spreads it on its surface; a dialog and a
 *  tooltip never carry it, so the window still moves under them. */
export const HOLDS_WINDOW_DRAG = { 'data-holds-window-drag': '' } as const

/** A Radix positioned content (`Content`, `SubContent`) that carries
 *  `HOLDS_WINDOW_DRAG`. Radix renders its content only while it is open, so
 *  the mark is on the page exactly as long as the surface is. The returned
 *  component keeps the wrapped one's exact type. */
export function withWindowDragHold<C extends React.ForwardRefExoticComponent<never>>(
  Content: C
): C {
  const Held = React.forwardRef<unknown, object>((props, ref) =>
    React.createElement(Content as unknown as React.ElementType, {
      ...HOLDS_WINDOW_DRAG,
      ...props,
      ref
    })
  )
  Held.displayName = Content.displayName
  return Held as unknown as C
}
