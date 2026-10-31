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
function fixture(): {
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
  const requests = new PendingRequests()
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
