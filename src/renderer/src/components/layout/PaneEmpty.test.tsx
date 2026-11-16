/**
 * The main pane's empty states (PRDCT-4487): a drawing in the house hand,
 * the accent once, the words under the drawing and never inside it; the
 * title of "nothing selected" stays the one the e2e specs wait on.
 */
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PaneEmpty } from './PaneEmpty'

vi.mock('./pane-empty.css', () => ({}))

const drawing = (html: string): string =>
  html.slice(html.indexOf('<svg'), html.indexOf('</svg>') + '</svg>'.length)

describe('the empty pane', () => {
  it.each(['select', 'none'] as const)(
    '%s: one accent line, one landing, no words in the drawing',
    (kind) => {
      const svg = drawing(renderToStaticMarkup(<PaneEmpty kind={kind} />))
      expect(svg.match(/class="ln ln--c travel"/g)).toHaveLength(1)
      expect(svg.match(/class="dot dot--c"/g)).toHaveLength(1)
      expect(svg).toContain('aria-hidden="true"')
      expect(svg).not.toMatch(/<text|<tspan/)
    }
  )

  it('says what is missing under the drawing, in the words the specs wait on', () => {
    expect(renderToStaticMarkup(<PaneEmpty kind="select" />)).toMatch(
      /<\/svg><strong>Select a session<\/strong><span>Pick one in the sidebar and it opens here\.<\/span><\/div>$/
    )
    expect(
      renderToStaticMarkup(
        <PaneEmpty kind="none" action={<button type="button">New session</button>} />
      )
    ).toMatch(
      /<\/svg><strong>No active sessions<\/strong><span>Start one and it opens here\.<\/span><button type="button">New session<\/button><\/div>$/
    )
  })
})
