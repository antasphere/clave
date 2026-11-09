import { describe, expect, it } from 'vitest'
import type { Entry } from '../../../../plugins/chat-view/src/reducer'
import { groupEntries, visibleEntries } from '../../../../plugins/chat-view/src/tools'
import {
  MIN_NOTES,
  countsLabel,
  foldStretches,
  isBoundary,
  noteCount,
  plainNote,
  rowKey,
  spanLabel,
  stretchNotes,
  stretchSpan,
  toolCount,
  type Row,
  type WorkStretch
} from '../../../../plugins/chat-view/src/stretches'
import {
  cardHolding,
  occurrenceCards,
  onScreenIndex
} from '../../../../plugins/chat-view/src/search'

/* The agent's working notes fold into one card once the turn is over
   (PRDCT-4212), decided on the turn's SHAPE and never on its words. Each
   line of the rule's table is a test here:
   - a tool run, a permission the agent asked (allowed, refused, abandoned):
     work, folds;
   - a question, a form, an error: a boundary, stays out, the notes on each
     side fold apart;
   - a message from the reader or another tab ends the turn;
   - the last words of the turn never fold; nothing folds while it is going. */

let clock = 0
const tool = (id: string): Entry => ({
  kind: 'tool',
  id,
  name: 'Bash',
  input: { command: id },
  complete: true,
  at: ++clock
})
const user = (text: string, over: Partial<Extract<Entry, { kind: 'user' }>> = {}): Entry => ({
  kind: 'user',
  text,
  final: true,
  at: ++clock,
  ...over
})
const assistant = (text: string, closes?: boolean): Entry => ({
  kind: 'assistant',
  text,
  final: true,
  at: ++clock,
  ...(closes ? { closes } : {})
})
const error = (message: string): Entry => ({ kind: 'error', message, at: ++clock })
/** A permission to use a tool, answered or not. */
const approval = (id: string, answer?: string): Entry => ({
  kind: 'permission',
  request: {
    type: 'permission_request',
    id,
    description: `Edit ${id}?`,
    toolName: 'Edit',
    input: { file_path: id },
    options: [
      { id: 'allow', label: 'Allow' },
      { id: 'deny', label: 'Deny' }
    ]
  },
  at: ++clock,
  ...(answer ? { answer } : {})
})
/** A question the agent asked in words (AskUserQuestion). */
const question = (id: string, answer?: string): Entry => ({
  kind: 'permission',
  request: {
    type: 'permission_request',
    id,
    description: 'Which one?',
    options: [{ id: 'a', label: 'A' }],
    questions: [{ question: 'Which one?', options: [{ label: 'A' }] }]
  },
  at: ++clock,
  ...(answer ? { answer } : {})
})
/** A form (clave_request_input), recognised by its input's meta. */
const form = (id: string): Entry => ({
  kind: 'permission',
  request: {
    type: 'permission_request',
    id,
    description: 'Fill this in',
    input: { tool: 'clave_request_input', layout: 'form' },
    options: [{ id: 'answer', label: 'Send' }]
  },
  at: ++clock
})

/** A note and its work: the agent said something, then called tools. */
const step = (text: string, ...ids: string[]): Entry[] => [assistant(text), ...ids.map(tool)]
/** The common long turn: the reader's ask, four notes with work, the answer. */
const longTurn = (): Entry[] => [
  user('fix both errors'),
  ...step('Formatting the first fix.', 't1'),
  ...step('Typecheck: web is clean.', 't2', 't3'),
  ...step('Still tracing the composer.', 't4'),
  ...step('Write path understood.', 't5'),
  assistant('I fixed both errors.')
]

const fold = (entries: Entry[], over = true): Row[] =>
  foldStretches(groupEntries(visibleEntries(entries)), over)
const kinds = (rows: Row[]): string[] => rows.map((row) => row.kind)
const stretch = (rows: Row[], n = 0): WorkStretch => {
  const found = rows.filter((row): row is WorkStretch => row.kind === 'work-stretch')[n]
  if (!found) throw new Error(`no stretch ${n} in ${kinds(rows).join(',')}`)
  return found
}

