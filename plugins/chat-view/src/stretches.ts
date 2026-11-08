import type { Entry } from './reducer'
import { isQuestion } from './approvals'
import { isInputRequest } from './input-request'
import { blockKey, type Block } from './tools'

/* The agent's WORKING NOTES, folded into one card once the turn is over
   (PRDCT-4212). In a long turn the agent writes many short lines on the way to
   its answer, each leading into more tool calls ("Typecheck: web is clean;
   node has 8 errors. Now the attachment schema."), and every one of them sat
   in the transcript as large as the answer. What folds is decided on the
   SHAPE of the turn and never on its words: on 5 November 2026 a card that
   read who the agent's words were for hid a question meant for the reader.

   The rule, one line per kind of thing between two notes:
   - a tool run, and a permission the agent asked (allowed, refused, or left
     behind by a stop): WORK, folds;
   - a question the agent asked, a form, an error: a BOUNDARY, words to the
     reader or a failure, stays in the transcript, and the notes on each side
     fold into their own card;
   - a message from the reader or from another tab: ends the turn.
   A note is an assistant line followed by work in the same stretch. The last
   words of the turn never fold, whatever follows them: they are the answer,
   and for a turn the reader stopped they are what the agent was on. Nothing
   folds while the turn is still going. Three notes at least. */

export type AssistantEntry = Extract<Entry, { kind: 'assistant' }>
/** One step of a stretch: what the agent said, then what it did. The first
 *  step may have no note (the work the agent started on before a word). */
export interface StretchStep {
  note: AssistantEntry | null
  work: Block[]
}
export interface WorkStretch {
  kind: 'work-stretch'
  steps: StretchStep[]
}
export type Row = Block | WorkStretch
export const MIN_NOTES = 3

const startsTurn = (block: Block): boolean =>
  block.kind === 'user' || block.kind === 'delivery-group'

/** Words to the reader, or a failure: never inside a card. A permission the
 *  agent asked to use a tool is not one; a question or a form is. */
export function isBoundary(block: Block): boolean {
  if (block.kind === 'error') return true
  if (block.kind === 'permission') return isQuestion(block.request) || isInputRequest(block.request)
  return false
}

const isWork = (block: Block): boolean =>
  block.kind === 'tool-group' ||
  block.kind === 'approval-group' ||
  (block.kind === 'permission' && !isBoundary(block))

/** How many notes a stretch holds: steps that said something and then worked. */
export const noteCount = (steps: readonly StretchStep[]): number =>
  steps.filter((step) => step.note !== null && step.work.length > 0).length

/** Every tool call under a stretch. */
export function toolCount(stretch: WorkStretch): number {
  let n = 0
  for (const step of stretch.steps)
    for (const block of step.work) if (block.kind === 'tool-group') n += block.tools.length
  return n
}

/** The stretch's first and last moments, for the card's duration. */
export function stretchSpan(stretch: WorkStretch): { from: number; to: number } {
  let from = Infinity
  let to = -Infinity
  const see = (at: number): void => {
    if (at < from) from = at
    if (at > to) to = at
  }
  for (const step of stretch.steps) {
    if (step.note) see(step.note.at)
    for (const block of step.work) {
      if (block.kind === 'tool-group') for (const tool of block.tools) see(tool.at)
      else if (block.kind === 'approval-group') for (const a of block.approvals) see(a.at)
      else if ('at' in block) see(block.at)
    }
  }
  return { from: from === Infinity ? 0 : from, to: to === -Infinity ? 0 : to }
}

/** The notes' texts, in order, for the digest. */
export const stretchNotes = (stretch: WorkStretch): string[] =>
  stretch.steps.flatMap((step) => (step.note && step.work.length ? [step.note.text] : []))

/** The first block of a stretch, whose key is the stretch's. */
function firstBlock(stretch: WorkStretch): Block {
  const step = stretch.steps[0]
  return step.note ?? step.work[0]
}

