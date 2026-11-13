// Radix's popover, its content kept off the window's edges (`edge-gap.ts`).
// Import this module, never '@radix-ui/react-popover'.
import * as Radix from '@radix-ui/react-popover'
import { withEdgeGap } from './edge-gap'

export * from '@radix-ui/react-popover'
export const Content = withEdgeGap(Radix.Content)
export const PopoverContent = Content
