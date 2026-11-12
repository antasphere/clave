import type { TimelinePage } from '@clave/contract/timeline'
import type {
  HistoryItem,
  HistoryPage,
  SessionPosition,
  SessionStream
} from '../../../src/shared/session-model'
import { readPast, type PastClock, type PastReader } from './past'

export interface HistorySource {
  read(before: number, limit?: number): Promise<HistoryPage & { truncated?: boolean }>
  current(): boolean
  /** Retained history is incomplete, even when there is no older page. */
  truncated: boolean
}
export interface ConversationReader extends PastReader {
  start(): void
  stream(frame: SessionStream): void
  reconnect(): void
  source(): HistorySource
}

type Frame = Extract<SessionStream, { kind: 'event' }>
// The existing host wrappers send these current-state overlays at subscribe
// time, outside the manager's positioned transcript. They are not message
// identity and must not select legacy history or prevent a snapshot loading.
const overlay = (frame: Frame): boolean =>
  !frame.position &&
  [
    'state_change',
    'background_tasks',
    'permission_request',
    'permission_updated',
    'permission_withdrawn',
    'permission_explained'
  ].includes(frame.event.type)
// Only the subscribe/snapshot handoff is buffered here. The server owns
// retention and event identity; this is neither a cache nor a second timeline.
export const HANDOFF_MAX_ITEMS = 2000
export const HANDOFF_MAX_BYTES = 1024 * 1024

