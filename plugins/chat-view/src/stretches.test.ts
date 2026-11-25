import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '../../../src/shared/session-model'
import { emptyConversation, reduceConversation } from './reducer'
import { foldStretches, stretchNotes, type Row, type WorkStretch } from './stretches'
import { groupEntries, visibleEntries } from './tools'

/* The fold of the working notes over a turn that ended on a status card
   (PRDCT-5166): the notes it folds read clean, and the turn's last message
   stays out of the fold even when it is a card with no words. Reduced from
   the stream, as the views reduce it. */
const BLOCK = '```clave-status\ndoing: the fix\nwhere: both errors fixed\nnext: nothing\n```'
const step = (text: string, id: string): SessionEvent[] => [
  { type: 'assistant_text', delta: text, final: true },
  { type: 'tool_call', id, name: 'Bash', input: { command: id } },
  { type: 'tool_result', id, output: 'ok' }
]
const fold = (last: string): Row[] => {
  const events: SessionEvent[] = [
    { type: 'user_message', text: 'fix both errors' },
    { type: 'state_change', state: 'working' },
    ...step('Formatting the first fix.', 't1'),
    ...step('Typecheck: web is clean.', 't2'),
    ...step('Still tracing the composer.', 't3'),
    ...step('Write path understood.', 't4'),
    { type: 'assistant_text', delta: last, final: true },
    { type: 'state_change', state: 'idle' }
  ]
  const { entries } = events.reduce(
    (state, event) => reduceConversation(state, { event, at: 1 }),
    emptyConversation
  )
  return foldStretches(groupEntries(visibleEntries(entries)), true)
}

describe('the fold of a turn that ended on a status card', () => {
  it('keeps a card alone out of the fold, as the turn last message', () => {
    const rows = fold(BLOCK)
    expect(rows.map((row) => row.kind)).toEqual(['user', 'work-stretch', 'assistant'])
    const last = rows.at(-1)
    expect(last?.kind === 'assistant' && last.text).toBe('')
    expect(last?.kind === 'assistant' && last.card?.where).toBe('both errors fixed')
    expect(last?.kind === 'assistant' && last.closes).toBe(true)
    const card = rows[1] as WorkStretch
    expect(stretchNotes(card)).toHaveLength(4)
  })
  it('keeps the words and the card of the last message together, out of the fold', () => {
    const rows = fold(`I fixed both errors.\n\n${BLOCK}`)
    expect(rows.map((row) => row.kind)).toEqual(['user', 'work-stretch', 'assistant'])
    const last = rows.at(-1)
    expect(last?.kind === 'assistant' && last.text).toBe('I fixed both errors.')
    for (const note of stretchNotes(rows[1] as WorkStretch)) expect(note).not.toContain('```')
  })
})
