import type { KeyValueStore } from '../chat/drafts'
import { initialLaunchState } from '../navigation/persistence'
import { navigationStateOf, type DeepLink } from './deeplink'
import type { IncomingResponse } from './port'

export const PENDING_NOTIFICATION_KEY = 'clave.pending-notification'

/** One owner and one navigator. Responses may arrive before the stack mounts. */
export class NotificationInbox {
  private tail: Promise<void> = Promise.resolve()
  private readonly seen = new Set<string>()
  private queued: DeepLink | null = null
  private mounted = false
  private closed = false
  private navigate: ((link: DeepLink) => void) | undefined

  constructor(
    private readonly ports: {
      kv: KeyValueStore
      lastResponse: () => Promise<IncomingResponse | null>
      clearLastResponse: () => Promise<void>
      respond: (response: IncomingResponse) => Promise<DeepLink | null>
      navigate?: (link: DeepLink) => void
    }
  ) {}

  private enqueue(run: () => Promise<void>): Promise<void> {
    const next = this.tail.then(run)
    this.tail = next.catch(() => {})
    return next
  }

  receive(response: IncomingResponse): Promise<void> {
    return this.enqueue(async () => {
      if (this.closed) return
      const key = JSON.stringify([
        response.notification.request.identifier,
        response.notification.date,
        response.actionIdentifier
      ])
      if (this.seen.has(key)) return
      const link = await this.ports.respond(response)
      if (link) {
        await this.ports.kv.setItem(PENDING_NOTIFICATION_KEY, JSON.stringify(link))
        this.queued = link
      }
      this.seen.add(key)
      if (this.seen.size > 64) this.seen.delete(this.seen.values().next().value!)
      await this.ports.clearLastResponse()
      await this.flush()
    })
  }

  async initialState(
    machineId: string | null,
    url: string | null
  ): Promise<ReturnType<typeof initialLaunchState> | ReturnType<typeof navigationStateOf>> {
    const last = await this.ports.lastResponse()
    if (last) await this.receive(last)
    let state: ReturnType<typeof initialLaunchState> | ReturnType<typeof navigationStateOf> =
      initialLaunchState(machineId, url)
    await this.enqueue(async () => {
      const raw = await this.ports.kv.getItem(PENDING_NOTIFICATION_KEY)
      const link = this.queued ?? pendingLink(raw)
      this.queued = null
      if (raw !== null) await this.acknowledge(raw)
      // The platform's explicit URL wins, just as it does without notifications.
      if (!url?.startsWith('clave://') && link) state = navigationStateOf(link)
    })
    return state
  }

  ready(navigate = this.ports.navigate): Promise<void> {
    this.navigate = navigate
    this.mounted = true
    return this.enqueue(() => this.flush())
  }

  close(): void {
    this.closed = true
  }
  idle(): Promise<void> {
    return this.tail
  }

  private async acknowledge(raw: string): Promise<void> {
    if ((await this.ports.kv.getItem(PENDING_NOTIFICATION_KEY)) === raw)
      await this.ports.kv.removeItem(PENDING_NOTIFICATION_KEY)
  }

  private async flush(): Promise<void> {
    if (!this.mounted || this.closed || !this.queued || !this.navigate) return
    const link = this.queued
    this.queued = null
    this.navigate(link)
    await this.acknowledge(JSON.stringify(link))
  }
}

export function pendingLink(raw: string | null): DeepLink | null {
  if (!raw) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object') return null
    const link = value as Record<string, unknown>
    if (link.kind === 'machines' && typeof link.reason === 'string')
      return link as unknown as DeepLink
    if (typeof link.machineId !== 'string' || !link.machineId) return null
    if (link.kind === 'workspaces') return link as unknown as DeepLink
    if (link.kind === 'requests' && (link.requestId === null || typeof link.requestId === 'string'))
      return link as unknown as DeepLink
    if (
      link.kind === 'chat' &&
      typeof link.sessionId === 'string' &&
      link.sessionId &&
      typeof link.title === 'string'
    )
      return link as unknown as DeepLink
  } catch {
    /* A damaged pending link never prevents the account opening. */
  }
  return null
}
