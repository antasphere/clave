import { describe, expect, it } from 'vitest'
import { buildProvenanceHeader } from '../../../shared/exchange-provenance'
import type { Entry } from '../../../../plugins/chat-view/src/reducer'
import { blockKey, groupEntries, visibleEntries } from '../../../../plugins/chat-view/src/tools'

/* Messages from other tabs stack in a deck; everything else stays in the
   transcript, in its place. On 5 November 2026 a collapsed deck hid the agent's
   explanation and the question it was asking the reader ("So I'm waiting on one
   answer from you: option 1, 2 or 3."), because the deck captured every reply
   and every tool run after a message from another tab until the reader wrote
   again. Who the agent's words are for is never read off the words, the final
   flag or the turn before them: only a message carrying the provenance header
   is another tab's, and only those stack. */

const delivery = (name: string, at: number): Extract<Entry, { kind: 'user' }> => ({
  kind: 'user',
  text: `${buildProvenanceHeader({ id: name, name })}\nPayload ${at}`,
  at,
  final: true
})
const human: Entry = { kind: 'user', text: 'My question', at: 1, final: true }
const answer: Entry = { kind: 'assistant', text: 'My answer', at: 2, final: true }
const tool: Entry = { kind: 'tool', id: 't', at: 3, complete: true }

describe('cross-session message stacks', () => {
  it("keeps the agent's words and its tools in the transcript after a message from another tab", () => {
    const first = delivery('Coordinator', 4)
    const second = delivery('Verifier', 5)
    expect(
      groupEntries([human, answer, first, tool, answer, second, answer, human, answer])
    ).toEqual([
      human,
      answer,
      { kind: 'delivery-group', messages: [first] },
      { kind: 'tool-group', id: 't', tools: [tool] },
      answer,
      { kind: 'delivery-group', messages: [second] },
      answer,
      human,
      answer
    ])
  })

  it('stacks consecutive messages from other tabs in one deck; after the agent spoke, the next one starts another', () => {
    const first = delivery('Coordinator', 4)
    const second = delivery('Verifier', 5)
    const third = delivery('Coordinator', 6)
    expect(groupEntries([first, second, answer, third])).toEqual([
      { kind: 'delivery-group', messages: [first, second] },
      answer,
      { kind: 'delivery-group', messages: [third] }
    ])
  })

  it('never reads the audience off the words or the final flag: a turn still streaming stays in the transcript', () => {
    const first = delivery('Coordinator', 4)
    const streaming: Entry = {
      kind: 'assistant',
      text: 'Reply to the coordinator. Which option, 1 or 2?',
      at: 5,
      final: false
    }
    expect(groupEntries([first, streaming])).toEqual([
      { kind: 'delivery-group', messages: [first] },
      streaming
    ])
  })

  it('keeps a tool run between two messages from other tabs on its own row, in its place', () => {
    const first = delivery('Coordinator', 4)
    const other: Entry = { kind: 'tool', id: 'u', at: 5, complete: true }
    const second = delivery('Verifier', 6)
    expect(groupEntries([first, tool, other, second])).toEqual([
      { kind: 'delivery-group', messages: [first] },
      { kind: 'tool-group', id: 't', tools: [tool, other] },
      { kind: 'delivery-group', messages: [second] }
    ])
  })

  it('keeps permission requests and errors visible outside decks', () => {
    const first = delivery('Coordinator', 4)
    const error: Entry = { kind: 'error', message: 'Disconnected', at: 5 }
    const permission: Entry = {
      kind: 'permission',
      at: 6,
      request: { type: 'permission_request', id: 'p', description: 'Allow Read?', options: [] }
    }
    const grouped = groupEntries([first, answer, error, answer, first, permission, answer, human])
    expect(grouped.map((b) => b.kind)).toEqual([
      'delivery-group',
      'assistant',
      'error',
      'assistant',
      'delivery-group',
      'permission',
      'assistant',
      'user'
    ])
  })

  it('uses the existing parser and skips withdrawn messages and empty assistant turns', () => {
    const anonymous: Entry = {
      kind: 'user',
      at: 5,
      final: true,
      text: `${buildProvenanceHeader(undefined)}\nAnonymous payload`
    }
    const quoted: Entry = { ...human, text: `I quote:\n${delivery('A', 4).text}` }
    const malformed: Entry = { ...human, text: '[Message from Clave tab "broken' }
    const first = delivery('A', 4)
    const hidden: Entry = { kind: 'assistant', text: '', final: true, at: 6 }
    expect(
      groupEntries(
        visibleEntries([first, hidden, { ...human, withdrawn: true }, anonymous, quoted, malformed])
      )
    ).toEqual([{ kind: 'delivery-group', messages: [first, anonymous] }, quoted, malformed])
  })

  it("keys a deck by its first message's ordinal, so the reader's expansion survives the deck growing", () => {
    const first = delivery('Coordinator', 4)
    const second = delivery('Verifier', 5)
    const ordinal = new Map<Entry, number>([
      [first, 10],
      [second, 11]
    ])
    const [one] = groupEntries([first])
    const [two] = groupEntries([first, second])
    expect(blockKey(one, (e) => ordinal.get(e))).toBe('deliveries-10')
    expect(blockKey(two, (e) => ordinal.get(e))).toBe('deliveries-10')
  })
})
