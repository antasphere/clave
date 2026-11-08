import type { RequestsService, SessionHostService } from '@clave/server'
import type { AgentState, SessionEvent, SessionStream } from '@clave/contract/sessions'
import {
  RequestRejected,
  type Answers,
  type HostedRequestInput,
  type PendingRequest
} from '../../../packages/contract/src/requests'
import type { PendingRequests } from '../../../packages/server/src/requests/service'
import { REQUEST_GONE } from '../../shared/request-refusals'
import { formMessage } from '../../shared/form-message'

const eventOf = (r: PendingRequest): Extract<SessionEvent, { type: 'permission_request' }> => ({
  type: 'permission_request',
  id: r.providerRequestId!,
  description: r.description,
  options: [...(r.options ?? [])],
  ...(r.questions && { questions: [...r.questions] }),
  ...(r.toolName !== undefined && { toolName: r.toolName }),
  ...(r.input !== undefined && { input: r.input }),
  ...(r.detail !== undefined && { detail: r.detail })
})

/** The fields of a form still open, as the event that tells a view of them:
 *  what a view that subscribes late is handed after the question itself. */
const draftEventOf = (
  r: PendingRequest,
  draft: Answers
): Extract<SessionEvent, { type: 'permission_updated' }> | null =>
  Object.keys(draft).length
    ? { type: 'permission_updated', id: r.providerRequestId!, answers: { ...draft } }
    : null

/** Add request ownership around the frozen lifecycle host. The global stream
 * subscription exists before any client, and never makes stopped sessions ready. */
