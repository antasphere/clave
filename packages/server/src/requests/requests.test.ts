import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { startEmbedded, type EmbeddedServer } from '../embedded'
import { createApiClient, type ClaveApiClient } from '../../../client/src/api'
import { PushClient, type PushSocketConstructor } from '../../../client/src/push-client'
import { PendingRequests } from './service'
import { SessionHost } from '../sessions/port'
import type { Session, SessionStream } from '../../../contract/src/sessions'
import { requestAwareSessionHost } from '../../../../src/main/sessions/request-aware-host'
import { CodexTranslator } from '../../../../src/main/sessions/adapters/codex-adapter'
import type { CodexConnection } from '../../../../src/main/sessions/adapters/codex-app-server'

const closes: Array<() => Promise<unknown> | void> = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
})
async function owner(): Promise<{
  requests: PendingRequests
  server: EmbeddedServer
  api: ClaveApiClient
}> {
  const requests = new PendingRequests()
  const server = await startEmbedded({ ports: { requests } })
  closes.push(() => server.stop())
  const api = createApiClient({ url: server.url, token: server.token })
  closes.push(() => api.dispose())
  return { requests, server, api }
}
function push(server: EmbeddedServer): PushClient {
  const client = new PushClient({
    url: server.url,
    token: server.token,
    WebSocket: WebSocket as unknown as PushSocketConstructor
  }).connect()
  closes.push(() => client.close())
  return client
}

