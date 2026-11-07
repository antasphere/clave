import { describe, expect, it } from 'vitest'
import { resourceKey } from '@clave/contract/fleet'
import { emptyConversation, reduceConversation } from '../../../../plugins/chat-view/src/reducer'
import { serverDock, withServerPending } from '../../../../plugins/chat-view/src/server-requests'
import type { FleetPendingRequest } from '../../../preload/fleet-types'
import type { SessionEvent } from '../../../shared/session-model'

const session = resourceKey('session', 'server-a', 'agent')
const other = resourceKey('session', 'server-a', 'other')
const record = (
  uuid: string,
  createdAt: number,
  extra: Partial<FleetPendingRequest> = {}
): FleetPendingRequest => ({
  id: resourceKey('request', 'server-a', uuid),
  sessionId: session,
  kind: 'clarification',
  description: `Question ${uuid}`,
  createdAt,
  providerRequestId: '0',
  options: [{ id: 'answer', label: 'Answer' }],
  questions: [{ id: 'value', question: 'Value?', options: [] }],
  toolName: 'item/tool/requestUserInput',
  input: { questions: [{ id: 'value', question: 'Value?', isSecret: true }] },
  ...extra
})

describe('a server session docks the server’s own records', () => {
  it('shows its native requests oldest first, each under the server’s request key', () => {
    const later = record('b', 20)
    const earlier = record('a', 10, { providerRequestId: '"approval"', kind: 'permission' })
    const dock = serverDock([later, earlier], session)
    expect(dock.map((r) => r.id)).toEqual([earlier.id, later.id])
    expect(dock[1]).toEqual({
      type: 'permission_request',
      id: later.id,
      description: 'Question b',
      options: [{ id: 'answer', label: 'Answer' }],
      questions: [{ id: 'value', question: 'Value?', options: [] }],
      toolName: 'item/tool/requestUserInput',
      input: { questions: [{ id: 'value', question: 'Value?', isSecret: true }] }
    })
  })
  it('keeps two requests under one reused provider id apart', () => {
    // A restarted Codex numbers from zero again: two records, one provider id.
    const dock = serverDock([record('a', 10), record('b', 20)], session)
    expect(new Set(dock.map((r) => r.id)).size).toBe(2)
  })
  it('leaves out other sessions’ requests and what agents asked through Clave’s tools', () => {
    const mcp = record('mcp', 5, { providerRequestId: undefined })
    const elsewhere = record('x', 6, { sessionId: other })
    expect(serverDock([mcp, elsewhere], session)).toEqual([])
    expect(serverDock(undefined, session)).toEqual([])
  })
  it('hands the dock copies, never the store’s own arrays', () => {
    const r = record('a', 10)
    const [docked] = serverDock([r], session)
    expect(docked.options).not.toBe(r.options)
    expect(docked.questions).not.toBe(r.questions)
  })
})

describe('a server session’s rows read the server’s list', () => {
  const asked: SessionEvent = {
    type: 'permission_request',
    id: '"approval-1"',
    description: 'Run a command',
    options: [{ id: 'accept', label: 'Accept' }]
  }
  const entries = reduceConversation(emptyConversation, { event: asked }).entries
  it('marks an unanswered request the server no longer holds as answered elsewhere', () => {
    expect(withServerPending(entries, [], session)[0]).toMatchObject({ answeredElsewhere: true })
    const held = [record('a', 1, { providerRequestId: '"approval-1"' })]
    expect(withServerPending(entries, held, session)[0]).toMatchObject({
      answeredElsewhere: false
    })
  })
  it('leaves a local session’s own reading untouched', () => {
    expect(withServerPending(entries, undefined, session)).toBe(entries)
  })
})
