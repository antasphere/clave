import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { StatusCard as Status } from '../../../src/shared/status-card'
import { StatusCard } from './StatusCard'
import { currentCard } from './status-current'
import type { Entry } from './reducer'

/**
 * The status card (PRDCT-5166) as the three views draw it. Fails if a field
 * the agent left out shows an empty label, if its inline code shows its
 * backticks or a link becomes a link, if the accent lands anywhere but on
 * what the person must do (or anywhere on a card that asks nothing, or on
 * one already answered), or if the card grows a button.
 */
const ASKS: Status = {
  doing: 'Moving the **export** to `main`',
  where: 'The writer is done; see [the notes](https://example.com) for the rest.',
  decide: ['Keep the old format?', 'Ship *today*?'],
  next: 'Answer the two questions'
}
const draw = (card: Status, past = false): string =>
  renderToStaticMarkup(createElement(StatusCard, { card, past }))

describe('the status card', () => {
  it('draws the four fields, their inline markdown and the accent on the next step', () => {
    const html = draw(ASKS)
    expect(html).toContain('data-testid="status-card"')
    expect(html).toContain('data-needs-you="true"')
    expect(html).not.toContain('data-past')
    expect(html).toContain('<strong>export</strong>')
    expect(html).toContain('<code>main</code>')
    expect(html).not.toContain('`')
    expect(html).toContain('<em>today</em>')
    // A link is its words, never a link.
    expect(html).not.toContain('<a')
    expect(html).toContain('the notes')
    expect(html).toContain('>To decide</p>')
    expect(html.match(/<li/g)).toHaveLength(2)
    expect(html.match(/data-accent/g)).toHaveLength(1)
    expect(html).toMatch(/<span class="status-card-label" data-accent="true">Next<\/span>/)
    expect(html).not.toContain('<button')
  })

  it('reads "Nothing needed from you" with no accent when nothing is owed', () => {
    const html = draw({ doing: null, where: 'All merged.', decide: [], next: null })
    expect(html).toContain('data-needs-you="false"')
    expect(html).toContain('Nothing needed from you')
    expect(html).not.toContain('data-accent')
    // Left out, simply not there: no empty label for the head or the list.
    expect(html).not.toContain('status-card-doing')
    expect(html).not.toContain('To decide')
  })

  it('puts the accent on the decisions when they are all that is asked', () => {
    const html = draw({ doing: null, where: null, decide: ['Which one?'], next: null })
    expect(html).toMatch(/<p class="status-card-label" data-accent="true">To decide<\/p>/)
    expect(html).not.toContain('Nothing needed from you')
    expect(html).not.toContain('>Next<')
  })

  it('draws an answered status whole, quieter, with no accent', () => {
    const html = draw(ASKS, true)
    expect(html).toContain('data-past="true"')
    expect(html).not.toContain('data-accent')
    expect(html).toContain('Answer the two questions')
    expect(html.match(/<li/g)).toHaveLength(2)
  })
})

describe('which card is current', () => {
  const card: Status = { doing: 'x', where: null, decide: [], next: null }
  const user = (text: string, withdrawn = false): Entry => ({
    kind: 'user',
    text,
    final: true,
    at: 1,
    ...(withdrawn ? { withdrawn } : {})
  })
  const answer = (text: string, withCard = false): Entry => ({
    kind: 'assistant',
    text,
    final: true,
    at: 1,
    ...(withCard ? { card } : {})
  })
  it('is the last answer, while the person has not written since', () => {
    const first = answer('one', true)
    const last = answer('', true)
    expect(currentCard([user('a'), first, user('b'), last])).toBe(last)
    expect(currentCard([user('a'), first, user('b')])).toBeNull()
    // A message taken back is not a message.
    expect(currentCard([user('a'), first, user('b', true)])).toBe(first)
    // A later answer without a card makes the earlier one history.
    expect(currentCard([user('a'), first, answer('more')])).toBeNull()
    // An empty frame is not an answer.
    expect(currentCard([user('a'), first, answer('')])).toBe(first)
  })
})
