import { describe, expect, it, vi } from 'vitest'
import { CodexTranslator } from './codex-adapter'
import type { CodexConnection } from './codex-app-server'
import type { SessionEvent } from '../../../shared/session-model'
import { SessionHost } from '@clave/server'
import { PendingRequests } from '../../../../packages/server/src/requests/service'
import { requestAwareSessionHost } from '../request-aware-host'

// Shape from installed codex-cli 0.163.0, generated with
// codex app-server generate-json-schema --experimental --out <private-dir>.
// ToolRequestUserInputParams/Response: response keys are question IDs, not text.
const frame = {
  id: 17,
  method: 'item/tool/requestUserInput',
  params: {
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    isBlocking: true,
    questions: [
      {
        id: 'branch_id',
        header: 'Branch',
        question: 'Which branch?',
        isOther: true,
        options: [{ label: 'dev', description: 'Development branch' }]
      },
      {
        id: 'private_id',
        header: 'Private',
        question: 'Private input?',
        isSecret: true,
        options: null
      }
    ]
  }
}

describe('installed Codex native request_user_input', () => {
  it('keeps duplicate display text answerable by stable provider question IDs', async () => {
    const requests = new PendingRequests()
    let receive!: (id: string, stream: { kind: 'event'; event: SessionEvent }) => void
    const connection = { respond: vi.fn() } as unknown as CodexConnection
    const translator = new CodexTranslator((event) =>
      receive('session-1', { kind: 'event', event })
    )
    const wrapped = requestAwareSessionHost({
      host: {
        ...SessionHost.none,
        subscribe: () => () => {},
        write: async (_id, input) => {
          if (input.type === 'permission_response')
            translator.answer(input.id, input.optionId, connection, input.answers)
        }
      },
      requests,
      subscribeAll: (listener) => {
        receive = listener
        return () => {}
      }
    })
    try {
      expect(
        translator.request({
          ...frame,
          params: {
            ...frame.params,
            questions: [
              { id: 'first-id', header: 'Public', question: 'Value?', options: null },
              {
                id: 'second-id',
                header: 'Private',
                question: 'Value?',
                options: null,
                isSecret: true
              }
            ]
          }
        })
      ).toBe(true)
      const pending = requests.snapshot().pending[0]
      expect(pending.questions).toEqual([
        { id: 'first-id', header: 'Public', question: 'Value?', options: [] },
        { id: 'second-id', header: 'Private', question: 'Value?', options: [] }
      ])
      expect(pending.secretQuestions).toEqual(['second-id'])
      const late = vi.fn()
      wrapped.host.subscribe('session-1', late)
      expect(late).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({ questions: pending.questions })
        })
      )
      await expect(
        requests.resolve({
          requestId: pending.id,
          response: {
            type: 'permission',
            optionId: 'answer',
            answers: { 'Value?': 'ambiguous' }
          }
        })
      ).rejects.toMatchObject({ code: 'invalid' })
      expect(connection.respond).not.toHaveBeenCalled()
      const results = await Promise.all(
        [0, 1].map(() =>
          requests.resolve({
            requestId: pending.id,
            response: {
              type: 'permission',
              optionId: 'answer',
              answers: { 'first-id': 'public value', 'second-id': 'PRIVATE-DUPLICATE-SENTINEL' }
            }
          })
        )
      )
      expect(results.filter((r) => r.accepted)).toHaveLength(1)
      expect(connection.respond).toHaveBeenCalledExactlyOnceWith(17, {
        answers: {
          'first-id': { answers: ['public value'] },
          'second-id': { answers: ['PRIVATE-DUPLICATE-SENTINEL'] }
        }
      })
      expect(requests.snapshot().pending).toEqual([])
      expect(JSON.stringify(requests.result(pending.id, 'session-1'))).not.toContain(
        'PRIVATE-DUPLICATE-SENTINEL'
      )
    } finally {
      wrapped.close()
      requests.close()
    }
  })
  it('normalizes native questions rather than rejecting the provider request', () => {
    const events: SessionEvent[] = []
    const translator = new CodexTranslator((event) => events.push(event))
    expect(translator.request(frame)).toBe(true)
    expect(events[0]).toMatchObject({
      type: 'permission_request',
      id: '17',
      questions: [{ question: 'Which branch?' }, { question: 'Private input?' }],
      options: [{ id: 'answer' }, { id: 'deny' }]
    })
    expect(events.at(-1)).toEqual({ type: 'state_change', state: 'blocked' })
  })

  it('replays without clients and sends exactly one valid ID-keyed response without retaining private answers', async () => {
    const requests = new PendingRequests()
    let receive!: (id: string, stream: { kind: 'event'; event: SessionEvent }) => void
    const connection = { respond: vi.fn() } as unknown as CodexConnection
    const translator = new CodexTranslator((event) =>
      receive('session-1', { kind: 'event', event })
    )
    const write = vi.fn(async (_id, input) => {
      if (input.type === 'permission_response')
        translator.answer(input.id, input.optionId, connection, input.answers)
    })
    const wrapped = requestAwareSessionHost({
      host: { ...SessionHost.none, write, subscribe: () => () => {} },
      requests,
      subscribeAll: (listener) => {
        receive = listener
        return () => {}
      }
    })
    expect(translator.request(frame)).toBe(true)
    const pending = requests.snapshot().pending[0]
    expect(pending).toMatchObject({
      kind: 'clarification',
      providerRequestId: '17',
      secretQuestions: ['private_id']
    })
    const lateClient = vi.fn()
    wrapped.host.subscribe('session-1', lateClient)
    expect(lateClient).toHaveBeenCalledWith(
      expect.objectContaining({ event: expect.objectContaining({ questions: expect.any(Array) }) })
    )
    await expect(
      requests.resolve({
        requestId: pending.id,
        response: {
          type: 'permission',
          optionId: 'answer',
          answers: { branch_id: 'custom branch' }
        }
      })
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(connection.respond).not.toHaveBeenCalled()
    const sentinel = 'NATIVE-PRIVATE-ANSWER-SENTINEL'
    const results = await Promise.all(
      [0, 1].map(() =>
        requests.resolve({
          requestId: pending.id,
          response: {
            type: 'permission',
            optionId: 'answer',
            answers: { branch_id: 'custom branch', private_id: sentinel }
          }
        })
      )
    )
    expect(results.map((r) => r.accepted)).toEqual([true, false])
    expect(connection.respond).toHaveBeenCalledTimes(1)
    expect(connection.respond).toHaveBeenCalledWith(17, {
      answers: {
        branch_id: { answers: ['custom branch'] },
        private_id: { answers: [sentinel] }
      }
    })
    expect(requests.snapshot().pending).toEqual([])
    expect(JSON.stringify(requests.result(pending.id, 'session-1'))).not.toContain(sentinel)
    wrapped.close()
  })
})
