import type { SessionHostService } from '@clave/server'
import type { SessionEvent, SessionStream } from '@clave/contract/sessions'
import { RequestRejected, type PendingRequest } from '../../../packages/contract/src/requests'
import type { PendingRequests } from '../../../packages/server/src/requests/service'

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

/** Add request ownership around the frozen lifecycle host. The global stream
 * subscription exists before any client, and never makes stopped sessions ready. */
export function requestAwareSessionHost(options: {
  host: SessionHostService
  requests: PendingRequests
  subscribeAll: (listener: (id: string, value: SessionStream) => void) => () => void
  subscribeRemoved?: (listener: (id: string) => void) => () => void
}): { host: SessionHostService; close: () => void } {
  const { host: base, requests } = options
  const off = options.subscribeAll((id, stream) => {
    if (stream.kind !== 'event') return
    const event = stream.event
    if (event.type === 'state_change' && event.state === 'ended') requests.cancelSession(id)
    if (
      (event.type === 'state_change' && event.state === 'done') ||
      event.type === 'turn_interrupted'
    )
      requests.cancelNative(id)
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
      questions?: Array<{ question?: unknown; isSecret?: unknown }>
    } | null
    const secretQuestions =
      event.toolName === 'item/tool/requestUserInput' && Array.isArray(input?.questions)
        ? input.questions
            .filter((q) => q.isSecret === true && typeof q.question === 'string')
            .map((q) => String(q.question))
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
      offRemoved?.()
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
          )
            listener({ kind: 'event', event: eventOf(request) })
        return off
      },
      write: async (id, input) => {
        if (input.type !== 'permission_response') return base.write(id, input)
        const request = requests.native(id, input.id)
        if (!request)
          throw new RequestRejected({ code: 'not_found', message: 'No such provider request.' })
        await requests.resolve({
          requestId: request.id,
          response: {
            type: 'permission',
            optionId: input.optionId,
            ...(input.answers && { answers: input.answers })
          }
        })
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
