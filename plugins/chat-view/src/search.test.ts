import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { StatusCard } from './StatusCard'
import { findMatches, occurrenceCards, rowTexts } from './search'
import { emptyConversation, reduceConversation } from './reducer'

/**
 * The Find over an answer that ended on a status card (PRDCT-5166): the
 * block is not in the answer's text, the card's fields are found, and they
 * are counted in the order the card draws them, so the count and the marks
 * on screen agree.
 */
const BLOCK =
  '```clave-status\ndoing: the parser\nwhere: the parser is done\ndecide: rename the parser?\nnext: nothing\n```'
const [answer] = reduceConversation(emptyConversation, {
  event: { type: 'assistant_text', delta: `The parser works.\n\n${BLOCK}`, final: true },
  at: 1
}).entries

describe('the Find over a status card', () => {
  it('reads the words, then the fields in the order the card draws them', () => {
    expect(rowTexts(answer)).toEqual([
      'The parser works.',
      'the parser',
      'the parser is done',
      'rename the parser?'
    ])
    expect(findMatches([{ key: 'r', block: answer } as { key: string }], 'parser')).toHaveLength(4)
    expect(findMatches([{ key: 'r', block: answer } as { key: string }], 'clave-status')).toEqual(
      []
    )
    expect(occurrenceCards(answer, 'parser')).toEqual([null, null, null, null])
  })
  it('counts on the card what the card shows in its searched fields', () => {
    if (answer.kind !== 'assistant' || !answer.card) throw new Error('no card')
    const html = renderToStaticMarkup(createElement(StatusCard, { card: answer.card }))
    const fields = [...html.matchAll(/class="[^"]*status-card-field[^"]*">(.*?)<\/(?:p|li|span)>/g)]
    expect(fields.map((m) => m[1])).toEqual(rowTexts(answer).slice(1))
  })
})
