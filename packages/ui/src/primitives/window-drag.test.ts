import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HOLDS_WINDOW_DRAG, withWindowDragHold } from './window-drag'
import * as DropdownMenu from './dropdown-menu'
import * as ContextMenu from './context-menu'
import * as Popover from './popover'
import * as Tooltip from './tooltip'

const h = React.createElement
const MARK = 'data-holds-window-drag=""'

/** A stand-in for a Radix content: it writes every prop it was given. */
const Probe = React.forwardRef<HTMLDivElement, Record<string, unknown>>((props, ref) =>
  h('div', { ref, ...props })
)
Probe.displayName = 'Probe'

describe('withWindowDragHold', () => {
  it('marks the surface it wraps, and keeps what the caller passes', () => {
    const html = renderToStaticMarkup(h(withWindowDragHold(Probe), { id: 'menu' }))
    expect(html).toContain(MARK)
    expect(html).toContain('id="menu"')
  })

  it('keeps the wrapped component name', () => {
    expect(withWindowDragHold(Probe).displayName).toBe('Probe')
  })

  it('is the same mark a hand-rolled popover spreads', () => {
    expect(renderToStaticMarkup(h('div', HOLDS_WINDOW_DRAG))).toContain(MARK)
  })
})

// The real primitives, rendered open: every menu and popover surface carries
// the mark, so system.css switches the title areas off while it is on the
// page; a tooltip never does, so a tooltip never stops the window moving.
describe('the primitives', () => {
  it('mark an open dropdown menu and its submenu', () => {
    const html = renderToStaticMarkup(
      h(
        DropdownMenu.Root,
        { open: true },
        h(DropdownMenu.Trigger),
        h(
          DropdownMenu.Content,
          { className: 'root' },
          h(
            DropdownMenu.Sub,
            { open: true },
            h(DropdownMenu.SubTrigger, null, 'More'),
            h(DropdownMenu.SubContent, { className: 'sub' }, 'Item')
          )
        )
      )
    )
    // The mark sits on each surface itself, not only somewhere in the tree.
    const surface = (name: string): string | undefined =>
      html.match(new RegExp(`<div[^>]*class="${name}"[^>]*>`))?.[0]
    expect(surface('root')).toContain(MARK)
    expect(surface('sub')).toContain(MARK)
  })

  it('mark a context menu', () => {
    const html = renderToStaticMarkup(
      h(
        ContextMenu.Root,
        null,
        h(ContextMenu.Trigger),
        h(ContextMenu.Content, { forceMount: true }, 'Item')
      )
    )
    expect(html).toContain(MARK)
  })

  it('mark an open popover', () => {
    const html = renderToStaticMarkup(
      h(Popover.Root, { open: true }, h(Popover.Trigger), h(Popover.Content, null, 'Body'))
    )
    expect(html).toContain(MARK)
  })

  it('leave an open tooltip unmarked', () => {
    const html = renderToStaticMarkup(
      h(
        Tooltip.Provider,
        null,
        h(Tooltip.Root, { open: true }, h(Tooltip.Trigger), h(Tooltip.Content, null, 'Tip'))
      )
    )
    expect(html).toContain('Tip')
    expect(html).not.toContain(MARK)
  })
})