describe('foldStretches: the shape of a finished turn', () => {
  it('folds the notes into one card and leaves the answer in the transcript', () => {
    const rows = fold(longTurn())
    expect(kinds(rows)).toEqual(['user', 'work-stretch', 'assistant'])
    const card = stretch(rows)
    expect(noteCount(card.steps)).toBe(4)
    expect(stretchNotes(card)).toEqual([
      'Formatting the first fix.',
      'Typecheck: web is clean.',
      'Still tracing the composer.',
      'Write path understood.'
    ])
    expect(toolCount(card)).toBe(5)
    const last = rows.at(-1)
    expect(last?.kind === 'assistant' && last.text).toBe('I fixed both errors.')
  })

  it('folds nothing while the turn is still going', () => {
    const rows = fold(longTurn(), false)
    expect(kinds(rows)).not.toContain('work-stretch')
    expect(rows).toHaveLength(10)
  })

  it('folds an earlier turn once a later message began a turn of its own, whatever the state', () => {
    const rows = fold([...longTurn(), user('thanks'), ...step('Looking.', 'x1')], false)
    expect(kinds(rows)).toEqual([
      'user',
      'work-stretch',
      'assistant',
      'user',
      'assistant',
      'tool-group'
    ])
  })

  it(`leaves fewer than ${MIN_NOTES} notes as they are`, () => {
    const rows = fold([user('go'), ...step('One.', 'a'), ...step('Two.', 'b'), assistant('Done.')])
    expect(kinds(rows)).toEqual([
      'user',
      'assistant',
      'tool-group',
      'assistant',
      'tool-group',
      'assistant'
    ])
  })

  it('never folds the last words of the turn, even when work follows them', () => {
    // The agent ended on a tool call: its last note is what it was on.
    const rows = fold([
      user('go'),
      ...step('One.', 'a'),
      ...step('Two.', 'b'),
      ...step('Three.', 'c'),
      ...step('Four, the last words.', 'd')
    ])
    expect(kinds(rows)).toEqual(['user', 'work-stretch', 'assistant', 'tool-group'])
    expect(noteCount(stretch(rows).steps)).toBe(3)
    const words = rows[2]
    expect(words.kind === 'assistant' && words.text).toBe('Four, the last words.')
  })

  it('a turn the reader stopped is over, and its last note stays visible', () => {
    const rows = fold(
      [
        user('go', { interrupted: true }),
        ...step('One.', 'a'),
        ...step('Two.', 'b'),
        ...step('Three.', 'c'),
        ...step('Was on this when stopped.', 'd')
      ],
      true
    )
    expect(kinds(rows)).toEqual(['user', 'work-stretch', 'assistant', 'tool-group'])
  })

  it('a message that arrived while the agent worked ends nothing: no fold until the turn is over', () => {
    const before = [
      user('go'),
      ...step('One.', 'a'),
      ...step('Two.', 'b'),
      ...step('Three.', 'c'),
      ...step('Four.', 'd'),
      user('and also this', { midTurn: true }),
      ...step('Five.', 'e'),
      ...step('Six.', 'f'),
      ...step('Seven.', 'g')
    ]
    // Still working: everything stays.
    expect(kinds(fold(before, false))).not.toContain('work-stretch')
    // The turn ended on its answer: the notes on each side of the message
    // fold apart, the words right before the message stay with it.
    const rows = fold([...before, assistant('Done.', true)], false)
    expect(kinds(rows)).toEqual([
      'user',
      'work-stretch',
      'assistant',
      'tool-group',
      'user',
      'work-stretch',
      'assistant'
    ])
    expect(stretchNotes(stretch(rows, 0))).toEqual(['One.', 'Two.', 'Three.'])
    expect(stretchNotes(stretch(rows, 1))).toEqual(['Five.', 'Six.', 'Seven.'])
  })

  it('an agent that carries on after its answer starts a new turn: the answer stays what it was', () => {
    const rows = fold(
      [
        ...longTurn().slice(0, -1),
        assistant('I fixed both errors.', true),
        // A background task reported back and the agent went on, no message.
        tool('bg'),
        ...step('Reading the task result.', 'r1'),
        ...step('One more check.', 'r2'),
        ...step('And the docs.', 'r3'),
        assistant('All green now.', true)
      ],
      true
    )
    expect(kinds(rows)).toEqual(['user', 'work-stretch', 'assistant', 'work-stretch', 'assistant'])
    const first = rows[2]
    expect(first.kind === 'assistant' && first.text).toBe('I fixed both errors.')
    expect(stretch(rows, 1).steps[0].note).toBeNull()
    expect(stretchNotes(stretch(rows, 1))).toEqual([
      'Reading the task result.',
      'One more check.',
      'And the docs.'
    ])
  })

  it('a turn that ended stays folded while the agent works again', () => {
    const rows = fold(
      [
        ...longTurn().slice(0, -1),
        assistant('I fixed both errors.', true),
        tool('bg'),
        assistant('Looking.')
      ],
      false
    )
    expect(kinds(rows)).toEqual(['user', 'work-stretch', 'assistant', 'tool-group', 'assistant'])
  })

  it('takes the work before the first note into the card as a first step', () => {
    const rows = fold([user('go'), tool('t0'), ...longTurn().slice(1)])
    const card = stretch(rows)
    expect(card.steps[0].note).toBeNull()
    expect(card.steps[0].work.map((b) => b.kind)).toEqual(['tool-group'])
    expect(noteCount(card.steps)).toBe(4)
  })

  it('two lines of words in a row are words, not a note: the run breaks there', () => {
    const rows = fold([
      user('go'),
      ...step('One.', 'a'),
      ...step('Two.', 'b'),
      ...step('Three.', 'c'),
      assistant('Here is a thought for you.'),
      ...step('Four.', 'd'),
      ...step('Five.', 'e'),
      assistant('Done.')
    ])
    expect(kinds(rows)).toEqual([
      'user',
      'work-stretch',
      'assistant',
      'assistant',
      'tool-group',
      'assistant',
      'tool-group',
      'assistant'
    ])
    const words = rows[2]
    expect(words.kind === 'assistant' && words.text).toBe('Here is a thought for you.')
  })
})

