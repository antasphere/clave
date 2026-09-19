import { randomUUID } from 'node:crypto'
import type { AdapterLaunch, ConversationAdapter, EmitConversationEvent } from '../adapter'
import type { AgentCapabilities, AgentRequest, AgentResponse } from '../../../shared/agent-session'
import { AdapterError, OwnedProcess, Requests } from './transport'

export abstract class BaseAdapter implements ConversationAdapter {
  abstract readonly capabilities: AgentCapabilities
  protected process = new OwnedProcess((reason) => this.fail(reason))
  protected rpc = new Requests()
  protected ready = false
  protected active = false
  protected interrupted = false
  protected dead = false
  protected sessionId?: string
  private started = false
  private failureReason?: string
  private interruptDeadline?: ReturnType<typeof setTimeout>
  private pending = new Map<string, (response: AgentResponse) => Promise<void>>()
  private requestDeadlines = new Map<string, ReturnType<typeof setTimeout>>()
  constructor(
    protected launch: AdapterLaunch,
    protected emit: EmitConversationEvent
  ) {}
  protected abstract boot(): Promise<void>
  protected abstract prompt(text: string): Promise<void>
  protected abstract abort(): Promise<void>
  async start(): Promise<void> {
    if (this.started) throw new AdapterError('Adapter already started')
    this.started = true
    this.emit({ type: 'capabilities', capabilities: this.capabilities })
    try {
      await this.boot()
      if (this.dead) throw new Error('Provider exited during initialization')
      this.ready = true
      this.emit({ type: 'status', status: 'idle' })
    } catch (error) {
      const reason =
        this.failureReason ??
        (error instanceof AdapterError
          ? error.safeMessage
          : 'Provider initialization failed. Check the installed CLI version and login.')
      this.fail(reason)
      await this.dispose()
      throw new AdapterError(reason)
    }
  }
  async send(text: string): Promise<void> {
    if (!this.ready || this.dead) throw new AdapterError('Provider is not ready')
    if (this.active) throw new AdapterError('A turn is already active')
    if (!text.trim() || Buffer.byteLength(text) > 1_000_000)
      throw new AdapterError('Invalid prompt size')
    this.active = true
    this.interrupted = false
    this.emit({ type: 'status', status: 'running' })
    try {
      await this.prompt(text)
    } catch {
      // Acceptance is ambiguous after a timeout. A second turn must not enter
      // a provider that might still be running the first.
      this.fail('Provider did not accept the prompt')
      throw new AdapterError(this.failureReason ?? 'Provider did not accept the prompt')
    }
  }
  async interrupt(): Promise<void> {
    if (!this.active || this.dead || this.interrupted) return
    this.interrupted = true
    this.cancelRequests()
    this.interruptDeadline = setTimeout(
      () => this.fail('Provider did not finish interrupting the turn'),
      10_000
    )
    this.interruptDeadline.unref()
    try {
      await this.abort()
    } catch {
      this.fail('Provider interrupt failed')
      throw new AdapterError('Provider interrupt failed')
    }
    // The completion event, not the RPC acknowledgement, opens the next turn.
  }
  async respond(response: AgentResponse): Promise<void> {
    const callback = this.pending.get(response.requestId)
    if (!callback || this.dead) throw new AdapterError('Request is no longer pending')
    // Remove before awaiting to prevent double submission.
    this.pending.delete(response.requestId)
    clearTimeout(this.requestDeadlines.get(response.requestId))
    this.requestDeadlines.delete(response.requestId)
    // A provider may finish the turn before its response HTTP/RPC write settles.
    // Resolve the UI request first, so no late resolution reopens a completed turn.
    this.emit({ type: 'request-resolved', requestId: response.requestId })
    try {
      await callback(response)
    } catch {
      this.fail('Provider could not accept the response')
      throw new AdapterError('Provider could not accept the response')
    }
  }
  protected request(
    request: AgentRequest,
    callback: (response: AgentResponse) => Promise<void>,
    timeout?: number
  ): void {
    if (this.pending.size >= 64 || this.pending.has(request.id))
      throw new Error('Invalid provider request count')
    this.pending.set(request.id, callback)
    if (timeout !== undefined) {
      if (!Number.isFinite(timeout) || timeout < 0 || timeout > 2_147_483_647)
        throw new Error('Invalid request timeout')
      const timer = setTimeout(() => {
        this.cancelRequest(request.id)
        void callback({ requestId: request.id, decision: 'deny' }).catch(() =>
          this.fail('Provider request cancellation failed')
        )
      }, timeout)
      timer.unref()
      this.requestDeadlines.set(request.id, timer)
    }
    this.emit({ type: 'request', request })
  }
  protected cancelRequest(id: string): void {
    clearTimeout(this.requestDeadlines.get(id))
    this.requestDeadlines.delete(id)
    if (this.pending.delete(id)) this.emit({ type: 'request-resolved', requestId: id })
  }
  protected cancelRequests(): void {
    for (const id of this.pending.keys()) this.cancelRequest(id)
  }
  protected providerSession(id: string): void {
    this.sessionId = id
    this.emit({ type: 'provider-session', providerSessionId: id })
  }
  protected text(id: string, text: string): void {
    this.emit({ type: 'message', message: { kind: 'message', role: 'assistant', id, text } })
  }
  protected delta(id: string, text: string): void {
    this.emit({ type: 'text-delta', messageId: id, text })
  }
  protected newMessageId(): string {
    return randomUUID()
  }
  protected finish(
    outcome: 'completed' | 'interrupted' | 'failed' = 'completed',
    error?: string
  ): void {
    if (!this.active) return
    this.active = false
    clearTimeout(this.interruptDeadline)
    this.cancelRequests()
    this.emit({
      type: 'turn-end',
      outcome: this.interrupted ? 'interrupted' : outcome,
      ...(error ? { error } : {})
    })
  }
  protected fail(reason: string): void {
    if (this.dead) return
    this.failureReason = reason
    this.dead = true
    this.ready = false
    this.finish('failed', reason)
    this.cancelRequests()
    this.rpc.close()
    this.emit({ type: 'status', status: 'error', error: reason })
    void this.process.dispose()
  }
  async dispose(): Promise<void> {
    this.dead = true
    this.ready = false
    clearTimeout(this.interruptDeadline)
    this.cancelRequests()
    this.rpc.close()
    await this.process.dispose()
  }
}
