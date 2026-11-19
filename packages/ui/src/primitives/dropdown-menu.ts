// Radix's dropdown menu, its positioned contents kept off the window's edges
// (`edge-gap.ts`) and holding the window's drag areas while open
// (`window-drag.ts`). Import this module, never '@radix-ui/react-dropdown-menu'.
import * as Radix from '@radix-ui/react-dropdown-menu'
import { withEdgeGap } from './edge-gap'
import { withWindowDragHold } from './window-drag'

export * from '@radix-ui/react-dropdown-menu'
export const Content = withWindowDragHold(withEdgeGap(Radix.Content))
export const SubContent = withWindowDragHold(withEdgeGap(Radix.SubContent))
export const DropdownMenuContent = Content
export const DropdownMenuSubContent = SubContent
