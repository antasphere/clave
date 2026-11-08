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
  type ResolveRequestInput,
  type SetRequestAnswersInput
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
  /** Why a request is `cancelled` when the server itself cancelled it: the
   *  one reason today is a restart, which empties this store (PRDCT-4192). */
  readonly reason?: string
}

/** What a caller polling a request this server has no memory of is told
 *  (PRDCT-4192): the store is in memory, so after a restart every request
 *  made before it is gone, and "no request belongs to this caller" read as
 *  an ownership error to the agent that had asked. */
export const LOST_TO_RESTART = 'the server restarted; ask again'
type Resolver = (response: RequestResponse) => Promise<void>
interface Entry {
  request: PendingRequest
  result: RequestResult
  resolve?: Resolver
  expiresAt?: number
  /** A request an agent tool created (`createHosted`): answered to the tool
   *  that polls, never written to a provider. */
  hosted?: boolean
  /** A hosted form's fields set while it is still open: by the agent from
   *  what the person said (`setAnswers`). What the card shows and what the
   *  tool reads on a pending form. */
  draft?: Answers
  /** A hosted form approved, then a field set again. */
  revised?: boolean
  /** The agent itself approved the form (`setAnswers` with `submit`). */
  byAgent?: boolean
}
/** How a request settled, for the road that tells the agent: whether the
 *  agent settled it itself. */
export interface SettledMeta {
  readonly byAgent: boolean
}
export type SettledListener = (
  request: PendingRequest,
  result: RequestResult,
  meta: SettledMeta
) => void
/** A hosted form's answers changed (PRDCT-4157): the patch, and whether
 *  the form was already approved (`sent`). */
