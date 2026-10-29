/**
 * The dispatcher (the mobile wave, lane B; decision 9 of the spec): it
 * watches the server's own flow and sends one notification per event, to
 * every push target, through the transport of the target's platform.
 *
 * Where each category comes from:
 * - `question`, `permission`, `secret`: on a server with a pending-requests
 *   service (the standalone entry), every pending request as it appears,
 *   read off the service's change signal (`requestsChanged`); on a server
 *   without one (the in-process server, which answers CapabilityUnavailable
 *   for requests), the `permission_request` frames of the sessions' streams
 *   (`streamEvent`). Never both: a frame is ignored where a service exists,
 *   since the service makes a pending request of that same frame.
 * - `finished`: a session's state reaching `done` (`sessionState`, off the
 *   server's own `session.state_changed` event).
 * - `failed`: a fatal `error` frame, or a process ending with a code other
 *   than 0 that no stop or restart asked for (`exited`); once per session,
 *   until it works again.
 * - `account_limit`: a usage read (`usageRead`, off `usage.claude_read` and
 *   `usage.codex_read`) whose tightest window has five percent or less left
 *   or is called critical, once per account, window and reset time.
 *
 * A request waits `requestGraceMs` before its push leaves and is pushed only
 * when it is still pending then: a question answered on the Mac in that
 * time is never pushed. The push carries the id the phone resolves the
 * request with on this server as its collapse id, so a later push about the
 * same request replaces the earlier one on the phone. A token the platform
 * reports gone is forgotten through the targets port. Nothing in a payload
 * comes from outside `payload.ts`.
 */
import { Effect } from 'effect'
import { PushTargetNotFound, type NotificationPayload } from '@clave/contract/notify'
import type { PendingRequest, RequestSnapshot } from '@clave/contract/requests'
import type { AgentState, SessionEvent } from '@clave/contract/sessions'
import type { PushTarget, PushTargets, PushTransports, SendResult } from './port'
import {
  type NotificationSubject,
  accountLimitPayload,
  closedPayload,
  failedPayload,
  finishedPayload,
  permissionPayload,
  questionPayload,
  secretPayload,
  testPayload
} from './payload'

/** One window of a usage read, as the contract's `UsageWindowView` carries it. */
export interface UsageWindowLike {
  readonly key: string
  readonly label: string
  readonly usedPercentage: number
  readonly resetsAt: number | null
  readonly severity: 'normal' | 'warning' | 'critical' | null
}
/** A usage read: windows, or an error and no windows. */
export type UsageReadLike =
  | { readonly windows: ReadonlyArray<UsageWindowLike> }
  | { readonly error: string }

/** An account is at its limit when its tightest window has this much left or less. */
export const LIMIT_LEFT_PERCENT = 5
/** How long a request waits before its push leaves, by default. */
export const REQUEST_GRACE_MS = 1500
/** How many request keys and limit keys are remembered. */
const KEYS_MAX = 2048

export interface NotifierDeps {
  readonly serverId: string
  readonly serverName: string
  readonly targets: PushTargets
  readonly transports: PushTransports
  readonly fake: boolean
  /** The session's title and folder, from the host; undefined when unknown. */
  readonly session: (id: string) => { readonly title: string; readonly cwd: string } | undefined
  /** The registered workspace the folder belongs to, by name. */
  readonly workspaceName: (cwd: string) => Promise<string | undefined>
  /** The account's label as the settings know it. */
  readonly accountLabel: (
    provider: 'claude' | 'codex',
    accountId: string
  ) => Promise<string | undefined>
  /** The pending requests, or null on a server with no requests service. */
  readonly pendingRequests: (() => RequestSnapshot) | null
  readonly requestGraceMs?: number
  readonly log: (line: string) => void
}