/** The key a view renders a row under, stable for the row's life: a stretch
 *  by its first entry's key, so the card a reader opened stays open while a
 *  page of the past arrives in front. */
export function rowKey(row: Row, ordinal: (entry: Entry) => number | undefined): string {
  return row.kind === 'work-stretch'
    ? `stretch-${blockKey(firstBlock(row), ordinal)}`
    : blockKey(row, ordinal)
}

/** The rows of a view with its stretches folded: `blocks` as `groupEntries`
 *  built them, `lastTurnOver` the view's word on the turn in progress (the
 *  conversation is neither working nor blocked). Every turn but the last is
 *  over by construction. */
export function foldStretches(blocks: readonly Block[], lastTurnOver: boolean): Row[] {
  const turns: Block[][] = []
  for (const block of blocks) {
    if (startsTurn(block) || !turns.length) turns.push([])
    turns[turns.length - 1].push(block)
  }
  const out: Row[] = []
  turns.forEach((turn, i) => {
    const over = i < turns.length - 1 || lastTurnOver
    if (!over) {
      out.push(...turn)
      return
    }
    out.push(...foldTurn(turn))
  })
  return out
}

/** One finished turn: its stretches folded, the answer and everything after
 *  it left as they are. */
function foldTurn(turn: readonly Block[]): Row[] {
  const answer = turn.findLastIndex((block) => block.kind === 'assistant')
  const out: Row[] = []
  let segment: Block[] = []
  const flush = (): void => {
    out.push(...foldSegment(segment))
    segment = []
  }
  turn.forEach((block, i) => {
    if (i >= answer && answer >= 0) {
      // The answer and what follows it: never folded.
      if (i === answer) flush()
      out.push(block)
      return
    }
    if (startsTurn(block) || isBoundary(block)) {
      flush()
      out.push(block)
      return
    }
    segment.push(block)
  })
  flush()
  return out
}

/** A run of notes and work between two boundaries: one card when it holds
 *  MIN_NOTES notes, the blocks as they were otherwise. A note no work
 *  follows (two lines of words in a row) is words, not a note: it stays out,
 *  and the notes before and after it are counted apart. */
function foldSegment(segment: readonly Block[]): Row[] {
  const out: Row[] = []
  let steps: StretchStep[] = []
  const flush = (): void => {
    if (!steps.length) return
    if (noteCount(steps) >= MIN_NOTES) out.push({ kind: 'work-stretch', steps })
    else for (const step of steps) out.push(...(step.note ? [step.note] : []), ...step.work)
    steps = []
  }
  for (const block of segment) {
    if (block.kind === 'assistant') {
      const last = steps.at(-1)
      if (last && last.note && !last.work.length) {
        // Words with no work after them: out of the card, a break in the run.
        steps.pop()
        flush()
        out.push(last.note)
      }
      steps.push({ note: block, work: [] })
      continue
    }
    if (isWork(block)) {
      const last = steps.at(-1)
      if (last) last.work.push(block)
      else steps.push({ note: null, work: [block] })
      continue
    }
    // Anything else between two notes (nothing today reaches here): a break.
    flush()
    out.push(block)
  }
  const last = steps.at(-1)
  if (last && last.note && !last.work.length) {
    steps.pop()
    flush()
    out.push(last.note)
  } else flush()
  return out
}

/** How long the stretch took, as the reader reads it. */
export function spanLabel(from: number, to: number): string {
  const seconds = Math.max(0, Math.round((to - from) / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

/** The counts under the title: notes, tool calls, how long. */
export function countsLabel(notes: number, tools: number, span: string): string {
  const parts = [`${notes} ${notes === 1 ? 'note' : 'notes'}`]
  if (tools) parts.push(`${tools} ${tools === 1 ? 'tool call' : 'tool calls'}`)
  parts.push(span)
  return parts.join(' · ')
}
