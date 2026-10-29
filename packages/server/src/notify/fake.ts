/**
 * The recording fake (the mobile wave, lane B): a transport that keeps every
 * send and answers what a test tells it, and a phone registry a test fills by
 * hand. Every unit test runs on these, and so does the end-to-end suite,
 * through `--push-fake` on the entry (`credentials.ts`) and the fixture route.
 * Nothing here reaches Apple or Google.
 */
import { Effect } from 'effect'
import type { NotificationPayload } from '@clave/contract/notify'
import type { PushTarget, PushTargets, PushTransport, PushTransports, SendResult } from './port'

export interface RecordedSend {
  readonly at: number
  readonly target: PushTarget
  readonly payload: NotificationPayload
  readonly result: SendResult
}

export class FakePushTransport implements PushTransport {
  readonly sent: RecordedSend[] = []
  /** What the next sends answer; `sent` unless a test says otherwise. */
  answer: (target: PushTarget, payload: NotificationPayload) => SendResult = () => ({
    outcome: 'sent'
  })
  send(target: PushTarget, payload: NotificationPayload): Effect.Effect<SendResult> {
    return Effect.sync(() => {
      const result = this.answer(target, payload)
      this.sent.push({ at: Date.now(), target, payload, result })
      return result
    })
  }
  /** The sends of one category, oldest first. */
  of(category: NotificationPayload['category']): RecordedSend[] {
    return this.sent.filter((s) => s.payload.category === category)
  }
}

export class FakePushTargets implements PushTargets {
  private readonly targets = new Map<string, PushTarget>()
  readonly forgotten: Array<{ deviceId: string; token: string }> = []
  add(target: PushTarget): void {
    this.targets.set(target.deviceId, target)
  }
  remove(deviceId: string): void {
    this.targets.delete(deviceId)
  }
  snapshot(): PushTarget[] {
    return [...this.targets.values()]
  }
  list = (): Effect.Effect<ReadonlyArray<PushTarget>> => Effect.sync(() => this.snapshot())
  forget = (deviceId: string, token: string): Effect.Effect<void> =>
    Effect.sync(() => {
      const target = this.targets.get(deviceId)
      if (target && target.token === token) this.targets.delete(deviceId)
      this.forgotten.push({ deviceId, token })
    })
}

export interface FakePush {
  readonly targets: FakePushTargets
  readonly transport: FakePushTransport
  readonly transports: PushTransports
}

/** One recording transport serving both platforms, and an empty registry. */
export function fakePush(): FakePush {
  const transport = new FakePushTransport()
  return {
    targets: new FakePushTargets(),
    transport,
    transports: { ios: transport, android: transport }
  }
}
