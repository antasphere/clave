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
 * nor timestamps identify an event. Launch history is an immutable prefix;
 * only subsequent live events need the bounded process-local buffer. */
export class SessionTimeline {
  private readonly generation = randomUUID()
  private sequence = 0
  private seeded = false
  private seeding = false
  private draining = false
  private seedError: unknown
  private prefix: HistoryItem[] = []
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
      // Freeze membership before draining live captures. The adapter owns the
      // launch transcript already; keep its events, without copying them into
      // the evicting live buffer or rereading a transcript that can now grow.
      this.prefix = this.past().filter((item) => item.event.type !== 'provider_event')
      this.sequence = this.prefix.length
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
    const items = [...this.prefix, ...this.items]
    const sequenceAt = (i: number): number =>
      i < this.prefix.length ? i + 1 : this.items[i - this.prefix.length].position.sequence
    const index =
      before === undefined ? items.length : items.findIndex((_, i) => sequenceAt(i) >= before)
    const end = index === -1 ? items.length : index
    const page = pageHistory(items, end, limit)
    const start = end - page.items.length
    return {
      items: page.items.map((item, i) => ({
        ...item,
        position: { generation: this.generation, sequence: sequenceAt(start + i) }
      })),
      before: page.before === null ? null : sequenceAt(page.before),
      cursor: { generation: this.generation, sequence: this.sequence },
      truncated: this.truncated
    }
  }
}
