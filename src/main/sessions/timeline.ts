import { randomUUID } from 'node:crypto'
import type { HistoryItem, SessionEvent } from '../../shared/session-model'
import type { SessionPosition, TimelinePage } from '@clave/contract/timeline'
import { pageHistory } from './history'

export const TIMELINE_MAX_ITEMS = 2000
export const TIMELINE_MAX_BYTES = 1024 * 1024

type PositionedItem = HistoryItem & { position: SessionPosition }

interface Pending {
  event: SessionEvent
  at: number
  deliver: (position: SessionPosition) => void
}

/** One ordered view of the launch transcript and subsequent normalized events.
 * Seed before ready/write can append to the provider's transcript. Reentrant
 * emissions during that read queue behind the historical prefix. Neither text
 * nor timestamps identify an event. The bounded cache is process-local. */
export class SessionTimeline {
  private readonly generation = randomUUID()
  private sequence = 0
  private seeded = false
  private seeding = false
  private draining = false
  private seedError: unknown
  private readonly pending: Pending[] = []
  private readonly items: PositionedItem[] = []
  private readonly sizes: number[] = []
  private bytes = 0
  private truncated: boolean

  constructor(
    private readonly past: () => readonly HistoryItem[],
    incomplete = false
  ) {
    this.truncated = incomplete
  }

  initialize(): void {
    if (this.seeded || this.seeding) return
    this.seeding = true
    try {
      const past = this.past()
      for (const item of past)
        if (item.event.type !== 'provider_event') this.append(item.event, item.at)
    } catch (error) {
      this.seedError = error
    } finally {
      this.seeded = true
      this.seeding = false
    }
    this.drain()
  }

  capture(event: SessionEvent, deliver: Pending['deliver']): void {
    this.pending.push({ event, at: Date.now(), deliver })
    this.initialize()
    this.drain()
  }

  private drain(): void {
    if (this.seeding || this.draining) return
    this.draining = true
    try {
      while (this.pending.length) {
        const next = this.pending.shift()!
        next.deliver(this.append(next.event, next.at))
      }
    } finally {
      this.draining = false
    }
  }

  private append(event: SessionEvent, at?: number): SessionPosition {
    const position = { generation: this.generation, sequence: ++this.sequence }
    const item: PositionedItem = { event, ...(at !== undefined && { at }), position }
    const size = Buffer.byteLength(JSON.stringify(item))
    this.items.push(item)
    this.sizes.push(size)
    this.bytes += size
    while (this.items.length > TIMELINE_MAX_ITEMS || this.bytes > TIMELINE_MAX_BYTES) {
      this.items.shift()
      this.bytes -= this.sizes.shift()!
      this.truncated = true
    }
    return position
  }

  read(before?: number, limit?: number): TimelinePage {
    this.initialize()
    if (this.seedError !== undefined) throw this.seedError
    const index =
      before === undefined
        ? this.items.length
        : this.items.findIndex((item) => item.position.sequence >= before)
    const end = index === -1 ? this.items.length : index
    const page = pageHistory(this.items, end, limit)
    return {
      items: page.items as PositionedItem[],
      before: page.before === null ? null : this.items[page.before].position.sequence,
      cursor: { generation: this.generation, sequence: this.sequence },
      truncated: this.truncated
    }
  }
}
