import type { ServerEventEnvelope } from '@clave/contract/events'
import type {
  HostedRequestInput,
  PendingRequest,
  RequestResultView,
  RequestSnapshot,
  ResolveRequestInput,
  SetRequestAnswersInput
} from '../../contract/src/requests'
import type { Call } from './call'
import type { PushStatus } from './push-client'

interface RequestPush {
  onEvent: (listener: (event: ServerEventEnvelope) => void) => () => void
  onStatus: (listener: (status: PushStatus) => void) => () => void
}
export interface RequestsClient {
  readonly list: () => Promise<RequestSnapshot>
  readonly resolve: (input: ResolveRequestInput) => Promise<{ accepted: boolean }>
  /** A request an agent tool puts to the person (PRDCT-4157), and where it stands. */
  readonly create: (input: HostedRequestInput) => Promise<PendingRequest>
  readonly result: (input: {
    requestId: string
    sessionId: string
    waitMs?: number
  }) => Promise<RequestResultView>
  /** The agent writes to a form it asked (PRDCT-4157). */
  readonly set: (input: SetRequestAnswersInput) => Promise<RequestResultView>
  readonly watch: (
    push: RequestPush,
    listener: (snapshot: RequestSnapshot) => void,
    onError: (error: unknown) => void
  ) => () => void
}
/** Exactly one endpoint owns each watcher. E tags it with its fleet source. */
export const requestsClient = (call: Call, resolutionCall: Call = call): RequestsClient => {
  const list = (): Promise<RequestSnapshot> => call((c) => c.requests.list({ payload: {} }))
  return {
    list,
    resolve: (payload) => resolutionCall((c) => c.requests.resolve({ payload })),
    create: (payload) => call((c) => c.requests.create({ payload })),
    result: (payload) => call((c) => c.requests.result({ payload })),
    set: (payload) => call((c) => c.requests.set({ payload })),
    watch: (push, listener, onError) => {
      let stopped = false
      let generation = 0
      let latest = -1
      const refresh = async (): Promise<void> => {
        const run = ++generation
        try {
          const snapshot = await list()
          if (stopped || run !== generation || snapshot.revision < latest) return
          latest = snapshot.revision
          listener(snapshot)
        } catch (error) {
          if (!stopped && run === generation) onError(error)
        }
      }
      const offEvent = push.onEvent(({ event }) => {
        if (event._tag === 'requests.changed') void refresh()
      })
      const offStatus = push.onStatus((status) => {
        if (status === 'open') {
          latest = -1
          void refresh()
        }
      })
      void refresh()
      return () => {
        stopped = true
        offEvent()
        offStatus()
      }
    }
  }
}
