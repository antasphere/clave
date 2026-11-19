// Radix's context menu, its positioned contents kept off the window's edges
// (`edge-gap.ts`) and holding the window's drag areas while open
// (`window-drag.ts`). Import this module, never '@radix-ui/react-context-menu'.
import * as Radix from '@radix-ui/react-context-menu'
import { withEdgeGap } from './edge-gap'
import { withWindowDragHold } from './window-drag'

export * from '@radix-ui/react-context-menu'
export const Content = withWindowDragHold(withEdgeGap(Radix.Content))
export const SubContent = withWindowDragHold(withEdgeGap(Radix.SubContent))
export const ContextMenuContent = Content
export const ContextMenuSubContent = SubContent
