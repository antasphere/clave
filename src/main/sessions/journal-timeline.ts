import { randomUUID } from 'node:crypto'
import type { HistoryItem, SessionEvent } from '../../shared/session-model'
import type { SessionPosition, TimelinePage } from '@clave/contract/timeline'
import { pageWindow } from './history'
import { SessionTimeline, type Timeline } from './timeline'
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
 *  captures during the replay read queue behind the prefix.
 *
 *  A file that cannot be opened or written (a full disk) never breaks the
 *  session or its views: the rest of the run goes on in memory, in a bounded
 *  `SessionTimeline`, as a manager with no directory keeps it. */
export class JournalTimeline implements Timeline {
  private readonly generation = randomUUID()
  private seeded = false
  private seeding = false
  private draining = false
  private seedError: unknown
  private file: TimelineFile | undefined
  /** The run's timeline once its file failed: every call goes to it. */
  private fallback: SessionTimeline | undefined
  private readonly pending: Pending[] = []

  /** `name`: what names the run's file in the one error a failure logs. */
  constructor(
    private readonly past: () => readonly HistoryItem[],
    private readonly open: () => TimelineFile,
    private readonly name = 'a chat timeline file'
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
    if (this.fallback) return this.fallback.initialize()
    if (this.seeded || this.seeding) return
    this.seeding = true
    try {
      // The launch replay, frozen before live captures drain behind it.
      let prefix: HistoryItem[] = []
      try {
        prefix = this.past().filter((item) => item.event.type !== 'provider_event')
      } catch (error) {
        // A replay that failed still leaves a file for the live events, as
        // the bounded timeline keeps them; the read answers this error.
        this.seedError = error
      }
      try {
        const file = this.open()
        this.file = file
        for (const item of prefix) file.append(item)
      } catch (error) {
        // No file for this run: the replay and the live events in memory,
        // which is what a manager with no directory keeps.
        const seedError = this.seedError
        this.seedError = undefined
        this.toMemory(error, () => {
          if (seedError !== undefined) throw seedError
          return prefix
        })
      }
    } finally {
      this.seeded = true
      this.seeding = false
    }
    this.drain()
  }

  capture(event: SessionEvent, deliver: Pending['deliver']): void {
    if (this.fallback) return this.fallback.capture(event, deliver)
    this.pending.push({ event, at: Date.now(), deliver })
    this.initialize()
    this.drain()
  }

  private drain(): void {
    if (this.seeding || this.draining) return
    this.draining = true
    try {
      while (this.pending.length && !this.fallback) {
        const next = this.pending[0]
        let position: SessionPosition
        try {
          position = this.append(next.event, next.at)
        } catch (error) {
          // The file failed mid-run: what it holds is no longer the whole
          // run, so the rest of it goes on in memory, marked incomplete.
          this.toMemory(error, () => [], true)
          break
        }
        this.pending.shift()
        next.deliver(position)
      }
    } finally {
      this.draining = false
    }
    const fallback = this.fallback
    if (fallback)
      while (this.pending.length) {
        const next = this.pending.shift()!
        fallback.capture(next.event, next.deliver)
      }
  }

  /** The rest of the run in memory, its file released, said once. */
  private toMemory(error: unknown, past: () => readonly HistoryItem[], incomplete = false): void {
    console.error(
      `Keeping ${this.name} in memory for the rest of this run:`,
      error instanceof Error ? error.message : String(error)
    )
    try {
      this.file?.close()
    } catch {
      // Released already, or never opened: nothing more to free.
    }
    this.file = undefined
    this.fallback = new SessionTimeline(past, incomplete)
    this.fallback.initialize()
  }

  private append(event: SessionEvent, at?: number): SessionPosition {
    const file = this.file!
    file.append({ event, ...(at !== undefined && { at }) })
    return { generation: this.generation, sequence: file.length }
  }

  read(before?: number, limit?: number): TimelinePage {
    if (this.fallback) return this.fallback.read(before, limit)
    this.initialize()
    if (this.fallback) return (this.fallback as SessionTimeline).read(before, limit)
    if (this.seedError !== undefined) throw this.seedError
    const file = this.file!
    const end = before === undefined ? file.length : Math.max(0, Math.min(before - 1, file.length))
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
    if (this.fallback) return
    this.file?.close()
  }
}