/** The tightest window: the most severe, then the most used (the pool's rule). */
export function tightestWindow(windows: ReadonlyArray<UsageWindowLike>): UsageWindowLike | null {
  const rank = { normal: 0, warning: 1, critical: 2 } as const
  let best: UsageWindowLike | null = null
  for (const w of windows) {
    if (!best) best = w
    else {
      const a = rank[w.severity ?? 'normal'] ?? 0
      const b = rank[best.severity ?? 'normal'] ?? 0
      if (a > b || (a === b && w.usedPercentage > best.usedPercentage)) best = w
    }
  }
  return best
}

/** A set that forgets its oldest member past `max`. */
class BoundedSet {
  private readonly set = new Set<string>()
  constructor(private readonly max: number) {}
  has(key: string): boolean {
    return this.set.has(key)
  }
  add(key: string): void {
    this.set.delete(key)
    this.set.add(key)
    while (this.set.size > this.max) {
      const oldest = this.set.keys().next().value
      if (oldest === undefined) break
      this.set.delete(oldest)
    }
  }
  delete(key: string): void {
    this.set.delete(key)
  }
}

const basename = (cwd: string): string => cwd.split('/').filter(Boolean).pop() ?? cwd

export class Notifier {
  /** Request keys already scheduled: one push per request, whichever road. */
  private readonly scheduled = new BoundedSet(KEYS_MAX)
  /** Frame keys answered or cancelled before their push left. */
  private readonly settled = new BoundedSet(KEYS_MAX)
  /** The frame keys open per session, to settle them when the turn ends. */
  private readonly openFrames = new Map<string, Set<string>>()
  /** The pending request ids seen in the last snapshot. */
  private readonly knownPending = new Set<string>()
  /** Sessions with a `failed` push outstanding. */
  private readonly failedSent = new Set<string>()
  /** Account limits already pushed, by account, window and reset time. */
  private readonly limitSent = new BoundedSet(KEYS_MAX)
  /** What a session was last known as, for a push after it is gone. */
  private readonly subjects = new Map<string, { title: string; cwd: string }>()
  private readonly offLogged = new Set<string>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly inFlight = new Set<Promise<void>>()
  private closed = false

  constructor(private readonly deps: NotifierDeps) {}

  // ── The pending requests (a server with a requests service) ──

  /** The service changed: every request not seen before is scheduled, every
   *  one gone is settled. */
  requestsChanged(): void {
    if (!this.deps.pendingRequests || this.closed) return
    let snapshot: RequestSnapshot
    try {
      snapshot = this.deps.pendingRequests()
    } catch {
      return
    }
    const ids = new Set(snapshot.pending.map((r) => r.id))
    for (const request of snapshot.pending) {
      if (this.knownPending.has(request.id)) continue
      this.knownPending.add(request.id)
      this.remember(request.sessionId)
      this.schedule(`request:${request.id}`, async () => {
        // Still pending when the push leaves, or not sent at all.
        const current = this.deps.pendingRequests?.().pending.find((r) => r.id === request.id)
        return current ? this.requestPayload(current) : null
      })
    }
    for (const id of [...this.knownPending])
      if (!ids.has(id)) {
        this.knownPending.delete(id)
        this.settled.add(`request:${id}`)
      }
  }

  private async requestPayload(request: PendingRequest): Promise<NotificationPayload> {
    const subject = await this.subjectOf(request.sessionId)
    switch (request.kind) {
      case 'clarification':
        return questionPayload(subject, request.id, request.questions ?? [])
      case 'secret':
        return secretPayload(subject, request.id, request.description)
      case 'permission':
        return permissionPayload(
          subject,
          request.id,
          request.description,
          request.options ?? [],
          request.toolName
        )
    }
  }

  // ── The sessions' streams (every server) ──

