import { randomUUID } from 'node:crypto'
import type { HistoryItem, SessionEvent } from '../../shared/session-model'
import type { SessionPosition, TimelinePage } from '@clave/contract/timeline'
import { pageWindow } from './history'
import type { Timeline } from './timeline'
import type { TimelineFile } from './timeline-store'

interface Pending {
  event: SessionEvent
  at: number
  deliver: (position: SessionPosition) => void
}

/** A chat's ordered past, whole, in one append-only file per run
 *  (PRDCT-4666): the launch replay first, then every live event. Nothing is
 *  evicted, so a reader that arrives late (another desktop, an agent, the
 *  same desktop after a restart) pages back to the first item. Sequence is
 *  index + 1. The seeding protocol is `SessionTimeline`'s: reentrant
 *  captures during the replay read queue behind the prefix. */
export class JournalTimeline implements Timeline {
  private readonly generation = randomUUID()
  private seeded = false
  private seeding = false
  private draining = false
  private seedError: unknown
  private file: TimelineFile | undefined
  private readonly pending: Pending[] = []

  constructor(
    private readonly past: () => readonly HistoryItem[],
    private readonly open: () => TimelineFile
  ) {}

  /** A read-only timeline over a finished run: a stopped tab's whole past. */
  static stopped(file: TimelineFile): Timeline {
    const timeline = new JournalTimeline(
      () => [],
      () => file
    )
    timeline.file = file
    timeline.seeded = true
    return {
      initialize: () => {},
      capture: () => {
        throw new Error('A stopped session takes no new events')
      },
      read: (before, limit) => timeline.read(before, limit),
      close: () => timeline.close()
    }
  }

  initialize(): void {
    if (this.seeded || this.seeding) return
    this.seeding = true
    try {
      // The launch replay, frozen before live captures drain behind it.
      let prefix: HistoryItem[] = []
      try {
        prefix = this.past().filter((item) => item.event.type !== 'provider_event')
      } catch (error) {
        this.seedError = error
      }
      // A replay that failed still leaves a file for the live events, as the
      // bounded timeline keeps them; the read answers the seed's error.
      const file = this.open()
      this.file = file
      for (const item of prefix) file.append(item)
    } catch (error) {
      this.seedError ??= error
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
    // A seed that failed keeps nothing: its error is the read's answer.
    if (!this.file) {
      while (this.pending.length)
        this.pending.shift()!.deliver({ generation: this.generation, sequence: 0 })
      return
    }
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
    const file = this.file!
    file.append({ event, ...(at !== undefined && { at }) })
    return { generation: this.generation, sequence: file.length }
  }

  read(before?: number, limit?: number): TimelinePage {
    this.initialize()
    if (this.seedError !== undefined) throw this.seedError
    const file = this.file!
    const end =
      before === undefined ? file.length : Math.max(0, Math.min(before - 1, file.length))
    const page = pageWindow(file, end, limit)
    return {
      items: page.items.map((item, i) => ({
        ...item,
        position: { generation: this.generation, sequence: page.start + i + 1 }
      })),
      before: page.start > 0 ? page.start + 1 : null,
      cursor: { generation: this.generation, sequence: file.length },
      truncated: false
    }
  }

  close(): void {
    this.file?.close()
  }
}
