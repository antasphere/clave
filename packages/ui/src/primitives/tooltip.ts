// Radix's tooltip, its content kept off the window's edges (`edge-gap.ts`).
// Import this module, never '@radix-ui/react-tooltip'.
import * as Radix from '@radix-ui/react-tooltip'
import { withEdgeGap } from './edge-gap'

export * from '@radix-ui/react-tooltip'
export const Content = withEdgeGap(Radix.Content)
export const TooltipContent = Content
