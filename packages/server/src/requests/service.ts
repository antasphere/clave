import { randomUUID } from 'node:crypto'
import { Schema } from 'effect'
import { isQuestionAnswerKey } from './question-key'
import {
  PendingRequest,
  RequestRejected,
  RequestResponse,
  type RequestSnapshot,
  type ResolveRequestInput
} from '../../../contract/src/requests'

export type RequestInput = Omit<PendingRequest, 'id' | 'createdAt'>
export type RequestStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'dismissed'
  | 'cancelled'
export interface RequestResult {
  readonly requestId: string
  readonly status: RequestStatus
  /** Secret responses and action output are deliberately absent. */
  readonly response?: Exclude<RequestResponse, { type: 'secret' }>
}
type Resolver = (response: RequestResponse) => Promise<void>
interface Entry {
  request: PendingRequest
  result: RequestResult
  resolve?: Resolver
  expiresAt?: number
}
const invalid = (): RequestRejected =>
  new RequestRejected({
    code: 'invalid',
    message: 'The response does not answer this pending request.'
  })

/** Pending work outlives all clients. Results expire after ten minutes and
 * capacity is bounded; neither HTTP cancellation nor elapsed time answers work. */
export class PendingRequests {
  private readonly entries = new Map<string, Entry>()
  private readonly listeners = new Set<(revision: number) => void>()
  private revision = 0
  private closed = false
  constructor(
    private readonly options: {
      readonly now?: () => number
      readonly capacity?: number
      readonly resultTtlMs?: number
    } = {}
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
  private prune(): void {
    for (const [id, entry] of this.entries)
      if (entry.expiresAt !== undefined && entry.expiresAt <= this.now()) this.entries.delete(id)
  }
  private changed(): void {
    this.revision += 1
    for (const listener of [...this.listeners]) {
      // A client/event sink cannot change whether an answer was accepted.
      try {
        listener(this.revision)
      } catch {
        /* listener owns its failure */
      }
    }
  }
  create(input: RequestInput, resolve?: Resolver): PendingRequest {
    if (this.closed)
      throw new RequestRejected({ code: 'closed', message: 'The server is stopping.' })
    this.prune()
    if (this.entries.size >= (this.options.capacity ?? 1000))
      throw new RequestRejected({
        code: 'capacity',
        message: 'The server request limit was reached.'
      })
    let request: PendingRequest
    try {
      if (Buffer.byteLength(JSON.stringify(input)) > 128 * 1024) throw invalid()
      request = Schema.decodeUnknownSync(PendingRequest)({
        ...input,
        id: randomUUID(),
        createdAt: this.now()
      })
    } catch {
      throw invalid()
    }
    if (request.kind === 'secret' && !request.action) throw invalid()
    if (request.kind === 'permission' && !request.options?.length) throw invalid()
    if (request.kind === 'clarification' && !request.questions?.length) throw invalid()
    const questionKeys = request.questions?.map((q) => q.id ?? q.question) ?? []
    if (questionKeys.some((key) => !isQuestionAnswerKey(key))) throw invalid()
    if (new Set(questionKeys).size !== questionKeys.length) throw invalid()
    this.entries.set(request.id, {
      request: structuredClone(request),
      result: { requestId: request.id, status: 'pending' },
      resolve
    })
    this.changed()
    return structuredClone(request)
  }
  snapshot(): RequestSnapshot {
    return {
      revision: this.revision,
      pending: [...this.entries.values()]
        .filter((entry) => entry.result.status === 'pending')
        .map((entry) => structuredClone(entry.request))
    }
  }
  native(sessionId: string, providerRequestId: string): PendingRequest | undefined {
    this.prune()
    const entry = [...this.entries.values()].find(
      (e) => e.request.sessionId === sessionId && e.request.providerRequestId === providerRequestId
    )
    return entry && structuredClone(entry.request)
  }
  subscribe(listener: (revision: number) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  result(id: string, sessionId: string): RequestResult {
    this.prune()
    const entry = this.entries.get(id)
    if (!entry || entry.request.sessionId !== sessionId)
      throw new RequestRejected({
        code: 'not_found',
        message: 'No request belongs to this caller.'
      })
    return structuredClone(entry.result)
  }
  async resolve(input: ResolveRequestInput): Promise<{ accepted: boolean }> {
    const entry = this.entries.get(input.requestId)
    if (!entry)
      throw new RequestRejected({ code: 'not_found', message: 'No such pending request.' })
    if (entry.result.status !== 'pending') return { accepted: false }
    let response: RequestResponse
    try {
      response = Schema.decodeUnknownSync(RequestResponse)(input.response)
    } catch {
      throw invalid()
    }
    this.validate(entry.request, response)
    // Reserve synchronously before the first await. A concurrent answer never
    // invokes the provider/action again, including when the callback fails.
    entry.result = { requestId: input.requestId, status: 'running' }
    const resolve = entry.resolve
    delete entry.resolve
    this.changed()
    try {
      await resolve?.(response)
      entry.result = {
        requestId: input.requestId,
        status: response.type === 'dismiss' ? 'dismissed' : 'completed',
        ...(response.type !== 'secret' &&
          !entry.request.providerRequestId && { response: structuredClone(response) })
      }
    } catch {
      // Raw exceptions can contain a secret, file content or a provider payload.
      entry.result = { requestId: input.requestId, status: 'failed' }
    }
    entry.expiresAt = this.now() + (this.options.resultTtlMs ?? 600_000)
    this.changed()
    return { accepted: true }
  }
  private validate(request: PendingRequest, response: RequestResponse): void {
    if (response.type === 'dismiss') return
    if (request.kind === 'secret') {
      if (response.type !== 'secret' || !response.value) throw invalid()
      return
    }
    if (request.providerRequestId || request.kind === 'permission') {
      if (
        response.type !== 'permission' ||
        !request.options?.some((o) => o.id === response.optionId)
      )
        throw invalid()
      if (request.questions?.length && response.optionId === 'answer')
        this.validateAnswers(request, response.answers)
      else if (response.answers !== undefined) throw invalid()
      return
    }
    if (response.type !== 'clarification') throw invalid()
    this.validateAnswers(request, response.answers)
  }
  private validateAnswers(
    request: PendingRequest,
    answers: Readonly<Record<string, string>> | undefined
  ): void {
    const questions = request.questions ?? []
    if (
      !answers ||
      Object.keys(answers).length !== questions.length ||
      questions.some((q) => {
        const key = q.id ?? q.question
        return (
          !Object.hasOwn(answers, key) || typeof answers[key] !== 'string' || !answers[key].trim()
        )
      })
    )
      throw invalid()
  }
  cancelSession(sessionId: string): void {
    this.cancel((request) => request.sessionId === sessionId)
  }
  cancelNative(sessionId: string, providerRequestId?: string): void {
    this.cancel(
      (request) =>
        request.sessionId === sessionId &&
        request.providerRequestId !== undefined &&
        (providerRequestId === undefined || request.providerRequestId === providerRequestId)
    )
  }
  private cancel(matches: (request: PendingRequest) => boolean): void {
    let changed = false
    for (const entry of this.entries.values()) {
      if (!matches(entry.request) || entry.result.status !== 'pending') continue
      entry.result = { requestId: entry.request.id, status: 'cancelled' }
      delete entry.resolve
      entry.expiresAt = this.now() + (this.options.resultTtlMs ?? 600_000)
      changed = true
    }
    if (changed) this.changed()
  }
  close(): void {
    this.closed = true
    for (const id of new Set([...this.entries.values()].map((e) => e.request.sessionId)))
      this.cancelSession(id)
    this.listeners.clear()
  }
}
