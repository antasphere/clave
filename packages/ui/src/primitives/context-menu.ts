// Radix's context menu, its positioned contents kept off the window's edges
// (`edge-gap.ts`). Import this module, never '@radix-ui/react-context-menu'.
import * as Radix from '@radix-ui/react-context-menu'
import { withEdgeGap } from './edge-gap'

export * from '@radix-ui/react-context-menu'
export const Content = withEdgeGap(Radix.Content)
export const SubContent = withEdgeGap(Radix.SubContent)
export const ContextMenuContent = Content
export const ContextMenuSubContent = SubContent
