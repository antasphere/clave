import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { POPOVER_EDGE_GAP, withEdgeGap } from './edge-gap'
import * as DropdownMenu from './dropdown-menu'
import * as ContextMenu from './context-menu'
import * as Popover from './popover'
import * as Tooltip from './tooltip'
import * as RadixDropdownMenu from '@radix-ui/react-dropdown-menu'
import * as RadixContextMenu from '@radix-ui/react-context-menu'
import * as RadixPopover from '@radix-ui/react-popover'
import * as RadixTooltip from '@radix-ui/react-tooltip'

type Padding = number | Partial<Record<'top' | 'right' | 'bottom' | 'left', number>>

/** A stand-in for a Radix content: it writes the padding it was given. */
const Probe = React.forwardRef<HTMLDivElement, { collisionPadding?: Padding }>(
  ({ collisionPadding }, ref) =>
    React.createElement('div', { ref, 'data-padding': JSON.stringify(collisionPadding) })
)
Probe.displayName = 'Probe'

const padding = (props: { collisionPadding?: Padding }): string =>
  renderToStaticMarkup(React.createElement(withEdgeGap(Probe), props))

describe('withEdgeGap', () => {
  it('keeps a surface off the window edges when the caller says nothing', () => {
    expect(padding({})).toContain(`data-padding="${POPOVER_EDGE_GAP}"`)
  })

  it('lets a caller choose its own gap', () => {
    expect(padding({ collisionPadding: 12 })).toContain('data-padding="12"')
    expect(padding({ collisionPadding: { top: 40 } })).toContain('{&quot;top&quot;:40}')
  })

  it('keeps the wrapped component name', () => {
    expect(withEdgeGap(Probe).displayName).toBe('Probe')
  })
})

describe('the primitives', () => {
  it('replace every positioned content, under both of its names', () => {
    const wrapped = [
      [DropdownMenu.Content, DropdownMenu.DropdownMenuContent, RadixDropdownMenu.Content],
      [DropdownMenu.SubContent, DropdownMenu.DropdownMenuSubContent, RadixDropdownMenu.SubContent],
      [ContextMenu.Content, ContextMenu.ContextMenuContent, RadixContextMenu.Content],
      [ContextMenu.SubContent, ContextMenu.ContextMenuSubContent, RadixContextMenu.SubContent],
      [Popover.Content, Popover.PopoverContent, RadixPopover.Content],
      [Tooltip.Content, Tooltip.TooltipContent, RadixTooltip.Content]
    ] as const
    for (const [short, long, radix] of wrapped) {
      expect(short).toBe(long)
      expect(short).not.toBe(radix)
      expect(short.displayName).toBe(radix.displayName)
    }
  })
})
