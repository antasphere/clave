import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DropDrawing } from './DropDrawing'
import { NoticeCard, type NoticePlacement, type NoticeTone } from './NoticeCard'

/**
 * The notice card's showcase: every tone in both placements, as its callers
 * will use it (a drawing, a title, a sentence, actions, a dismiss). Fails if
 * a tone shows by colour alone (no icon or no word), if a placement loses
 * the dock's surface or the inline form, if an action is not a button, or
 * if the dismiss is offered without a way to make it.
 */
const TONES: NoticeTone[] = ['info', 'warning', 'error']
const WORDS: Record<NoticeTone, string> = { info: 'Note', warning: 'Warning', error: 'Error' }
const PLACEMENTS: NoticePlacement[] = ['docked', 'inline']

const showcase = (tone: NoticeTone, placement: NoticePlacement): string =>
  renderToStaticMarkup(
    createElement(NoticeCard, {
      tone,
      placement,
      drawing: createElement(DropDrawing, { kind: 'refused' }),
      eyebrow: 'Studio',
      title: `A ${tone} notice, ${placement}`,
      body: 'One sentence that says what happened. A second one that says the way on.',
      actions: [
        { label: 'Continue on Work', primary: true, onClick: () => {}, data: { 'data-x': 'a' } },
        { label: 'Continue on Codex', onClick: () => {} }
      ],
      onDismiss: () => {}
    })
  )

describe('the notice card', () => {
  for (const tone of TONES)
    for (const placement of PLACEMENTS)
      it(`${tone}, ${placement}`, () => {
        const html = showcase(tone, placement)
        expect(html).toContain(`data-tone="${tone}"`)
        expect(html).toContain(`data-placement="${placement}"`)
        // The tone reads without its colour: an icon and its word.
        expect(html).toMatch(/<p class="notice-card-eyebrow"><svg[^>]*aria-hidden="true"/)
        expect(html).toContain(`<span class="notice-card-tone">${WORDS[tone]}</span>`)
        expect(html).toContain('<span>· Studio</span>')
        // Docked, it is a card of the dock; inline, it is not.
        expect(html.includes('class="notice-card chat-prompt"')).toBe(placement === 'docked')
        expect(html).toContain(`role="${tone === 'error' ? 'alert' : 'status'}"`)
        // The actions are the app's buttons, keyboard reachable, hooks carried.
        expect(html).toMatch(
          /<button type="button" class="chat-prompt-btn" data-primary="true" data-x="a">Continue on Work<\/button>/
        )
        expect(html).toContain('>Continue on Codex</button>')
        expect(html).toContain('aria-keyshortcuts="Escape"')
        expect(html).toContain('drop-refused-drawing')
        // Nothing in it is green: no status-ready ink, no success word.
        expect(html).not.toMatch(/status-ready|success|green/i)
      })

  it('without a dismiss, offers no X; with progress, shows it in place of the actions', () => {
    const html = renderToStaticMarkup(
      createElement(NoticeCard, {
        tone: 'info',
        placement: 'inline',
        title: 'Session ended on Studio',
        progress: 'Resuming…',
        problem: 'Resume failed: the server is away.',
        actions: [{ label: 'Resume', primary: true, onClick: () => {} }]
      })
    )
    expect(html).not.toContain('notice-card-dismiss')
    expect(html).toContain('Resuming…')
    expect(html).not.toContain('>Resume</button>')
    expect(html).toContain('<p class="notice-card-problem" role="alert">Resume failed')
  })

  it('an error row: the message as the body, no title needed', () => {
    const html = renderToStaticMarkup(
      createElement(NoticeCard, { tone: 'error', placement: 'inline', body: 'The tool failed.' })
    )
    expect(html).toContain('<p class="notice-card-body">The tool failed.</p>')
    expect(html).not.toContain('aria-labelledby')
  })
})
