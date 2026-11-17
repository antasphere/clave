// Radix's popover, its content kept off the window's edges (`edge-gap.ts`) and
// holding the window's drag areas while open (`window-drag.ts`).
// Import this module, never '@radix-ui/react-popover'.
import * as Radix from '@radix-ui/react-popover'
import { withEdgeGap } from './edge-gap'
import { withWindowDragHold } from './window-drag'

export * from '@radix-ui/react-popover'
export const Content = withWindowDragHold(withEdgeGap(Radix.Content))
export const PopoverContent = Content