describe('shared requests over authenticated HTTP and push', () => {
  it.each(['/sessions/write', '/requests/resolve'])(
    'settles exact transport-boundary and ordinary canonical keys once on %s',
    async (route) => {
      const requests = new PendingRequests()
      const respond = vi.fn()
      let emit!: (id: string, stream: SessionStream) => void
      const translator = new CodexTranslator((event) => emit('s', { kind: 'event', event }))
      const wrapped = requestAwareSessionHost({
        host: {
          ...SessionHost.none,
          get: () => ({
            id: 's',
            cwd: '/tmp',
            windowKey: 'server',
            createdAt: 1,
            provider: 'codex',
            adapterId: 'codex-chat',
            transport: 'events',
            state: 'blocked',
            title: 'Question'
          }),
          write: async (_id, input) => {
            if (input.type === 'permission_response')
              translator.answer(
                input.id,
                input.optionId,
                { respond } as unknown as CodexConnection,
                input.answers
              )
          }
        },
        requests,
        subscribeAll: (listener) => {
          emit = listener
          return () => {}
        }
      })
      closes.push(() => {
        wrapped.close()
        requests.close()
      })
      const server = await startEmbedded({ ports: { requests, sessions: wrapped.host } })
      closes.push(() => server.stop())
      for (const [i, key] of ['constructor', 'toString', 'x'.repeat(16_384)].entries()) {
        expect(
          translator.request({
            id: i,
            method: 'item/tool/requestUserInput',
            params: {
              threadId: 'thread',
              turnId: 'turn',
              itemId: 'item',
              isBlocking: true,
              questions: [{ id: key, question: 'Value?', header: 'Public', options: null }]
            }
          })
        ).toBe(true)
        const pending = requests.snapshot().pending[0]
        expect(pending.questions?.[0].id === key).toBe(true)
        const body =
          route === '/sessions/write'
            ? {
                id: 's',
                input: {
                  type: 'permission_response',
                  id: JSON.stringify(i),
                  optionId: 'answer',
                  answers: Object.fromEntries([[key, 'value']])
                }
              }
            : {
                requestId: pending.id,
                response: {
                  type: 'permission',
                  optionId: 'answer',
                  answers: Object.fromEntries([[key, 'value']])
                }
              }
        const result = await fetch(server.url + route, {
          method: 'POST',
          headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body)
        })
        // A write answers its status since the mobile wave (lane B): 200, not 204.
        expect(result.status).toBe(200)
        expect(requests.snapshot().pending).toEqual([])
        expect(respond).toHaveBeenLastCalledWith(i, {
          answers: Object.fromEntries([[key, { answers: ['value'] }]])
        })
        expect(respond).toHaveBeenCalledTimes(i + 1)
      }
    }
  )

  it.each(['/sessions/write', '/requests/resolve'])(
    'rejects malformed private answers on %s without disclosing values or question keys',
    async (route) => {
      const requests = new PendingRequests()
      const write = vi.fn(async () => {})
      const session: Session = {
        id: 'private-session',
        cwd: '/tmp',
        windowKey: 'server',
        createdAt: 1,
        provider: 'codex',
        adapterId: 'codex-chat',
        transport: 'events',
        state: 'blocked',
        title: 'Private question'
      }
      let emit!: (id: string, stream: SessionStream) => void
      const wrapped = requestAwareSessionHost({
        host: { ...SessionHost.none, get: () => session, write },
        requests,
        subscribeAll: (listener) => {
          emit = listener
          return () => {}
        }
      })
      closes.push(() => {
        wrapped.close()
        requests.close()
      })
      const key = 'PRIVATE-QUESTION-KEY-SENTINEL'
      const value = 'PRIVATE-ANSWER-VALUE-SENTINEL'
      emit(session.id, {
        kind: 'event',
        event: {
          type: 'permission_request',
          id: 'native-private',
          description: 'Private input',
          toolName: 'item/tool/requestUserInput',
          input: { questions: [{ question: key, isSecret: true }] },
          options: [{ id: 'answer', label: 'Submit' }],
          questions: [{ question: key, options: [] }]
        }
      })
      const pending = requests.snapshot().pending[0]
      const server = await startEmbedded({ ports: { requests, sessions: wrapped.host } })
      closes.push(() => server.stop())
      const api = createApiClient({ url: server.url, token: server.token })
      closes.push(() => api.dispose())
      const malformed =
        route === '/sessions/write'
          ? {
              id: session.id,
              input: {
                type: 'permission_response',
                id: 'native-private',
                optionId: 'answer',
                answers: { [key]: { value } }
              }
            }
          : {
              requestId: pending.id,
              response: { type: 'permission', optionId: 'answer', answers: { [key]: { value } } }
            }
      const response = await fetch(server.url + route, {
        method: 'POST',
        headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(malformed)
      })
      expect(response.status).toBe(400)
      const text = await response.text()
      expect(JSON.parse(text)).toMatchObject({ error: 'ValidationFailed' })
      expect(text).not.toContain(value)
      expect(text).not.toContain(key)
      expect((await api.requests.list()).pending).toHaveLength(1)
      expect(write).not.toHaveBeenCalled()
      if (route === '/sessions/write')
        await api.sessions.write(session.id, {
          type: 'permission_response',
          id: 'native-private',
          optionId: 'answer',
          answers: { [key]: value }
        })
      else
        expect(
          await api.requests.resolve({
            requestId: pending.id,
            response: { type: 'permission', optionId: 'answer', answers: { [key]: value } }
          })
        ).toEqual({ accepted: true })
      expect(write).toHaveBeenCalledOnce()
      expect((await api.requests.list()).pending).toEqual([])
      expect(JSON.stringify(requests.result(pending.id, session.id))).not.toContain(value)
    }
  )
  it('lets an accepted secret action outlive the ordinary client deadline', async () => {
    const { requests, server } = await owner()
    const patient = createApiClient({
      url: server.url,
      token: server.token,
      timeoutMs: 20,
      patientTimeoutMs: 1000
    })
    closes.push(() => patient.dispose())
    const action = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    const request = requests.create(
      {
        sessionId: 's',
        kind: 'secret',
        description: 'Run reviewed action',
        action: { type: 'run', command: 'use "$SECRET"', cwd: '/tmp', envVar: 'SECRET' }
      },
      action
    )
    expect(
      await patient.requests.resolve({
        requestId: request.id,
        response: { type: 'secret', value: 'isolated-test-value' }
      })
    ).toEqual({ accepted: true })
    expect(action).toHaveBeenCalledOnce()
    expect(requests.result(request.id, 's').status).toBe('completed')
  })
  it('replays without clients, settles once on both clients, and catches up after reconnect', async () => {
    const { requests, server, api } = await owner()
    const answer = vi.fn(async () => {})
    const request = requests.create(
      {
        sessionId: 'same-id',
        kind: 'permission',
        description: 'Allow?',
        options: [{ id: 'approve', label: 'Approve' }]
      },
      answer
    )
    const a = push(server)
    const b = push(server)
    const snapshotsA: unknown[] = []
    const snapshotsB: unknown[] = []
    const errors: unknown[] = []
    closes.push(
      api.requests.watch(
        a,
        (s) => snapshotsA.push(s),
        (e) => errors.push(e)
      )
    )
    closes.push(
      api.requests.watch(
        b,
        (s) => snapshotsB.push(s),
        (e) => errors.push(e)
      )
    )
    await vi.waitFor(() => {
      expect(snapshotsA.at(-1)).toMatchObject({ pending: [{ id: request.id }] })
      expect(snapshotsB.at(-1)).toMatchObject({ pending: [{ id: request.id }] })
    })
    const anotherApi = createApiClient({ url: server.url, token: server.token })
    closes.push(() => anotherApi.dispose())
    const responses = await Promise.all(
      [api, anotherApi].map((owner) =>
        owner.requests.resolve({
          requestId: request.id,
          response: { type: 'permission', optionId: 'approve' }
        })
      )
    )
    expect(responses.filter((r) => r.accepted)).toHaveLength(1)
    expect(answer).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => {
      expect(snapshotsA.at(-1)).toMatchObject({ pending: [] })
      expect(snapshotsB.at(-1)).toMatchObject({ pending: [] })
    })
    a.close()
    b.close()
    const later = requests.create({
      sessionId: 'same-id',
      kind: 'clarification',
      description: 'Which?',
      questions: [{ question: 'Branch?', options: [] }]
    })
    const reconnected = push(server)
    const snapshot = vi.fn()
    closes.push(api.requests.watch(reconnected, snapshot, (e) => errors.push(e)))
    await vi.waitFor(() =>
      expect(snapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          pending: [expect.objectContaining({ id: later.id })]
        })
      )
    )
    expect(errors).toEqual([])
  }, 15_000)

  it('isolates owners and rejects a wrong bearer, invalid answers and missing capabilities', async () => {
    const first = await owner()
    const second = await owner()
    const request = first.requests.create({
      sessionId: 'same-id',
      kind: 'permission',
      description: 'Allow?',
      options: [{ id: 'yes', label: 'Yes' }]
    })
    expect((await second.api.requests.list()).pending).toEqual([])
    await expect(
      second.api.requests.resolve({
        requestId: request.id,
        response: { type: 'permission', optionId: 'yes' }
      })
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      first.api.requests.resolve({
        requestId: request.id,
        response: { type: 'permission', optionId: 'invalid' }
      })
    ).rejects.toMatchObject({ code: 'invalid' })
    expect((await first.api.requests.list()).pending).toHaveLength(1)
    const response = await fetch(`${first.server.url}/requests/pending`, {
      headers: { authorization: `Bearer ${second.server.token}` }
    })
    expect(response.status).toBe(401)
    const empty = await startEmbedded({ ports: {} })
    closes.push(() => empty.stop())
    const api = createApiClient({ url: empty.url, token: empty.token })
    closes.push(() => api.dispose())
    await expect(api.requests.list()).rejects.toMatchObject({ _tag: 'CapabilityUnavailable' })
  }, 15_000)

  it('does not expose secret values in HTTP acknowledgement or pushed settlement', async () => {
    const { requests, server, api } = await owner()
    const client = push(server)
    await client.whenOpen()
    const events: unknown[] = []
    client.onEvent((event) => events.push(event))
    const request = requests.create(
      {
        sessionId: 's',
        kind: 'secret',
        description: 'Key',
        action: { type: 'env-file', file: '/tmp/example', key: 'KEY' }
      },
      async () => {}
    )
    const secret = 'SECRET-HTTP-SENTINEL'
    const response = await api.requests.resolve({
      requestId: request.id,
      response: { type: 'secret', value: secret }
    })
    expect(response).toEqual({ accepted: true })
    await vi.waitFor(() => expect(events).toHaveLength(3))
    expect(
      JSON.stringify([
        events,
        response,
        await api.requests.list(),
        requests.result(request.id, 's')
      ])
    ).not.toContain(secret)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: { _tag: 'requests.changed', revision: 3 }
        })
      ])
    )
    const invalid = await fetch(`${server.url}/requests/resolve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: request.id, response: { type: 'unknown', value: secret } })
    })
    expect(invalid.ok).toBe(false)
    expect(await invalid.text()).not.toContain(secret)
    const oversized = await fetch(`${server.url}/requests/resolve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        requestId: request.id,
        response: { type: 'secret', value: secret.repeat(5000) }
      })
    })
    expect(oversized.status).toBe(413)
    expect(await oversized.text()).not.toContain(secret)
  })
})
