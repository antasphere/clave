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
  it('folds consecutive deliveries, including a lone delivery, without losing entry identity', () => {
    const first = delivery('Coordinator', 4)
    const second = delivery('Verifier', 5)
    const last = delivery('Coordinator', 6)
    expect(groupEntries([human, first, second, answer, last])).toEqual([
      human,
      { kind: 'delivery-group', entries: [first, second] },
      answer,
      { kind: 'delivery-group', entries: [last] }
    ])
  })

  it('keeps tools, errors, permissions and visible prose in timeline order', () => {
    const first = delivery('Coordinator', 4)
    const error: Entry = { kind: 'error', message: 'Disconnected', at: 5 }
    const permission: Entry = {
      kind: 'permission',
      at: 6,
      request: { type: 'permission_request', id: 'p', description: 'Allow Read?', options: [] }
    }
    const entries = [first, tool, first, error, first, permission, first, human, first, answer]
    const grouped = groupEntries(entries)
    expect(grouped.map((b) => b.kind)).toEqual([
      'delivery-group',
      'tool-group',
      'delivery-group',
      'error',
      'delivery-group',
      'permission',
      'delivery-group',
      'user',
      'delivery-group',
      'assistant'
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
    ).toEqual([{ kind: 'delivery-group', entries: [first, anonymous] }, quoted, malformed])
  })
})
