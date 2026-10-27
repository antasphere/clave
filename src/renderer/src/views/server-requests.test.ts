import { describe, expect, it } from 'vitest'
import { resourceKey } from '@clave/contract/fleet'
import { emptyConversation, reduceConversation } from '../../../../plugins/chat-view/src/reducer'
import { openRequests, withServerPending } from '../../../../plugins/chat-view/src/server-requests'
import type { SessionEvent } from '../../../shared/session-model'

const session = resourceKey('session', 'server-a', 'agent')
const other = resourceKey('session', 'server-a', 'other')
const question: SessionEvent = {
  type: 'permission_request',
  id: '"question-1"',
  description: 'The agent asks',
  toolName: 'item/tool/requestUserInput',
  questions: [{ question: 'Which branch?', options: [{ label: 'dev' }, { label: 'prod' }] }],
  options: [{ id: 'answer', label: 'Answer' }]
}
const approval: SessionEvent = {
  type: 'permission_request',
  id: '"approval-1"',
  description: 'Run a command',
  toolName: 'item/commandExecution/requestApproval',
  options: [
    { id: 'accept', label: 'Accept' },
    { id: 'decline', label: 'Decline' }
  ]
}
const entries = [question, approval].reduce(
  (state, event) => reduceConversation(state, { event }),
  emptyConversation
).entries

describe('a server session reads what is open off the server', () => {
  it('docks every request the server still holds for this session, oldest first', () => {
    const pending = [
      { sessionId: session, providerRequestId: '"question-1"' },
      { sessionId: session, providerRequestId: '"approval-1"' }
    ]
    expect(openRequests(entries, pending, session).map((r) => r.id)).toEqual([
      '"question-1"',
      '"approval-1"'
    ])
  })
  it('drops a request another client settled, while the agent is still blocked on another', () => {
    // Both were raised in one turn: answering the approval elsewhere leaves the
    // kernel blocked on the question, so only the server's list can close it.
    const pending = [{ sessionId: session, providerRequestId: '"question-1"' }]
    expect(openRequests(entries, pending, session).map((r) => r.id)).toEqual(['"question-1"'])
    const approvalRow = withServerPending(entries, pending, session).find(
      (e) => e.kind === 'permission' && e.request.id === '"approval-1"'
    )
    expect(approvalRow).toMatchObject({ answeredElsewhere: true })
  })
  it('never matches another session’s request of the same provider id', () => {
    const pending = [{ sessionId: other, providerRequestId: '"question-1"' }]
    expect(openRequests(entries, pending, session)).toEqual([])
  })
  it('keeps an empty server list meaning nothing is open', () => {
    expect(openRequests(entries, [], session)).toEqual([])
  })
  it('leaves a local session’s own reading untouched', () => {
    expect(withServerPending(entries, undefined, session)).toBe(entries)
    expect(openRequests(entries, undefined, session).map((r) => r.id)).toEqual([
      '"question-1"',
      '"approval-1"'
    ])
  })
  it('keeps an answered request closed whatever the server says', () => {
    const answered = reduceConversation(
      { ...emptyConversation, entries },
      { answer: '"approval-1"', optionId: 'accept' }
    ).entries
    const pending = [
      { sessionId: session, providerRequestId: '"question-1"' },
      { sessionId: session, providerRequestId: '"approval-1"' }
    ]
    expect(openRequests(answered, pending, session).map((r) => r.id)).toEqual(['"question-1"'])
  })
  it('never reopens an older request that a restarted provider’s live one reuses the id of', () => {
    // The past holds a finished public question under id 0; the restarted
    // provider asks a private one under id 0 too, and the server holds it.
    const older: SessionEvent = {
      type: 'permission_request',
      id: '0',
      description: 'Old question',
      toolName: 'item/tool/requestUserInput',
      input: { turnId: 'old', questions: [{ id: 'q', question: 'Value?', isSecret: false }] },
      questions: [{ id: 'q', question: 'Value?', options: [] }],
      options: [{ id: 'answer', label: 'Answer' }]
    }
    const current: SessionEvent = {
      ...older,
      description: 'New question',
      input: { turnId: 'new', questions: [{ id: 'q', question: 'Value?', isSecret: true }] }
    }
    const both = [older, current].reduce(
      (state, event) => reduceConversation(state, { event }),
      emptyConversation
    ).entries
    const pending = [{ sessionId: session, providerRequestId: '0' }]
    const open = openRequests(both, pending, session)
    expect(open).toHaveLength(1)
    expect(open[0].description).toBe('New question')
    expect(withServerPending(both, pending, session)[0]).toMatchObject({ answeredElsewhere: true })
    // A local session reads it the same way: the older one is closed.
    expect(openRequests(both, undefined, session).map((r) => r.description)).toEqual([
      'New question'
    ])
  })
})
