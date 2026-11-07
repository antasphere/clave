import { randomUUID } from 'node:crypto'
import { Schema } from 'effect'
import { isQuestionAnswerKey } from './question-key'
import {
  PendingRequest,
  RequestRejected,
  RequestResponse,
  type Answers,
  type HostedRequestInput,
  type RequestResultView,
  type RequestSnapshot,
  type ResolveRequestInput
} from '../../../contract/src/requests'
import {
  INPUT_REQUEST_OPTIONS,
  INPUT_REQUEST_TOOL,
  answerProblem,
  own,
  questionsShapeProblem
} from '../../../contract/src/input-kinds'

const trimAnswers = (answers: Answers): Answers =>
  Object.fromEntries(
    Object.entries(answers).map(([key, value]) => [
      key,
      typeof value === 'string' ? value.trim() : value.map((v) => v.trim())
    ])
  )

export type RequestInput = Omit<PendingRequest, 'id' | 'createdAt'>
/** The prefix of the id a hosted request carries as its provider id. */
export const HOSTED_REQUEST_PREFIX = 'clave:'
/** The longest the result query holds its answer waiting for the person: under
 *  the client's own deadline, so a poll never dies on the wire. */
export const RESULT_WAIT_MAX_MS = 45_000
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
  /** A request an agent tool created (`createHosted`): answered to the tool
   *  that polls, never written to a provider. */
  hosted?: boolean
}
export type SettledListener = (request: PendingRequest, result: RequestResult) => void
const isSettled = (status: RequestStatus): boolean => status !== 'pending' && status !== 'running'
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
  private readonly settled = new Set<SettledListener>()
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
  /** Told once per request as it leaves pending: answered, dismissed,
   *  cancelled or failed. What the hosted road publishes to the views from. */
  onSettled(listener: SettledListener): () => void {
    this.settled.add(listener)
    return () => {
      this.settled.delete(listener)
    }
  }
  private settle(entry: Entry): void {
    for (const listener of [...this.settled]) {
      try {
        listener(structuredClone(entry.request), structuredClone(entry.result))
      } catch {
        /* listener owns its failure */
      }
    }
  }
  /**
   * A request an agent tool puts to the person (`clave_request_input`,
   * PRDCT-4157): a clarification with the server's own provider id, so it
   * rides the native question road into every view of the session, answered
   * with the question card's two words (`answer` with the answers, `deny` to
   * skip) and kept for the tool's poll rather than written to a provider.
   */
  createHosted(input: HostedRequestInput): PendingRequest {
    // The shape rules of the contract, the same the tool applies: the server
    // never holds a question the card could not answer (a choice with no
    // option, a link that is not http(s), an id that is not a key).
    const shape = questionsShapeProblem(input.questions)
    if (shape) throw new RequestRejected({ code: 'invalid', message: shape })
    const request = this.create({
      sessionId: input.sessionId,
      kind: 'clarification',
      description: input.description,
      providerRequestId: `${HOSTED_REQUEST_PREFIX}${randomUUID()}`,
      options: INPUT_REQUEST_OPTIONS.map((o) => ({ ...o })),
      questions: input.questions,
      toolName: INPUT_REQUEST_TOOL,
      input: { tool: INPUT_REQUEST_TOOL, layout: input.layout ?? 'form' }
    })
    const entry = this.entries.get(request.id)
    if (entry) entry.hosted = true
    return request
  }
  /** Whether the request was created by `createHosted`. */
  isHosted(id: string): boolean {
    return this.entries.get(id)?.hosted === true
  }
  /** The hosted requests of a session still waiting for the person. */
  hostedPending(sessionId: string): PendingRequest[] {
    return [...this.entries.values()]
      .filter((e) => e.hosted && e.request.sessionId === sessionId && e.result.status === 'pending')
      .map((e) => structuredClone(e.request))
  }
  /**
   * Where a request stands, for the tool that created it: at once, or after
   * waiting up to `waitMs` (bounded) for the person. A hosted request's
   * answers travel here and nowhere else; a secret's value never does.
   */
  async resultAfter(requestId: string, sessionId: string, waitMs = 0): Promise<RequestResultView> {
    const view = (): RequestResultView => {
      const result = this.result(requestId, sessionId)
      const entry = this.entries.get(requestId)
      const response = result.response
      const skipped =
        entry?.hosted && response?.type === 'permission' && response.optionId === 'deny'
      const answers =
        entry?.hosted && response?.type === 'permission' && response.optionId === 'answer'
          ? response.answers
          : undefined
      return {
        requestId,
        status: skipped && result.status === 'completed' ? 'dismissed' : result.status,
        ...(answers && { answers: answers as Answers })
      }
    }
    const first = view()
    const wait = Math.min(Math.max(0, waitMs), RESULT_WAIT_MAX_MS)
    if (isSettled(first.status) || wait === 0) return first
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, wait)
      const off = this.subscribe(() => {
        const entry = this.entries.get(requestId)
        if (!entry || isSettled(entry.result.status)) done()
      })
      function done(): void {
        clearTimeout(timer)
        off()
        resolve()
      }
    })
    return view()
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
    // A hosted request's answers are trimmed here, whichever client sent
    // them: the tool reads what the person meant, never their stray spaces.
    if (entry.hosted && response.type === 'permission' && response.answers)
      response = { ...response, answers: trimAnswers(response.answers) }
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
          (entry.hosted || !entry.request.providerRequestId) && {
            response: structuredClone(response)
          })
      }
    } catch {
      // Raw exceptions can contain a secret, file content or a provider payload.
      entry.result = { requestId: input.requestId, status: 'failed' }
    }
    entry.expiresAt = this.now() + (this.options.resultTtlMs ?? 600_000)
    this.changed()
    this.settle(entry)
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
  private validateAnswers(request: PendingRequest, answers: Answers | undefined): void {
    const questions = request.questions ?? []
    if (!answers) throw invalid()
    const keys = new Set(questions.map((q) => q.id ?? q.question))
    if (Object.keys(answers).some((key) => !keys.has(key))) throw invalid()
    if (this.entries.get(request.id)?.hosted) {
      // A hosted request's answers are judged by each question's kind, the
      // same rule the card applied as they were typed; an optional question
      // may be left out.
      for (const q of questions) {
        const value = own(answers, q.id ?? q.question)
        if (answerProblem(q, value) !== null) throw invalid()
      }
      return
    }
    if (
      Object.keys(answers).length !== questions.length ||
      questions.some((q) => {
        const value = answers[q.id ?? q.question]
        return typeof value !== 'string' || !value.trim()
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
    const cancelled: Entry[] = []
    for (const entry of this.entries.values()) {
      if (!matches(entry.request) || entry.result.status !== 'pending') continue
      entry.result = { requestId: entry.request.id, status: 'cancelled' }
      delete entry.resolve
      entry.expiresAt = this.now() + (this.options.resultTtlMs ?? 600_000)
      changed = true
      cancelled.push(entry)
    }
    if (changed) this.changed()
    for (const entry of cancelled) this.settle(entry)
  }
  close(): void {
    this.closed = true
    for (const id of new Set([...this.entries.values()].map((e) => e.request.sessionId)))
      this.cancelSession(id)
    this.listeners.clear()
    this.settled.clear()
  }
}
