import { describe, expect, it, vi } from 'vitest'
import { SessionHost, type SessionHostService } from '@clave/server'
import type { Session, SessionEvent, SessionStream } from '@clave/contract/sessions'
import { PendingRequests } from '../../../packages/server/src/requests/service'
import { requestAwareSessionHost } from './request-aware-host'

const session: Session = {
  id: 'same-local-id',
  cwd: '/repo',
  windowKey: 'server',
  createdAt: 1,
  title: 'Native request',
  provider: 'codex',
  adapterId: 'codex-chat',
  transport: 'events',
  state: 'blocked'
}
const permission: Extract<SessionEvent, { type: 'permission_request' }> = {
  type: 'permission_request',
  id: 'native-1',
  description: 'Run the command?',
  options: [
    { id: 'allow-once', label: 'Allow' },
    { id: 'deny', label: 'Deny' }
  ]
}
function fixture(options: { now?: () => number } = {}): {
  host: SessionHostService
  emit: (event: SessionEvent) => void
  write: ReturnType<typeof vi.fn>
  requests: PendingRequests
} {
  const listeners = new Set<(value: SessionStream) => void>()
  const all = new Set<(id: string, value: SessionStream) => void>()
  const write = vi.fn(async () => {})
  const host: SessionHostService = {
    ...SessionHost.none,
    get: () => session,
    list: () => [session],
    subscribe: (_id, listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    write
  }
  const requests = new PendingRequests(options)
  const wrapped = requestAwareSessionHost({
    host,
    requests,
    subscribeAll: (listener) => {
      all.add(listener)
      return () => {
        all.delete(listener)
      }
    }
  })
  return {
    host: wrapped.host,
    requests,
    write,
    emit: (event) => {
      for (const listener of listeners) listener({ kind: 'event', event })
      for (const listener of all) listener(session.id, { kind: 'event', event })
    }
  }
}

describe('server native requests without clients', () => {
  it('keeps masking keys aligned with legacy questions that have no normalized ID', () => {
    const f = fixture()
    f.emit({
      ...permission,
      toolName: 'item/tool/requestUserInput',
      input: { questions: [{ id: 'raw-provider-id', question: 'Legacy?', isSecret: true }] },
      questions: [{ question: 'Legacy?', options: [] }]
    })
    expect(f.requests.snapshot().pending[0].secretQuestions).toEqual(['Legacy?'])
  })
  it('cancels native requests on a done provider turn while retaining independent MCP work', async () => {
    const f = fixture()
    f.emit(permission)
    const native = f.requests.snapshot().pending[0]
    const mcp = f.requests.create({
      sessionId: session.id,
      kind: 'permission',
      description: 'Explicit MCP approval',
      options: [{ id: 'approve', label: 'Approve' }]
    })
    f.emit({ type: 'state_change', state: 'done' })
    expect(f.requests.snapshot().pending.map((r) => r.id)).toEqual([mcp.id])
    expect(f.requests.result(native.id, session.id).status).toBe('cancelled')
    const late = vi.fn()
    f.host.subscribe(session.id, late)
    expect(late).not.toHaveBeenCalled()
    // The answer reaches no provider and is refused, so the client that sent
    // it does not record it as given.
    await expect(
      f.host.write(session.id, {
        type: 'permission_response',
        id: permission.id,
        optionId: 'allow-once'
      })
    ).rejects.toMatchObject({ _tag: 'RequestRejected', code: 'closed' })
    expect(f.write).not.toHaveBeenCalled()
  })
  it('preserves structured provider decisions larger than a short identifier', async () => {
    const f = fixture()
    const optionId = JSON.stringify({
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ['bash', '-lc', 'echo reviewed-command'.repeat(30)]
      }
    })
    f.emit({ ...permission, options: [{ id: optionId, label: 'Allow this reviewed rule' }] })
    await f.host.write(session.id, { type: 'permission_response', id: permission.id, optionId })
    expect(f.write).toHaveBeenCalledWith(session.id, {
      type: 'permission_response',
      id: permission.id,
      optionId
    })
  })
  it('replays a permission to both late clients and again after disconnect', () => {
    const f = fixture()
    f.emit(permission)
    const a = vi.fn()
    const b = vi.fn()
    const off = f.host.subscribe(session.id, a)
    f.host.subscribe(session.id, b)
    expect(a).toHaveBeenCalledWith({ kind: 'event', event: permission })
    expect(b).toHaveBeenCalledWith({ kind: 'event', event: permission })
    off()
    const reconnected = vi.fn()
    f.host.subscribe(session.id, reconnected)
    expect(reconnected).toHaveBeenCalledWith({ kind: 'event', event: permission })
    expect(f.write).not.toHaveBeenCalled()
  })

  it('allows one valid legacy permission response and refuses invalid options', async () => {
    const f = fixture()
    f.emit(permission)
    await expect(
      f.host.write(session.id, {
        type: 'permission_response',
        id: permission.id,
        optionId: 'invented'
      })
    ).rejects.toThrow()
    expect(f.write).not.toHaveBeenCalled()
    // Two clients answer at once: one wins, the other is told it lost.
    const outcomes = await Promise.allSettled(
      [0, 1].map(() =>
        f.host.write(session.id, {
          type: 'permission_response',
          id: permission.id,
          optionId: 'allow-once'
        })
      )
    )
    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(outcomes.find((o) => o.status === 'rejected')).toMatchObject({
      reason: { _tag: 'RequestRejected', code: 'closed' }
    })
    expect(f.write).toHaveBeenCalledTimes(1)
  })

  it('replays native questions and validates every answer before writing once', async () => {
    const f = fixture()
    const question = {
      ...permission,
      id: 'ask-1',
      toolName: 'AskUserQuestion',
      questions: [{ question: 'Branch?', options: [{ label: 'dev' }] }],
      options: [
        { id: 'answer', label: 'Submit' },
        { id: 'deny', label: 'Skip' }
      ]
    }
    f.emit(question)
    const listener = vi.fn()
    f.host.subscribe(session.id, listener)
    expect(listener).toHaveBeenCalledWith({ kind: 'event', event: question })
    expect(f.requests.snapshot().pending[0].kind).toBe('clarification')
    await expect(
      f.host.write(session.id, {
        type: 'permission_response',
        id: 'ask-1',
        optionId: 'answer',
        answers: {}
      })
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(f.write).not.toHaveBeenCalled()
    await f.host.write(session.id, {
      type: 'permission_response',
      id: 'ask-1',
      optionId: 'answer',
      answers: { 'Branch?': 'dev' }
    })
    expect(f.write).toHaveBeenCalledWith(session.id, {
      type: 'permission_response',
      id: 'ask-1',
      optionId: 'answer',
      answers: { 'Branch?': 'dev' }
    })
    expect(f.requests.snapshot().pending).toEqual([])
  })

  it('clears cancelled native prompts without cancelling independent MCP work', () => {
    const f = fixture()
    f.emit(permission)
    const mcp = f.requests.create({
      sessionId: session.id,
      kind: 'permission',
      description: 'Explicit MCP approval',
      options: [{ id: 'approve', label: 'Approve' }]
    })
    f.emit({
      type: 'provider_event',
      provider: 'claude',
      payload: { type: 'control_cancel_request', request_id: permission.id }
    })
    expect(f.requests.snapshot().pending.map((r) => r.id)).toEqual([mcp.id])
    const listener = vi.fn()
    f.host.subscribe(session.id, listener)
    expect(listener).not.toHaveBeenCalled()
    f.emit({ type: 'state_change', state: 'ended' })
    expect(f.requests.snapshot().pending).toEqual([])
  })
  it('refuses an answer to a request the provider withdrew, in the words the view retires the card on', async () => {
    let now = 0
    const f = fixture({ now: () => now })
    f.emit(permission)
    f.emit({
      type: 'provider_event',
      provider: 'claude',
      payload: { type: 'control_cancel_request', request_id: permission.id }
    })
    const answer = (): Promise<void> =>
      f.host.write(session.id, {
        type: 'permission_response',
        id: permission.id,
        optionId: 'allow-once'
      })
    // While the cancelled record is kept, the answer meets a settled request.
    await expect(answer()).rejects.toMatchObject({
      _tag: 'RequestRejected',
      code: 'closed',
      message: 'The request was already settled.'
    })
    // Once it is pruned, ten minutes later, there is no such request at all.
    now = 600_001
    await expect(answer()).rejects.toMatchObject({
      _tag: 'RequestRejected',
      code: 'not_found',
      message: 'No such provider request.'
    })
    expect(f.write).not.toHaveBeenCalled()
    // The next request the provider raises is answered once, as ever.
    f.emit({ ...permission, id: 'native-2' })
    await f.host.write(session.id, {
      type: 'permission_response',
      id: 'native-2',
      optionId: 'allow-once'
    })
    expect(f.write).toHaveBeenCalledTimes(1)
    expect(f.write).toHaveBeenCalledWith(session.id, {
      type: 'permission_response',
      id: 'native-2',
      optionId: 'allow-once'
    })
  })
  it("cancels the record on the adapter's own word that the request is withdrawn", async () => {
    const f = fixture()
    f.emit(permission)
    f.emit({ ...permission, id: 'native-2' })
    f.emit({ type: 'permission_withdrawn', id: permission.id })
    expect(f.requests.snapshot().pending.map((r) => r.providerRequestId)).toEqual(['native-2'])
    await expect(
      f.host.write(session.id, {
        type: 'permission_response',
        id: permission.id,
        optionId: 'allow-once'
      })
    ).rejects.toMatchObject({ _tag: 'RequestRejected', code: 'closed' })
    expect(f.write).not.toHaveBeenCalled()
  })
  it('removes native Codex requests resolved by the provider itself', () => {
    const f = fixture()
    f.emit({ ...permission, id: JSON.stringify(7) })
    f.emit({
      type: 'provider_event',
      provider: 'codex',
      payload: {
        method: 'serverRequest/resolved',
        params: { requestId: 7 }
      }
    })
    expect(f.requests.snapshot().pending).toEqual([])
  })
})

/* PRDCT-4157: a request an agent tool puts to the person rides the native
   road. Created through the wrapper, it is published into the session's
   stream as a question, the session reads as waiting, the view's answer
   settles it for the tool, and its withdrawal reaches every view. */
describe('hosted requests on the native road', () => {
  const onboarding = {
    sessionId: session.id,
    description: 'Before we start.',
    questions: [{ id: 'email', question: 'Your team e-mail', kind: 'email' as const, options: [] }]
  }
  function hostedFixture(): ReturnType<typeof fixture> & {
    published: SessionEvent[]
    states: string[]
    createHosted: ReturnType<typeof requestAwareSessionHost>['createHosted']
  } {
    const listeners = new Set<(value: SessionStream) => void>()
    const all = new Set<(id: string, value: SessionStream) => void>()
    const published: SessionEvent[] = []
    const states: string[] = []
    const write = vi.fn(async () => {})
    let current: Session = { ...session, state: 'working' }
    const host: SessionHostService = {
      ...SessionHost.none,
      get: (id) => (id === session.id ? current : undefined),
      list: () => [current],
      subscribe: (_id, listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
      write
    }
    const requests = new PendingRequests()
    const wrapped = requestAwareSessionHost({
      host,
      requests,
      subscribeAll: (listener) => {
        all.add(listener)
        return () => {
          all.delete(listener)
        }
      },
      publish: (id, event) => {
        published.push(event)
        for (const listener of listeners) listener({ kind: 'event', event: event as never })
        for (const listener of all) listener(id, { kind: 'event', event: event as never })
      },
      setState: (_id, state) => {
        states.push(state)
        current = { ...current, state }
      }
    })
    return {
      host: wrapped.host,
      requests,
      write,
      published,
      states,
      createHosted: wrapped.createHosted,
      emit: (event) => {
        for (const listener of listeners) listener({ kind: 'event', event })
        for (const listener of all) listener(session.id, { kind: 'event', event })
      }
    }
  }

  it('publishes the request as a question into the stream and marks the session waiting', () => {
    const f = hostedFixture()
    const seen: SessionEvent[] = []
    f.host.subscribe(session.id, (value) => {
      if (value.kind === 'event') seen.push(value.event)
    })
    const request = f.createHosted(onboarding)
    expect(f.published).toHaveLength(1)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      type: 'permission_request',
      id: request.providerRequestId,
      description: 'Before we start.',
      toolName: 'clave_request_input',
      options: [
        { id: 'answer', label: 'Send' },
        { id: 'deny', label: 'Skip' }
      ]
    })
    expect(f.states).toEqual(['blocked'])
    // The wrapper's own listener saw its own event and minted no second record.
    expect(f.requests.snapshot().pending).toHaveLength(1)
    f.requests.close()
  })

  it("the view's answer settles it for the tool, never a provider, and withdraws the card", async () => {
    const f = hostedFixture()
    const request = f.createHosted(onboarding)
    await f.host.write(session.id, {
      type: 'permission_response',
      id: request.providerRequestId!,
      optionId: 'answer',
      answers: { email: 'luca@antasphere.com' }
    })
    expect(f.write).not.toHaveBeenCalled()
    expect(await f.requests.resultAfter(request.id, session.id)).toEqual({
      requestId: request.id,
      status: 'completed',
      answers: { email: 'luca@antasphere.com' }
    })
    expect(f.published.at(-1)).toEqual({
      type: 'permission_withdrawn',
      id: request.providerRequestId
    })
    expect(f.states).toEqual(['blocked', 'working'])
    f.requests.close()
  })

  it('a second answer is refused as settled, like a native one', async () => {
    const f = hostedFixture()
    const request = f.createHosted(onboarding)
    await f.host.write(session.id, {
      type: 'permission_response',
      id: request.providerRequestId!,
      optionId: 'deny'
    })
    await expect(
      f.host.write(session.id, {
        type: 'permission_response',
        id: request.providerRequestId!,
        optionId: 'deny'
      })
    ).rejects.toMatchObject({ code: 'closed' })
    expect((await f.requests.resultAfter(request.id, session.id)).status).toBe('dismissed')
    f.requests.close()
  })

  it('an answer that does not fit its kind is refused and the card stays', async () => {
    const f = hostedFixture()
    const request = f.createHosted(onboarding)
    await expect(
      f.host.write(session.id, {
        type: 'permission_response',
        id: request.providerRequestId!,
        optionId: 'answer',
        answers: { email: 'not an email' }
      })
    ).rejects.toMatchObject({ code: 'invalid' })
    expect(f.published.filter((e) => e.type === 'permission_withdrawn')).toHaveLength(0)
    expect((await f.requests.resultAfter(request.id, session.id)).status).toBe('pending')
    f.requests.close()
  })

  it('a later subscriber is replayed the request still waiting', () => {
    const f = hostedFixture()
    const request = f.createHosted(onboarding)
    const seen: SessionEvent[] = []
    f.host.subscribe(session.id, (value) => {
      if (value.kind === 'event') seen.push(value.event)
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ type: 'permission_request', id: request.providerRequestId })
    f.requests.close()
  })

  it("the turn's end cancels it, as a native question, and the card is withdrawn", async () => {
    const f = hostedFixture()
    const request = f.createHosted(onboarding)
    f.emit({ type: 'state_change', state: 'done' })
    expect((await f.requests.resultAfter(request.id, session.id)).status).toBe('cancelled')
    expect(f.published.at(-1)).toEqual({
      type: 'permission_withdrawn',
      id: request.providerRequestId
    })
    f.requests.close()
  })

  it('refuses a session the host does not know', () => {
    const f = hostedFixture()
    expect(() => f.createHosted({ ...onboarding, sessionId: 'nobody' })).toThrow('Unknown session')
    expect(f.published).toHaveLength(0)
    f.requests.close()
  })

  it('a native request settling publishes nothing on the hosted road and leaves the state alone', () => {
    const f = hostedFixture()
    f.emit(permission)
    expect(f.requests.snapshot().pending).toHaveLength(1)
    f.requests.cancelNative(session.id, permission.id)
    expect(f.published).toHaveLength(0)
    expect(f.states).toEqual([])
    f.requests.close()
  })

  it('a hosted request settled while a native one still waits keeps the session waiting', async () => {
    const f = hostedFixture()
    const request = f.createHosted(onboarding)
    f.emit(permission)
    await f.host.write(session.id, {
      type: 'permission_response',
      id: request.providerRequestId!,
      optionId: 'deny'
    })
    expect(f.states).toEqual(['blocked'])
    f.requests.close()
  })
})
