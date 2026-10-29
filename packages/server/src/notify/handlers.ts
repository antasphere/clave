/**
 * The notify domain's two routes (the mobile wave, lane B), the owner's:
 * `GET /notify/status` and `POST /notify/test`. Both sit behind the server's
 * bearer token like every route; a phone's device session (lane A of the
 * wave) is scoped to what a phone does and never reaches them.
 */
import { Effect } from 'effect'
import { CommandHandler, QueryHandler } from '@structure-ai/cqrs'
import { CapabilityUnavailable } from '@clave/contract/errors'
import { GetNotifyStatus, PushTargetNotFound, SendTestNotification } from '@clave/contract/notify'
import { Notify } from './live'

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const unavailable = (error: unknown): CapabilityUnavailable =>
  error instanceof CapabilityUnavailable
    ? error
    : new CapabilityUnavailable({ capability: 'notify', message: messageOf(error) })

export const notifyHandlers = [
  QueryHandler.make(GetNotifyStatus, () =>
    Effect.flatMap(Notify, (notifier) =>
      Effect.tryPromise({ try: () => notifier.status(), catch: unavailable })
    )
  ),
  CommandHandler.make(SendTestNotification, (payload) =>
    Effect.flatMap(Notify, (notifier) =>
      Effect.tryPromise({
        try: () => notifier.test(payload.deviceId),
        catch: (error) => (error instanceof PushTargetNotFound ? error : unavailable(error))
      })
    )
  )
] as const
