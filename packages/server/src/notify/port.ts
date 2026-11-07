/**
 * The notify domain's ports (the mobile wave, lane B): where the phones are,
 * and how a notification reaches one.
 *
 * `PushTargets` is the seam with the devices domain (lane A of the same wave):
 * every paired phone with its platform and the token it registered, and the
 * way to forget a token the platform reported gone. The interface is written
 * verbatim in both lanes' briefs; lane A's `devicesPushTargets` implements it
 * on the integration branch, and until then the recording fake (`fake.ts`)
 * stands in. `PushTransport` is one platform's road: APNs for an iPhone
 * (`apns.ts`), FCM for an Android phone (`fcm.ts`), the fake in the tests.
 * The entries hand both through `ServerPorts` (`../ports.ts`); a port left
 * out is the domain's `none`, which holds no phone and sends nothing.
 */
import { Context, Effect, Layer } from 'effect'
import type { NotificationPayload } from '@clave/contract/notify'

export interface PushTarget {
  readonly deviceId: string
  readonly platform: 'ios' | 'android'
  readonly token: string
}
export interface PushTargets {
  readonly list: () => Effect.Effect<ReadonlyArray<PushTarget>>
  readonly forget: (deviceId: string, token: string) => Effect.Effect<void>
}

/** What one send answered: delivered, the token gone (APNs 410 or
 *  BadDeviceToken, FCM UNREGISTERED: the target forgets it), or failed with
 *  a reason that never carries the token. */
export type SendResult =
  | { readonly outcome: 'sent' }
  | { readonly outcome: 'gone' }
  | { readonly outcome: 'failed'; readonly reason: string }

export interface PushTransport {
  send(target: PushTarget, payload: NotificationPayload): Effect.Effect<SendResult>
}

/** One transport per platform; a platform left out sends nothing. */
export interface PushTransports {
  readonly ios?: PushTransport
  readonly android?: PushTransport
}

/** What an entry may say about the notifier beyond the ports: the name it
 *  signs with (the hostname otherwise), how long a request waits before its
 *  push leaves (1.5 s otherwise), and whether the fake stands in. */
export interface NotifyOptions {
  readonly serverName?: string
  readonly requestGraceMs?: number
  readonly fake?: boolean
}

export class PushTargetsPort extends Context.Tag('@clave/server/PushTargets')<
  PushTargetsPort,
  PushTargets
>() {
  static layer(service: PushTargets): Layer.Layer<PushTargetsPort> {
    return Layer.succeed(PushTargetsPort, service)
  }
  /** No phone paired: nothing to list, nothing to forget. */
  static readonly none: PushTargets = {
    list: () => Effect.succeed([]),
    forget: () => Effect.void
  }
}

export class PushTransportsPort extends Context.Tag('@clave/server/PushTransports')<
  PushTransportsPort,
  PushTransports
>() {
  static layer(service: PushTransports): Layer.Layer<PushTransportsPort> {
    return Layer.succeed(PushTransportsPort, service)
  }
  /** No credentials: neither platform can be reached. */
  static readonly none: PushTransports = {}
}

export class NotifyOptionsPort extends Context.Tag('@clave/server/NotifyOptions')<
  NotifyOptionsPort,
  NotifyOptions
>() {
  static layer(service: NotifyOptions): Layer.Layer<NotifyOptionsPort> {
    return Layer.succeed(NotifyOptionsPort, service)
  }
  static readonly none: NotifyOptions = {}
}
