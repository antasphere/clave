import { describe, expect, it } from 'vitest'
import { buildProvenanceHeader } from '../../../shared/exchange-provenance'
import type { Entry } from '../../../../plugins/chat-view/src/reducer'
import { groupEntries, visibleEntries } from '../../../../plugins/chat-view/src/tools'

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
  it('keeps agent messages, replies and commands in the same deck until a human message', () => {
    const first = delivery('Coordinator', 4)
    const second = delivery('Verifier', 5)
    expect(
      groupEntries([human, answer, first, tool, answer, second, answer, human, answer])
    ).toEqual([
      human,
      answer,
      {
        kind: 'delivery-group',
        exchanges: [
          { message: first, responses: [{ kind: 'tool-group', id: 't', tools: [tool] }, answer] },
          { message: second, responses: [answer] }
        ]
      },
      human,
      answer
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
    ).toEqual([
      {
        kind: 'delivery-group',
        exchanges: [
          { message: first, responses: [] },
          { message: anonymous, responses: [] }
        ]
      },
      quoted,
      malformed
    ])
  })
})
