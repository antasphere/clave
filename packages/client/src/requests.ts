import type { ServerEventEnvelope } from '@clave/contract/events'
import type { RequestSnapshot, ResolveRequestInput } from '../../contract/src/requests'
import type { Call } from './call'
import type { PushStatus } from './push-client'

interface RequestPush {
  onEvent: (listener: (event: ServerEventEnvelope) => void) => () => void
  onStatus: (listener: (status: PushStatus) => void) => () => void
}
export interface RequestsClient {
  readonly list: () => Promise<RequestSnapshot>
  readonly resolve: (input: ResolveRequestInput) => Promise<{ accepted: boolean }>
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