  /** A frame of a session's stream: a permission_request where no requests
   *  service exists, a fatal error, the end of a turn that settles the
   *  session's open frames. */
  streamEvent(sessionId: string, event: SessionEvent): void {
    if (this.closed) return
    this.remember(sessionId)
    if (event.type === 'permission_request') {
      if (this.deps.pendingRequests) return
      const key = `frame:${sessionId}:${event.id}`
      const open = this.openFrames.get(sessionId) ?? new Set<string>()
      open.add(key)
      this.openFrames.set(sessionId, open)
      const frame = event
      this.schedule(key, async () => {
        if (this.settled.has(key)) return null
        const subject = await this.subjectOf(sessionId)
        return frame.questions?.length
          ? questionPayload(subject, frame.id, frame.questions)
          : permissionPayload(subject, frame.id, frame.description, frame.options, frame.toolName)
      })
      return
    }
    if (event.type === 'error' && event.fatal) {
      void this.failed(sessionId)
      return
    }
    if (event.type === 'turn_interrupted') return this.settleFrames(sessionId)
    if (event.type === 'state_change') {
      if (event.state === 'done' || event.state === 'ended') this.settleFrames(sessionId)
      if (event.state === 'working' || event.state === 'idle') this.failedSent.delete(sessionId)
    }
  }

  /** A permission_response reached the session: the frame's push is not sent
   *  when it has not left yet. */
  requestAnswered(sessionId: string, providerRequestId: string): void {
    const key = `frame:${sessionId}:${providerRequestId}`
    this.settled.add(key)
    this.openFrames.get(sessionId)?.delete(key)
  }

  private settleFrames(sessionId: string): void {
    const open = this.openFrames.get(sessionId)
    if (!open) return
    for (const key of open) this.settled.add(key)
    this.openFrames.delete(sessionId)
  }

  // ── The server's events ──

  /** `session.state_changed`: done is finished; working again clears a failure. */
  sessionState(sessionId: string, state: AgentState): void {
    if (this.closed) return
    this.remember(sessionId)
    if (state === 'done') {
      void this.track(this.subjectOf(sessionId).then((s) => this.send(finishedPayload(s))))
    } else if (state === 'working' || state === 'idle') this.failedSent.delete(sessionId)
  }

  /** The session's process ended: a code other than 0 nobody asked for is a failure. */
  exited(sessionId: string, code: number, deliberate: boolean): void {
    if (this.closed) return
    if (code !== 0 && !deliberate) void this.failed(sessionId)
  }

  /** A usage read landed: the account's tightest window at or under the
   *  limit is pushed once per account, window and reset time. */
  usageRead(provider: 'claude' | 'codex', accountId: string, read: UsageReadLike): void {
    if (this.closed || !('windows' in read) || read.windows.length === 0) return
    const tightest = tightestWindow(read.windows)
    if (!tightest) return
    const left = Math.max(0, Math.round(100 - tightest.usedPercentage))
    if (tightest.severity !== 'critical' && left > LIMIT_LEFT_PERCENT) return
    const key = `${provider}:${accountId}:${tightest.key}:${tightest.resetsAt ?? 'none'}`
    if (this.limitSent.has(key)) return
    this.limitSent.add(key)
    void this.track(
      (async () => {
        const label =
          (await this.deps.accountLabel(provider, accountId).catch(() => undefined)) ?? accountId
        await this.send(accountLimitPayload(this.deps, label, tightest.label, left))
      })()
    )
  }

  // ── The owner's routes ──

  async status(): Promise<{
    transports: { ios: boolean; android: boolean }
    fake: boolean
    targets: number
    serverName: string
  }> {
    const targets = await Effect.runPromise(this.deps.targets.list())
    return {
      transports: {
        ios: this.deps.transports.ios !== undefined,
        android: this.deps.transports.android !== undefined
      },
      fake: this.deps.fake,
      targets: targets.length,
      serverName: this.deps.serverName
    }
  }

  /** One test notification to one phone; throws `PushTargetNotFound`. */
  async test(deviceId: string): Promise<{
    deviceId: string
    platform: PushTarget['platform']
    result: SendResult
  }> {
    const targets = await Effect.runPromise(this.deps.targets.list())
    const target = targets.find((t) => t.deviceId === deviceId)
    if (!target) throw new PushTargetNotFound({ deviceId })
    const result = await this.sendTo(target, closedPayload(testPayload(this.deps, deviceId)))
    return { deviceId, platform: target.platform, result }
  }