describe('foldStretches: what folds and what is a boundary', () => {
  it('a permission the agent asked folds as work: allowed, refused, or left unanswered', () => {
    for (const answer of ['allow', 'deny', undefined]) {
      const rows = fold([
        user('go'),
        ...step('One.', 'a'),
        assistant('Two.'),
        approval('p1', answer),
        tool('b'),
        ...step('Three.', 'c'),
        assistant('Done.')
      ])
      expect(kinds(rows), `answer ${answer}`).toEqual(['user', 'work-stretch', 'assistant'])
      const card = stretch(rows)
      expect(noteCount(card.steps)).toBe(3)
      // The permission sits in the second step's work, before the run it
      // was for (a permission joins a run only when a call preceded it).
      expect(card.steps[1].work.map((b) => b.kind)).toEqual(['permission', 'tool-group'])
      expect(
        card.steps[1].work[1].kind === 'tool-group' && card.steps[1].work[1].tools.map((t) => t.id)
      ).toEqual(['b'])
    }
  })

  it('a run of allowed approvals folds as work too', () => {
    const rows = fold([
      user('go'),
      ...step('One.', 'a'),
      ...step('Two.', 'b'),
      approval('p1', 'allow'),
      approval('p2', 'allow'),
      ...step('Three.', 'c'),
      assistant('Done.')
    ])
    expect(kinds(rows)).toEqual(['user', 'work-stretch', 'assistant'])
    expect(stretch(rows).steps[1].work.map((b) => b.kind)).toEqual(['tool-group', 'approval-group'])
  })

  it('a question the agent asked is a boundary: it stays, the notes on each side fold apart', () => {
    for (const answer of ['a', undefined]) {
      const rows = fold([
        user('go'),
        ...step('One.', 'a'),
        ...step('Two.', 'b'),
        ...step('Three.', 'c'),
        question('q1', answer),
        ...step('Four.', 'd'),
        ...step('Five.', 'e'),
        ...step('Six.', 'f'),
        assistant('Done.')
      ])
      expect(kinds(rows), `answer ${answer}`).toEqual([
        'user',
        'work-stretch',
        'permission',
        'work-stretch',
        'assistant'
      ])
      expect(stretchNotes(stretch(rows, 0))).toEqual(['One.', 'Two.', 'Three.'])
      expect(stretchNotes(stretch(rows, 1))).toEqual(['Four.', 'Five.', 'Six.'])
    }
  })

  it('a form is a boundary', () => {
    const rows = fold([
      user('go'),
      ...step('One.', 'a'),
      ...step('Two.', 'b'),
      ...step('Three.', 'c'),
      form('f1'),
      ...step('Four.', 'd'),
      assistant('Done.')
    ])
    expect(kinds(rows)).toEqual([
      'user',
      'work-stretch',
      'permission',
      'assistant',
      'tool-group',
      'assistant'
    ])
  })

  it('an error is a boundary', () => {
    const rows = fold([
      user('go'),
      ...step('One.', 'a'),
      ...step('Two.', 'b'),
      error('The command timed out'),
      ...step('Three.', 'c'),
      ...step('Four.', 'd'),
      ...step('Five.', 'e'),
      assistant('Done.')
    ])
    expect(kinds(rows)).toEqual([
      'user',
      'assistant',
      'tool-group',
      'assistant',
      'tool-group',
      'error',
      'work-stretch',
      'assistant'
    ])
  })

  it('a message from another tab that arrived mid-turn ends nothing either', () => {
    const header =
      '[Message from Clave tab "Verifier" — reply with clave_send_to_session sessionId="v1"]\n'
    const rows = fold(
      [
        user('go'),
        ...step('One.', 'a'),
        ...step('Two.', 'b'),
        ...step('Three.', 'c'),
        ...step('Four.', 'd'),
        user(header + 'VERIFY-ACK: starting.', { midTurn: true }),
        ...step('Five.', 'e')
      ],
      false
    )
    expect(kinds(rows)).not.toContain('work-stretch')
  })

  it('a message from another tab ends the turn like the reader’s', () => {
    const header =
      '[Message from Clave tab "Verifier" — reply with clave_send_to_session sessionId="v1"]\n'
    const rows = fold([
      ...longTurn(),
      user(header + 'VERIFY-ACK: starting.'),
      ...step('Reading the report.', 'r1'),
      ...step('Fixing.', 'r2'),
      ...step('Checking.', 'r3'),
      assistant('Fixed.')
    ])
    expect(kinds(rows)).toEqual([
      'user',
      'work-stretch',
      'assistant',
      'delivery-group',
      'work-stretch',
      'assistant'
    ])
  })

  it('isBoundary names the table’s lines', () => {
    const blocks = groupEntries([
      error('x'),
      question('q'),
      form('f'),
      approval('p', 'deny'),
      approval('p2')
    ])
    expect(blocks.map(isBoundary)).toEqual([true, true, true, false, false])
  })
})