export function requestAwareSessionHost(options: {
  host: SessionHostService
  requests: PendingRequests
  subscribeAll: (listener: (id: string, value: SessionStream) => void) => () => void
  subscribeRemoved?: (listener: (id: string) => void) => () => void
  /** The hosted road (PRDCT-4157): how a request an agent tool created
   *  reaches a session's open views, as the adapter's own events do, and how
   *  the session is marked waiting while it stands. Without them a hosted
   *  request is seen by a view only when it subscribes. */
  publish?: (id: string, event: SessionEvent) => void
  setState?: (id: string, state: AgentState) => void
}): {
  host: SessionHostService
  close: () => void
  /** A request an agent tool puts to the person: created, published to the
   *  session's views as a question, the session marked waiting. */
  createHosted: (input: HostedRequestInput) => PendingRequest
  /** The requests port the server answers from: the service's own reads and
   *  resolution, the hosted create through this road. */
  port: RequestsService
} {
  const { host: base, requests } = options
  const publish = options.publish ?? ((): void => {})
  const setState = options.setState ?? ((): void => {})
  const createHosted = (input: HostedRequestInput): PendingRequest => {
    if (!base.get(input.sessionId)) throw new Error(`Unknown session "${input.sessionId}".`)
    const request = requests.createHosted(input)
    publish(input.sessionId, eventOf(request))
    setState(input.sessionId, 'blocked')
    return request
  }
  // A hosted request leaving pending (approved, skipped, cancelled with the
  // session) is withdrawn from every view, the way the adapter withdraws a
  // native one, after every view was handed the approved answers; the
  // session stops reading as waiting once nothing is. The person's approve
  // or skip reaches the agent as their next message, always: a tool call
  // that waited on it reads it in its result too, and is told so, where a
  // guess at whether anyone still listened to that call lost the approve
  // when the call had been interrupted.
  const offSettled = requests.onSettled((request, result, meta) => {
    if (!request.providerRequestId || !requests.isHosted(request.id)) return
    const id = request.sessionId
    const response = result.response
    const approved = response?.type === 'permission' && response.optionId === 'answer'
    try {
      if (approved && response.answers)
        publish(id, {
          type: 'permission_updated',
          id: request.providerRequestId,
          answers: { ...response.answers },
          sent: true
        })
      publish(id, { type: 'permission_withdrawn', id: request.providerRequestId })
    } catch {
      /* the session is gone with its views */
    }
    const waiting = requests.snapshot().pending.some((r) => r.sessionId === id)
    if (!waiting && base.get(id)?.state === 'blocked') setState(id, 'working')
    const byPerson = result.status === 'completed' || result.status === 'dismissed'
    if (byPerson && !meta.byAgent && base.get(id))
      void base
        .write(id, {
          type: 'user_message',
          text: formMessage({
            id: request.id,
            form: request.providerRequestId,
            description: request.description,
            questions: request.questions ?? [],
            ...(approved && response.answers && { answers: response.answers })
          }),
          form: request.providerRequestId
        })
        .catch(() => {
          /* the session took no message: the tool's own read still answers */
        })
  })
  // A field the agent set on a form reaches every view of the session.
  const offUpdated = requests.onUpdated((request, answers, sent) => {
    if (!request.providerRequestId) return
    try {
      publish(request.sessionId, {
        type: 'permission_updated',
        id: request.providerRequestId,
        answers: { ...answers },
        ...(sent && { sent: true })
      })
    } catch {
      /* the session is gone with its views */
    }
  })
  const off = options.subscribeAll((id, stream) => {
    if (stream.kind !== 'event') return
    const event = stream.event
    if (event.type === 'state_change' && event.state === 'ended') requests.cancelSession(id)
    if (
      (event.type === 'state_change' && event.state === 'done') ||
      event.type === 'turn_interrupted'
    )
      requests.cancelNative(id)
    // A form the agent asked lives across its turns (PRDCT-4157): the agent
    // ends its turn and the person fills the form or writes; the session
    // reads as waiting for the person until it is approved or skipped. Set
    // after this delivery is over: this listener runs inside the manager's
    // delivery of `done`, and a state set from here would reach the sidebar's
    // publisher before the `done` it answers.
    if (
      event.type === 'state_change' &&
      (event.state === 'done' || event.state === 'idle') &&
      requests.hostedPending(id).length > 0
    )
      queueMicrotask(() => {
        if (requests.hostedPending(id).length > 0 && base.get(id)) setState(id, 'blocked')
      })
    // The adapter's own word that a request is gone, the one the views settle
    // their card on; the raw frames below say the same for the built-in CLIs.
    if (event.type === 'permission_withdrawn') requests.cancelNative(id, event.id)
    if (event.type === 'provider_event' && event.provider === 'claude') {
      const raw = event.payload as { type?: unknown; request_id?: unknown } | null
      if (raw?.type === 'control_cancel_request' && typeof raw.request_id === 'string')
        requests.cancelNative(id, raw.request_id)
    }
    if (event.type === 'provider_event' && event.provider === 'codex') {
      const raw = event.payload as { method?: unknown; params?: { requestId?: unknown } } | null
      if (raw?.method === 'serverRequest/resolved' && raw.params?.requestId !== undefined)
        requests.cancelNative(id, JSON.stringify(raw.params.requestId))
    }
    if (event.type !== 'permission_request' || requests.native(id, event.id)) return
    const input = event.input as {
      questions?: Array<{ id?: unknown; question?: unknown; isSecret?: unknown }>
    } | null
    const rawQuestions = Array.isArray(input?.questions) ? input.questions : []
    const secretQuestions =
      event.toolName === 'item/tool/requestUserInput'
        ? (event.questions ?? [])
            .filter((q) =>
              rawQuestions.some(
                (raw) =>
                  raw.isSecret === true &&
                  (q.id !== undefined ? raw.id === q.id : raw.question === q.question)
              )
            )
            .map((q) => q.id ?? q.question)
        : []
    requests.create(
      {
        sessionId: id,
        kind: event.questions?.length ? 'clarification' : 'permission',
        providerRequestId: event.id,
        description: event.description,
        options: event.options,
        ...(event.questions && { questions: event.questions }),
        ...(secretQuestions.length && { secretQuestions }),
        ...(event.toolName !== undefined && { toolName: event.toolName }),
        ...(event.input !== undefined && { input: event.input }),
        ...(event.detail !== undefined && { detail: event.detail })
      },
      async (response) => {
        if (response.type === 'permission') {
          await base.write(id, {
            type: 'permission_response',
            id: event.id,
            optionId: response.optionId,
            ...(response.answers && { answers: { ...response.answers } })
          })
        } else if (response.type === 'dismiss') {
          // Never guess an allow option. A native dismissal is a known denial,
          // or a provider interrupt when its vocabulary offers no denial.
          const deny = event.options.find((o) => /^(deny|decline|reject|cancel)$/.test(o.id))
          await base.write(
            id,
            deny
              ? { type: 'permission_response', id: event.id, optionId: deny.id }
              : { type: 'interrupt' }
          )
        }
      }
    )
  })
  const offRemoved = options.subscribeRemoved?.((id) => requests.cancelSession(id))
  return {
    close: () => {
      off()
      offSettled()
      offUpdated()
      offRemoved?.()
    },
    createHosted,
    port: {
      snapshot: () => requests.snapshot(),
      resolve: (input) => requests.resolve(input),
      subscribe: (listener) => requests.subscribe(listener),
      createHosted,
      resultAfter: (requestId, sessionId, waitMs) =>
        requests.resultAfter(requestId, sessionId, waitMs),
      setAnswers: (input) => requests.setAnswers(input)
    },
    host: {
      ...base,
      subscribe: (id, listener) => {
        const seen = new Set<string>()
        const off = base.subscribe(id, (stream) => {
          if (stream.kind === 'event' && stream.event.type === 'permission_request')
            seen.add(stream.event.id)
          listener(stream)
        })
        for (const request of requests.snapshot().pending)
          if (
            request.sessionId === id &&
            request.providerRequestId &&
            !seen.has(request.providerRequestId)
          ) {
            listener({ kind: 'event', event: eventOf(request) })
            const draft = draftEventOf(request, requests.draftOf(request.id))
            if (draft) listener({ kind: 'event', event: draft })
          }
        return off
      },
      write: async (id, input) => {
        if (input.type !== 'permission_response') return base.write(id, input)
        const request = requests.native(id, input.id)
        if (!request)
          throw new RequestRejected({ code: 'not_found', message: REQUEST_GONE.notFound })
        const { accepted } = await requests.resolve({
          requestId: request.id,
          response: {
            type: 'permission',
            optionId: input.optionId,
            ...(input.answers && { answers: input.answers })
          }
        })
        // Another client answered first, or the provider dropped the request.
        // Refused, as a local adapter refuses a stale answer: the view that
        // sent it must not record an answer the agent never received.
        if (!accepted) throw new RequestRejected({ code: 'closed', message: REQUEST_GONE.settled })
      },
      stop: async (id) => {
        await base.stop(id)
        requests.cancelSession(id)
      },
      restart: async (id, account, resend) => {
        requests.cancelSession(id)
        return base.restart(id, account, resend)
      }
    }
  }
}