export type UpdatedListener = (
  request: PendingRequest,
  answers: Answers,
  sent: boolean,
  notes?: Readonly<Record<string, string>>
) => void
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
  private readonly updated = new Set<UpdatedListener>()
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
    const meta: SettledMeta = { byAgent: entry.byAgent === true }
    for (const listener of [...this.settled]) {
      try {
        listener(structuredClone(entry.request), structuredClone(entry.result), meta)
      } catch {
        /* listener owns its failure */
      }
    }
  }
  /** Told when a hosted form's answers change under its card (PRDCT-4157):
   *  a field the agent set on the open form, or on the approved one. */
  onUpdated(listener: UpdatedListener): () => void {
    this.updated.add(listener)
    return () => {
      this.updated.delete(listener)
    }
  }
  private notifyUpdated(
    entry: Entry,
    answers: Answers,
    sent: boolean,
    notes?: Readonly<Record<string, string>>
  ): void {
    for (const listener of [...this.updated]) {
      try {
        if (notes)
          listener(structuredClone(entry.request), structuredClone(answers), sent, {
            ...notes
          })
        else listener(structuredClone(entry.request), structuredClone(answers), sent)
      } catch {
        /* listener owns its failure */
      }
    }
  }
  /** The fields of a hosted form still open that are set so far; empty for
   *  any other request. What a late view starts its card from. */
  draftOf(id: string): Answers {
    const entry = this.entries.get(id)
    return entry?.hosted && entry.result.status === 'pending' && entry.draft
      ? structuredClone(entry.draft)
      : {}
  }
  /**
   * The agent writes to a form it asked (`clave_input_set`, PRDCT-4157):
   * each field judged by its question's kind, the same rule the card applies
   * as the person types; an empty value clears an optional field. Nothing is
   * written when anything is refused. On a form still open the fields go to
   * its draft, which the card shows and the tool reads; with `submit` the
   * open form is approved with what it then holds, every required field
   * answered, judged before a field is written. On a form already approved
   * the fields replace the answers, and the form reads revised once a value
   * actually changed. A skipped or cancelled form takes nothing.
   */
  async setAnswers(input: SetRequestAnswersInput): Promise<RequestResultView> {
    this.prune()
    const entry = this.entries.get(input.requestId)
    if (!entry || !entry.hosted || entry.request.sessionId !== input.sessionId)
      throw new RequestRejected({
        code: 'not_found',
        message: 'No request belongs to this caller.'
      })
    const questions = entry.request.questions ?? []
    const byKey = new Map(questions.map((q) => [q.id ?? q.question, q]))
    const answers = trimAnswers(input.answers)
    const cleared = new Set<string>()
    const notes = Object.fromEntries(
      Object.entries(input.notes ?? {}).flatMap(([key, note]) =>
        note.trim() ? [[key, note.trim()]] : []
      )
    )
    for (const key of Object.keys(notes))
      if (!byKey.has(key))
        throw new RequestRejected({
          code: 'invalid',
          message: `No question "${key}" on this form.`
        })
    for (const [key, value] of Object.entries(answers)) {
      const question = byKey.get(key)
      if (!question)
        throw new RequestRejected({
          code: 'invalid',
          message: `No question "${key}" on this form.`
        })
      const problem = answerProblem(question, value)
      if (problem !== null)
        throw new RequestRejected({ code: 'invalid', message: `"${key}": ${problem}.` })
      if (typeof value === 'string' ? value === '' : value.length === 0) cleared.add(key)
    }
    /** The same answer, a multi-select's labels in any order. */
    const same = (a: unknown, b: unknown): boolean =>
      Array.isArray(a) && Array.isArray(b)
        ? JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
        : JSON.stringify(a) === JSON.stringify(b)
    /** The answers as they will stand, and the patch the views are told. */
    const merge = (
      current: Answers
    ): { next: Answers; patch: Record<string, string | readonly string[]> } => {
      const next: Record<string, string | readonly string[]> = { ...current }
      const patch: Record<string, string | readonly string[]> = {}
      for (const [key, value] of Object.entries(answers)) {
        const before = own(current, key)
        if (cleared.has(key)) {
          if (before === undefined) continue
          delete next[key]
          patch[key] = ''
        } else if (!same(before, value)) {
          next[key] = value
          patch[key] = value
        }
      }
      return { next, patch }
    }
    const status = entry.result.status
    if (status === 'pending') {
      const { next, patch } = merge(entry.draft ?? {})
      if (input.submit) {
        const missing = questions.find(
          (q) => answerProblem(q, own(next, q.id ?? q.question)) !== null
        )
        if (missing)
          throw new RequestRejected({
            code: 'invalid',
            message: `"${missing.id ?? missing.question}" is still unanswered; set it, or let the person approve.`
          })
      }
      const noted = Object.keys(notes).length > 0
      if (Object.keys(patch).length) {
        entry.draft = next
        this.changed()
      }
      if (Object.keys(patch).length || noted)
        this.notifyUpdated(entry, patch, false, noted ? notes : undefined)
      if (input.submit) {
        entry.byAgent = true
        await this.resolve({
          requestId: entry.request.id,
          response: { type: 'permission', optionId: 'answer', answers: entry.draft ?? {} }
        })
      }
      return this.resultAfter(input.requestId, input.sessionId)
    }
    const response = entry.result.response
    if (
      status === 'completed' &&
      response?.type === 'permission' &&
      response.optionId === 'answer'
    ) {
      const { next, patch } = merge(response.answers ?? {})
      if (Object.keys(patch).length) {
        entry.result = { ...entry.result, response: { ...response, answers: next } }
        entry.revised = true
        this.changed()
        this.notifyUpdated(entry, patch, true)
      }
      return this.resultAfter(input.requestId, input.sessionId)
    }
    throw new RequestRejected({
      code: 'closed',
      message: `This form was ${status === 'completed' ? 'skipped' : status}; ask again.`
    })
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
          : entry?.hosted &&
              result.status === 'pending' &&
              entry.draft &&
              Object.keys(entry.draft).length
            ? entry.draft
            : undefined
      return {
        requestId,
        status: skipped && result.status === 'completed' ? 'dismissed' : result.status,
        ...(answers && { answers: answers as Answers }),
        ...(entry?.revised && { revised: true })
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
    // A request this store never heard of, or heard of and lost: the
    // store lives in memory, so a restart empties it and every caller that
    // was waiting polls an id nobody holds. Said as cancelled with its
    // reason, not as another caller's request (PRDCT-4192). An expired
    // result reads the same way: its ten minutes were up.
    if (!entry) return { requestId: id, status: 'cancelled', reason: LOST_TO_RESTART }
    if (entry.request.sessionId !== sessionId)
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
  /** The provider's requests of a session are gone: one by its id, or all
   *  of them when the turn ended. A hosted form lives across turns
   *  (PRDCT-4157), so the unnamed cancel leaves it; naming its id still
   *  cancels it. */
  cancelNative(sessionId: string, providerRequestId?: string): void {
    this.cancel(
      (request) =>
        request.sessionId === sessionId &&
        request.providerRequestId !== undefined &&
        (providerRequestId === undefined
          ? !this.isHosted(request.id)
          : request.providerRequestId === providerRequestId)
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
    this.updated.clear()
  }
}
