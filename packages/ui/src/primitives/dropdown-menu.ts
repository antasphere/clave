// Radix's dropdown menu, its positioned contents kept off the window's edges
// (`edge-gap.ts`). Import this module, never '@radix-ui/react-dropdown-menu'.
import * as Radix from '@radix-ui/react-dropdown-menu'
import { withEdgeGap } from './edge-gap'

export * from '@radix-ui/react-dropdown-menu'
export const Content = withEdgeGap(Radix.Content)
export const SubContent = withEdgeGap(Radix.SubContent)
export const DropdownMenuContent = Content
export const DropdownMenuSubContent = SubContent