export function conversationReader(
  ports: {
    timeline(before?: number, limit?: number): Promise<TimelinePage | null>
    history(before?: number, limit?: number): Promise<HistoryPage>
  },
  handlers: {
    page(page: HistoryPage, replace: boolean, truncated: boolean): void
    event(item: HistoryItem): void
    reading(): void
    failed(error: unknown): void
  },
  clock?: PastClock
): ConversationReader {
  let stopped = false
  let started = false
  let revision = 0
  let reading = true
  let read: PastReader | null = null
  let mode: 'unknown' | 'timeline' | 'legacy' = 'unknown'
  let cursor: SessionPosition | null = null
  let generation: string | null = null
  let snapshotGeneration: string | null = null
  let truncated = false
  let hasPage = false
  let buffered: Frame[] = []
  let bytes = 0
  let dropped: SessionPosition | 'legacy' | null = null
  const retired = new Set<string>()
  const retire = (value: string): void => {
    retired.add(value)
    if (retired.size > 32) retired.delete(retired.values().next().value!)
  }
  const items = (page: TimelinePage): HistoryItem[] =>
    page.items.map((item) => ({
      event: item.event as HistoryItem['event'],
      ...(item.at !== undefined && { at: item.at })
    }))
  const clear = (): void => {
    buffered = []
    bytes = 0
    dropped = null
  }
  const buffer = (frame: Frame): void => {
    const size = JSON.stringify(frame).length * 2
    if (buffered.length >= HANDOFF_MAX_ITEMS || bytes + size > HANDOFF_MAX_BYTES) {
      buffered = []
      bytes = 0
      dropped = frame.position ?? 'legacy'
    } else {
      buffered.push(frame)
      bytes += size
    }
  }
  const ordered = (at: SessionPosition): Frame[] => {
    const pending = new Map<number, Frame>()
    for (const frame of buffered) {
      if (overlay(frame)) continue
      if (!frame.position) throw new Error('The session stream has no ordered position.')
      if (frame.position.generation === at.generation && frame.position.sequence > at.sequence)
        pending.set(frame.position.sequence, frame)
    }
    const tail = [...pending.values()].sort((a, b) => a.position!.sequence - b.position!.sequence)
    let next = at.sequence + 1
    for (const frame of tail)
      if (frame.position!.sequence !== next++)
        throw new Error('Conversation events are missing. Reading a fresh snapshot.')
    return tail
  }
  const take = (frame: Frame): void => {
    if (stopped) return
    if (frame.position) cursor = frame.position
    handlers.event({ event: frame.event })
  }
  const refresh = (): void => {
    if (stopped || !started) return
    read?.stop()
    const version = ++revision
    reading = true
    handlers.reading()
    read = readPast(
      async () => {
        const timeline = await ports.timeline()
        let page: HistoryPage
        let tail: Frame[]
        if (timeline === null) {
          page = await ports.history()
          tail = [...buffered]
        } else {
          page = { items: items(timeline), before: timeline.before }
          tail = ordered(timeline.cursor)
        }
        if (stopped || revision !== version) return
        if (timeline && generation !== null && timeline.cursor.generation !== generation)
          throw new Error('The conversation changed generation while its snapshot was read.')
        if (
          timeline &&
          cursor?.generation === timeline.cursor.generation &&
          timeline.cursor.sequence < cursor.sequence
        )
          throw new Error('The conversation snapshot is older than the live stream.')
        if (
          dropped !== null &&
          (!timeline ||
            dropped === 'legacy' ||
            dropped.generation !== timeline.cursor.generation ||
            dropped.sequence > timeline.cursor.sequence)
        )
          throw new Error('The snapshot does not cover the overflowing handoff buffer.')
        mode = timeline ? 'timeline' : 'legacy'
        generation = timeline?.cursor.generation ?? null
        if (generation && snapshotGeneration && generation !== snapshotGeneration)
          retire(snapshotGeneration)
        snapshotGeneration = generation
        if (generation) retired.delete(generation)
        cursor = timeline?.cursor ?? null
        truncated = timeline?.truncated ?? false
        const overlays = timeline
          ? buffered.filter((frame) => {
              if (!overlay(frame)) return false
              // A request handed over at subscribe can settle before the HTTP
              // snapshot is taken. Do not resurrect it outside the retained page.
              const event = frame.event
              return !(
                'id' in event &&
                timeline.items.some(
                  (item) =>
                    (item.event.type === 'permission_withdrawn' ||
                      (item.event.type === 'permission_updated' && item.event.sent)) &&
                    item.event.id === event.id
                )
              )
            })
          : []
        clear()
        reading = false
        // Commit in this same continuation. Deferring the buffer copy to a
        // second promise callback would lose frames arriving between the two.
        handlers.page(page, timeline !== null || hasPage, truncated)
        hasPage = true
        for (const frame of overlays) take(frame)
        // Entries replay at rest, but the current timeline can cover a live
        // state transition newer than the subscribe reply. Taking its last
        // state here restores that word without repeating any messages.
        const state = timeline?.items.findLast((item) => item.event.type === 'state_change')
        if (state) handlers.event({ event: state.event as HistoryItem['event'] })
        for (const frame of tail) take(frame)
      },
      {
        read: () => {},
        failed: (error) => {
          if (!stopped && revision === version) handlers.failed(error)
        }
      },
      clock
    )
  }
  return {
    start: () => {
      if (!started && !stopped) {
        started = true
        refresh()
      }
    },
    stream: (frame) => {
      if (stopped || frame.kind !== 'event') return
      // Raw provider notifications are not transcript events and have no
      // timeline position. They still reach the status/usage readers.
      if (frame.event.type === 'provider_event') {
        handlers.event({ event: frame.event })
        return
      }
      if (mode === 'legacy' && !reading) {
        take(frame)
        return
      }
      if (overlay(frame) && !reading) {
        take(frame)
        return
      }
      const position = frame.position
      if (position && retired.has(position.generation)) return
      if (position && generation !== null && position.generation !== generation) {
        // Bounded quarantine for frames from recently retired connections.
        retire(generation)
        cursor = null
        clear()
        generation = position.generation
        buffer(frame)
        refresh()
        return
      }
      if (position) {
        generation ??= position.generation
        if (cursor?.generation === position.generation && position.sequence <= cursor.sequence)
          return
      }
      buffer(frame)
      if (!reading && mode === 'timeline' && cursor) {
        try {
          const tail = ordered(cursor)
          clear()
          for (const next of tail) take(next)
        } catch {
          refresh()
        }
      }
    },
    reconnect: () => {
      if (stopped) return
      cursor = null
      generation = null
      clear()
      refresh()
    },
    retry: refresh,
    source: () => {
      const version = revision
      const from = cursor?.generation
      const sourceMode = mode
      const current = (): boolean => !stopped && !reading && version === revision
      return {
        current,
        get truncated() {
          return truncated
        },
        read: async (before, limit) => {
          if (!current()) throw new Error('Conversation changed. Try reading it again.')
          if (sourceMode === 'legacy') {
            const page = await ports.history(before, limit)
            if (!current()) throw new Error('Conversation changed. Try reading it again.')
            return page
          }
          const page = await ports.timeline(before, limit)
          if (!current() || page === null || page.cursor.generation !== from) {
            if (current()) {
              cursor = null
              generation = null
              clear()
              refresh()
            }
            throw new Error('Conversation changed generation. Try reading it again.')
          }
          truncated ||= page.truncated
          return { items: items(page), before: page.before, truncated }
        }
      }
    },
    stop: () => {
      stopped = true
      revision++
      read?.stop()
      clear()
    }
  }
}