describe('the card’s facts', () => {
  it('keys a stretch by its last entry, so the key holds while the past lengthens its turn in front', () => {
    const entries = longTurn()
    const ordinal = new Map<Entry, number>()
    entries.forEach((entry, i) => ordinal.set(entry, 100 + i))
    const rows = fold(entries)
    const card = stretch(rows)
    expect(rowKey(card, (e) => ordinal.get(e))).toBe('stretch-tools-t5')
    // A page of the past arrived in front, cutting into this turn: two more
    // notes at the card's start, every ordinal shifted. The same key.
    const earlier = [...step('Earlier note.', 'e1'), ...step('Another.', 'e2')]
    const longer = [entries[0], ...earlier, ...entries.slice(1)]
    longer.forEach((entry, i) => ordinal.set(entry, 400 + i))
    const grown = stretch(fold(longer))
    expect(noteCount(grown.steps)).toBe(6)
    expect(rowKey(grown, (e) => ordinal.get(e))).toBe('stretch-tools-t5')
    expect(rowKey(rows[0], (e) => ordinal.get(e))).toBe('entry-400')
  })

  it('reads a note plain for the face: no fence, no marks, the first line for a title', () => {
    const note =
      '```ts\nconst x = 1\n```\n\n## Quick check before I go on:\n\nShould I **drop** the `legacy` table?\n- yes\n- no'
    expect(plainNote(note, true)).toBe('Quick check before I go on:')
    expect(plainNote(note)).toBe(
      'Quick check before I go on:\nShould I drop the legacy table?\nyes\nno'
    )
    expect(plainNote('   ')).toBe('')
    expect(plainNote('See [the docs](https://x.y) and _this_, then 2*3*4 = 24.')).toBe(
      'See the docs and this, then 2*3*4 = 24.'
    )
    // The same mark opens and closes an emphasis: a mismatched pair is left.
    expect(plainNote('a *foo_ b')).toBe('a *foo_ b')
  })

  it('spans from the first note to the last tool', () => {
    clock = 1000
    const rows = fold(longTurn())
    const { from, to } = stretchSpan(stretch(rows))
    expect(from).toBe(1002)
    expect(to).toBe(1010)
  })

  it('says how long a stretch took, and nothing under a second', () => {
    expect(spanLabel(0, 400)).toBe('')
    expect(spanLabel(0, 42_000)).toBe('42 s')
    expect(spanLabel(0, 4 * 60_000)).toBe('4 min')
    expect(spanLabel(0, 90 * 60_000)).toBe('1 h 30 min')
    expect(countsLabel(4, 5, '4 min')).toBe('4 notes · 5 tool calls · 4 min')
    expect(countsLabel(1, 0, '')).toBe('1 note')
  })

  it('folds nothing with no entries', () => {
    expect(foldStretches([], true)).toEqual([])
  })
})

