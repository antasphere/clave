import { describe, expect, it, vi } from 'vitest'
import { PendingRequests } from './service'

describe('pending request ownership', () => {
  it('keeps pending work indefinitely without clients and isolates snapshots', () => {
    let now = 0
    const requests = new PendingRequests({ now: () => now })
    const request = requests.create({
      sessionId: 's',
      kind: 'permission',
      description: 'Approve?',
      options: [{ id: 'yes', label: 'Yes' }]
    })
    now = 86_400_000
    const snapshot = requests.snapshot()
    expect(snapshot.pending).toEqual([request])
    ;(snapshot.pending[0] as { description: string }).description = 'changed elsewhere'
    expect(requests.snapshot().pending[0].description).toBe('Approve?')
    expect(requests.result(request.id, 's').status).toBe('pending')
  })

  it('validates before reserving and invokes an asynchronous action once', async () => {
    const requests = new PendingRequests()
    let release!: () => void
    const action = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const request = requests.create(
      {
        sessionId: 's',
        kind: 'permission',
        description: 'Approve?',
        options: [{ id: 'yes', label: 'Yes' }]
      },
      action
    )
    await expect(
      requests.resolve({
        requestId: request.id,
        response: { type: 'permission', optionId: 'invented' }
      })
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(requests.snapshot().pending).toHaveLength(1)
    const accepted = requests.resolve({
      requestId: request.id,
      response: { type: 'permission', optionId: 'yes' }
    })
    expect(requests.snapshot().pending).toEqual([])
    expect(
      await requests.resolve({
        requestId: request.id,
        response: { type: 'permission', optionId: 'yes' }
      })
    ).toEqual({ accepted: false })
    release()
    expect(await accepted).toEqual({ accepted: true })
    expect(action).toHaveBeenCalledTimes(1)
    expect(requests.result(request.id, 's').status).toBe('completed')
  })

  it('requires all question answers and scopes polling to its caller', async () => {
    const requests = new PendingRequests()
    const request = requests.create({
      sessionId: 's',
      kind: 'clarification',
      description: 'Which?',
      questions: [
        { question: 'Branch?', options: [] },
        { question: 'Mode?', options: [] }
      ]
    })
    await expect(
      requests.resolve({
        requestId: request.id,
        response: {
          type: 'clarification',
          answers: { 'Branch?': 'dev' }
        }
      })
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(() => requests.result(request.id, 'another')).toThrow()
    await requests.resolve({
      requestId: request.id,
      response: {
        type: 'clarification',
        answers: { 'Branch?': 'dev', 'Mode?': 'safe' }
      }
    })
    expect(requests.snapshot().pending).toEqual([])
    expect(requests.result(request.id, 's').response).toMatchObject({
      answers: { 'Branch?': 'dev' }
    })
  })

  it('uses stable IDs when present and text only for legacy questions without an ID', async () => {
    const requests = new PendingRequests()
    const action = vi.fn(async () => {})
    const request = requests.create(
      {
        sessionId: 's',
        kind: 'clarification',
        description: 'Choose',
        questions: [
          { id: 'stable', question: 'Value?', options: [] },
          { question: 'Legacy?', options: [] }
        ]
      },
      action
    )
    await expect(
      requests.resolve({
        requestId: request.id,
        response: {
          type: 'clarification',
          answers: {
            'Value?': 'text alias',
            'Legacy?': 'legacy value'
          }
        }
      })
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(action).not.toHaveBeenCalled()
    expect(
      await requests.resolve({
        requestId: request.id,
        response: {
          type: 'clarification',
          answers: {
            stable: 'stable value',
            'Legacy?': 'legacy value'
          }
        }
      })
    ).toEqual({ accepted: true })
    expect(action).toHaveBeenCalledOnce()
    expect(() =>
      requests.create({
        sessionId: 's',
        kind: 'clarification',
        description: 'Ambiguous keys',
        questions: [
          { id: 'collision', question: 'First?', options: [] },
          { question: 'collision', options: [] }
        ]
      })
    ).toThrow()
    requests.close()
  })

  it('never retains secret values, action output or failures in state or notifications', async () => {
    const requests = new PendingRequests()
    const notifications: unknown[] = []
    requests.subscribe((revision) => notifications.push(revision))
    const secret = 'UNIQUE-SECRET-SENTINEL'
    const run = vi.fn(async () => {
      throw new Error(secret)
    })
    const request = requests.create(
      {
        sessionId: 's',
        kind: 'secret',
        description: 'Store key',
        action: { type: 'env-file', file: '/private/.env', key: 'KEY' }
      },
      run
    )
    await expect(
      requests.resolve({ requestId: request.id, response: { type: 'secret', value: '' } })
    ).rejects.toMatchObject({ code: 'invalid' })
    await requests.resolve({ requestId: request.id, response: { type: 'secret', value: secret } })
    expect(run).toHaveBeenCalledOnce()
    expect(requests.result(request.id, 's')).toEqual({ requestId: request.id, status: 'failed' })
    expect(
      JSON.stringify([requests.snapshot(), requests.result(request.id, 's'), notifications])
    ).not.toContain(secret)
    expect(requests.snapshot().pending).toEqual([])
  })

  it('bounds capacity, expires completed results, and cancels on explicit server/session stop', async () => {
    let now = 0
    const requests = new PendingRequests({ capacity: 1, now: () => now, resultTtlMs: 10 })
    const input = {
      sessionId: 's',
      kind: 'permission' as const,
      description: 'Approve?',
      options: [{ id: 'yes', label: 'Yes' }]
    }
    const request = requests.create(input)
    expect(() => requests.create(input)).toThrow()
    requests.cancelSession('s')
    expect(requests.result(request.id, 's').status).toBe('cancelled')
    expect(
      await requests.resolve({
        requestId: request.id,
        response: { type: 'permission', optionId: 'yes' }
      })
    ).toEqual({ accepted: false })
    now = 11
    expect(requests.create(input)).toBeDefined()
    requests.close()
    expect(requests.snapshot().pending).toEqual([])
    expect(() => requests.create(input)).toThrow()
  })
})