  /** Every send started so far has answered (for the tests). */
  async flush(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.all([...this.inFlight])
  }

  close(): void {
    this.closed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }

  // ── The mechanics ──

  private remember(sessionId: string): void {
    const session = this.deps.session(sessionId)
    if (session) this.subjects.set(sessionId, { title: session.title, cwd: session.cwd })
  }

  private async subjectOf(sessionId: string): Promise<NotificationSubject> {
    const known = this.deps.session(sessionId) ?? this.subjects.get(sessionId)
    const title = known?.title || sessionId
    const cwd = known?.cwd ?? ''
    const workspace = cwd ? await this.deps.workspaceName(cwd).catch(() => undefined) : undefined
    const workspaceName = workspace ?? (cwd ? basename(cwd) : undefined)
    return {
      serverId: this.deps.serverId,
      serverName: this.deps.serverName,
      sessionId,
      sessionTitle: title,
      ...(workspaceName !== undefined && { workspaceName })
    }
  }

  private async failed(sessionId: string): Promise<void> {
    if (this.failedSent.has(sessionId)) return
    this.failedSent.add(sessionId)
    await this.track(this.subjectOf(sessionId).then((s) => this.send(failedPayload(s))))
  }

  /** One push per key: scheduled after the grace, built then, dropped when
   *  the builder answers null (the request is no longer pending). */
  private schedule(key: string, build: () => Promise<NotificationPayload | null>): void {
    if (this.scheduled.has(key)) return
    this.scheduled.add(key)
    const grace = this.deps.requestGraceMs ?? REQUEST_GRACE_MS
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (this.closed) return
      void this.track(
        build().then((payload) =>
          payload ? this.send(payload, () => this.requestStillOpen(key)) : undefined
        )
      )
    }, grace)
    this.timers.add(timer)
  }

  private track(work: Promise<void>): Promise<void> {
    const tracked = work
      .catch((error) => this.deps.log(`push: a send failed: ${messageOf(error)}`))
      .finally(() => this.inFlight.delete(tracked))
    this.inFlight.add(tracked)
    return tracked
  }

  private requestStillOpen(key: string): boolean {
    if (this.closed || this.settled.has(key)) return false
    if (!key.startsWith('request:')) return true
    try {
      return this.deps.pendingRequests?.().pending.some((r) => `request:${r.id}` === key) ?? false
    } catch {
      return false
    }
  }

  private async send(
    payload: NotificationPayload,
    stillOpen = (): boolean => !this.closed
  ): Promise<void> {
    const closed = closedPayload(payload)
    const targets = await Effect.runPromise(this.deps.targets.list())
    await Promise.all(
      targets.map((target) => (stillOpen() ? this.sendTo(target, closed) : undefined))
    )
  }

  private async sendTo(target: PushTarget, payload: NotificationPayload): Promise<SendResult> {
    const transport = this.deps.transports[target.platform]
    if (!transport) {
      if (!this.offLogged.has(target.platform)) {
        this.offLogged.add(target.platform)
        this.deps.log(`push: no transport configured for ${target.platform}, nothing sent`)
      }
      return { outcome: 'failed', reason: `no transport configured for ${target.platform}` }
    }
    let result: SendResult
    try {
      result = await Effect.runPromise(transport.send(target, payload))
    } catch (error) {
      result = { outcome: 'failed', reason: messageOf(error) }
    }
    if (result.outcome === 'gone') {
      await Effect.runPromise(this.deps.targets.forget(target.deviceId, target.token)).catch(
        (error) =>
          this.deps.log(`push: could not forget device ${target.deviceId}: ${messageOf(error)}`)
      )
      this.deps.log(
        `push: ${target.platform} token of device ${target.deviceId} is gone, forgotten`
      )
    } else if (result.outcome === 'failed') {
      this.deps.log(
        `push: ${target.platform} send to device ${target.deviceId} failed: ${result.reason}`
      )
    }
    return result
  }
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)