describe('Find over a row that holds cards', () => {
  it('says which card holds each occurrence, the reader’s own words outside every card', () => {
    const rows = fold([
      user('zebra: go'),
      ...step('zebra alpha.', 'a'),
      ...step('Two.', 'b'),
      ...step('Three.', 'c'),
      question('q1', 'a'),
      ...step('zebra beta.', 'd'),
      ...step('Five.', 'e'),
      ...step('Six.', 'f'),
      assistant('zebra gamma and zebra delta.')
    ])
    // The Terminal view's row: the whole turn.
    const row = { key: 'turn', rows: rows.map((block, i) => ({ key: String(i), block })) }
    expect(occurrenceCards(row, 'zebra')).toEqual([null, 0, 1, null, null])
    expect(cardHolding(row, 'zebra', 2)).toBe(1)
    expect(cardHolding(row, 'zebra', 4)).toBeNull()
    expect(cardHolding(row, 'zebra', 9)).toBeNull()
    // A chat view row: one block.
    expect(occurrenceCards({ key: 'x', block: rows[1] }, 'zebra')).toEqual([0])
  })

  it('places an occurrence among the words on screen, skipping cards never opened', () => {
    const where = [null, 0, 1, null, null]
    const closed = (): boolean => false
    const open = (): boolean => true
    // Both cards closed and never opened: the answer's words are the first on screen.
    expect(onScreenIndex(where, 3, closed)).toBe(1)
    expect(onScreenIndex(where, 4, closed)).toBe(2)
    // Card 1 open, card 0 never opened: its one occurrence is skipped.
    expect(onScreenIndex(where, 3, (card) => card === 1)).toBe(2)
    // Everything on screen: the data order is the screen order.
    expect(onScreenIndex(where, 4, open)).toBe(4)
    expect(onScreenIndex(where, 0, closed)).toBe(0)
  })
})
