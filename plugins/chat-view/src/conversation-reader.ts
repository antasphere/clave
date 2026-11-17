import type { TimelinePage } from '@clave/contract/timeline'
import { inputRequestMeta } from '@clave/contract/input-kinds'
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
  reconnect(ready?: Promise<unknown>): void
  source(): HistorySource
}

type Frame = Extract<SessionStream, { kind: 'event' }>
export type ConversationItem = HistoryItem & { current?: boolean }
// A frame with no position is the host's current state, never the transcript:
// what a view that binds late is told (the session's state, its model, what
// runs in the background, what waits for the agent, the requests still open),
// and whatever a host tells that way next. A server that orders its transcript
// gives every event of it a position, so on such a stream the absence of one
// is the whole test. Which events those are is the host's business: the list
// of their types kept here until PRDCT-4664 was a second copy of that
// knowledge, and each time it fell behind (`session_meta` and
// `waiting_messages`, v3.0.0-beta.25) a conversation stopped loading for good.
const overlay = (frame: Frame): boolean => !frame.position
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
    page(page: HistoryPage, replace: boolean, truncated: boolean, preserve?: number): void
    event(item: ConversationItem): void
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
  // Unlike the connection cursor, this survives reconnect until a snapshot
  // commits. It names the prefix already reflected in the view's form state.
  let applied: SessionPosition | null = null
  let generation: string | null = null
  let snapshotGeneration: string | null = null
  let truncated = false
  let hasPage = false
  let buffered: Frame[] = []
  let bytes = 0
  // What the bounded handoff let go of the transcript: the highest position
  // per generation, and whether frames of a stream that orders nothing went
  // too. A snapshot answers for its own generation alone.
  const droppedAt = new Map<string, number>()
  let droppedUnordered = false
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
    droppedAt.clear()
    droppedUnordered = false
  }
  const sizeOf = (frame: Frame): number => JSON.stringify(frame).length * 2
  /** Whether this stream orders its transcript: a snapshot said so, or a
   *  frame carried a position. Only a server older than the timeline sends a
   *  transcript with none. */
  const ordering = (): boolean => mode === 'timeline' || generation !== null
  const discard = (frame: Frame): void => {
    const at = frame.position
    if (!at) droppedUnordered = true
    else if (at.sequence > (droppedAt.get(at.generation) ?? -1))
      droppedAt.set(at.generation, at.sequence)
  }
  const buffer = (frame: Frame): void => {
    const size = sizeOf(frame)
    if (buffered.length < HANDOFF_MAX_ITEMS && bytes + size <= HANDOFF_MAX_BYTES) {
      buffered.push(frame)
      bytes += size
      return
    }
    // A late duplicate can trigger the bound after higher positions arrived.
    // Cover every discarded position, including prefixes from earlier overflows.
    // The host's current state is not transcript and no snapshot holds it, so
    // on a stream that orders its transcript it stays: let go, a request still
    // open would never be drawn, and counted as lost transcript it refused
    // every snapshot from then on.
    const state: Frame[] = []
    for (const pending of [...buffered, frame]) {
      if (!pending.position && ordering()) state.push(pending)
      else discard(pending)
    }
    buffered = state
    bytes = state.reduce((sum, pending) => sum + sizeOf(pending), 0)
    // Current state alone past the bound: the newest words are the ones that
    // hold. Said as let go all the same, so a past read from a server that
    // turns out to order nothing never passes for whole.
    while (
      buffered.length > 1 &&
      (buffered.length > HANDOFF_MAX_ITEMS || bytes > HANDOFF_MAX_BYTES)
    ) {
      bytes -= sizeOf(buffered.shift()!)
      droppedUnordered = true
    }
  }
  const ordered = (at: SessionPosition): Frame[] => {
    const pending = new Map<number, Frame>()
    for (const frame of buffered) {
      // Current state has no place in the order: it is applied beside it.
      if (!frame.position) continue
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
    if (frame.position) applied = cursor = frame.position
    handlers.event({
      event: frame.event,
      ...(overlay(frame) &&
        frame.event.type === 'permission_request' &&
        inputRequestMeta(frame.event.input) && { current: true })
    })
  }
  const refresh = (): void => {
    if (stopped || !started) return
    read?.stop()
    const version = ++revision
    reading = true
    handlers.reading()
    read = readPast(
      async () => {
        const observedGeneration = generation
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
        if (
          timeline &&
          generation !== observedGeneration &&
          generation !== null &&
          timeline.cursor.generation !== generation
        )
          throw new Error('The conversation changed generation while its snapshot was read.')
        if (
          timeline &&
          applied?.generation === timeline.cursor.generation &&
          timeline.cursor.sequence < applied.sequence
        )
          throw new Error('The conversation snapshot is older than the live stream.')
        // A snapshot answers for its own generation: positions let go under
        // another one belong to a process this snapshot says is gone. A past
        // read from a server that orders nothing covers nothing let go.
        const lost = timeline ? droppedAt.get(timeline.cursor.generation) : undefined
        if (
          timeline
            ? lost !== undefined && lost > timeline.cursor.sequence
            : droppedAt.size > 0 || droppedUnordered
        )
          throw new Error('The snapshot does not cover the overflowing handoff buffer.')
        mode = timeline ? 'timeline' : 'legacy'
        // An unknown frame can be a late word from a stopped process. The
        // snapshot taken after it, not the frame, confirms which generation lives.
        if (timeline && generation && generation !== timeline.cursor.generation) retire(generation)
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
        const forms = new Map<string, number>()
        for (const frame of overlays)
          if (frame.event.type === 'permission_request' && inputRequestMeta(frame.event.input))
            forms.set(frame.event.id, buffered.indexOf(frame))
        const currentFill = (
          event: HistoryItem['event']
        ): event is Extract<HistoryItem['event'], { type: 'permission_updated' }> =>
          event.type === 'permission_updated' && !event.typed && !event.sent && forms.has(event.id)
        // A hosted request is followed by its complete current draft. Old
        // agent fills can still name fields the person cleared on the server.
        const newerFills = new Map<number, Frame>()
        let preserve: number | undefined
        if (timeline) {
          page = { ...page, items: page.items.filter((item) => !currentFill(item.event)) }
          if (applied?.generation === timeline.cursor.generation)
            preserve = timeline.items.filter(
              (item) =>
                !currentFill(item.event as HistoryItem['event']) &&
                item.position.sequence <= applied!.sequence
            ).length
          for (const [index, frame] of buffered.entries())
            if (
              currentFill(frame.event) &&
              index > forms.get(frame.event.id)! &&
              frame.position?.generation === timeline.cursor.generation &&
              frame.position.sequence <= timeline.cursor.sequence
            )
              newerFills.set(frame.position.sequence, frame)
        }
        clear()
        reading = false
        // Commit in this same continuation. Deferring the buffer copy to a
        // second promise callback would lose frames arriving between the two.
        handlers.page(page, timeline !== null || hasPage, truncated, preserve)
        applied = timeline?.cursor ?? null
        hasPage = true
        for (const frame of overlays) take(frame)
        // A write after the subscription's draft may already be covered by
        // this snapshot. Keep it once, without moving the snapshot cursor back.
        for (const [, frame] of [...newerFills].sort(([a], [b]) => a - b))
          handlers.event({ event: frame.event })
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
    reconnect: (ready) => {
      if (stopped) return
      cursor = null
      generation = null
      // The server this comes back to may not be the one it left (another
      // version, another machine under the same address): whether it orders
      // its transcript is its next snapshot's word, or its next frame's.
      mode = 'unknown'
      clear()
      if (!ready) refresh()
      else {
        read?.stop()
        const version = ++revision
        reading = true
        handlers.reading()
        void ready.then(
          () => {
            if (!stopped && revision === version) refresh()
          },
          (error) => {
            if (!stopped && revision === version) handlers.failed(error)
          }
        )
      }
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
