/** The waits between the attempts at reading a conversation's past: quick at
 *  first, for a server that was only busy, then every quarter minute. */
export const PAST_RETRY_MS: readonly number[] = [500, 1000, 2000, 4000, 8000]
export const PAST_RETRY_EVERY_MS = 15_000
/** How long a round keeps asking before the pane says it could not. */
export const PAST_RETRY_FOR_MS = 120_000

export interface PastClock {
  now(): number
  setTimeout(run: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const realClock: PastClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export interface PastReader {
  /** Ask now, a fresh round: the pane's Retry, or the server back. Nothing
   *  once the past is read. */
  retry(): void
  /** The pane is gone: no timer left, no answer taken. */
  stop(): void
}

/**
 * Read a conversation's past until it is read (PRDCT-3526). The pane asked
 * once and swallowed a failure, so a request lost while the separate server
 * was busy restoring left a resumed chat empty for good, the live turns
 * filling in after it. Now a failed read is asked again after each of
 * `PAST_RETRY_MS`, then every `PAST_RETRY_EVERY_MS`, until
 * `PAST_RETRY_FOR_MS` have passed since the round began; then `failed` is
 * called and the reader waits for `retry` (the pane's button, or the server
 * connection coming back). An answer is final, an empty one included: an
 * empty past is a fresh conversation, not a failure. One read in flight at
 * a time; an answer that lands after `stop` is dropped.
 */
export function readPast<T>(
  read: () => Promise<T>,
  handlers: { read(value: T): void; failed(error: unknown): void },
  clock: PastClock = realClock
): PastReader {
  let done = false
  let stopped = false
  let inFlight = false
  let timer: unknown = null
  let attempt = 0
  let started = 0
  let gaveUp = false

  const clear = (): void => {
    if (timer !== null) clock.clearTimeout(timer)
    timer = null
  }
  const ask = (): void => {
    if (done || stopped || inFlight) return
    clear()
    inFlight = true
    let settle: Promise<T>
    try {
      settle = read()
    } catch (error) {
      settle = Promise.reject(error)
    }
    settle.then(
      (value) => {
        inFlight = false
        if (stopped || done) return
        done = true
        clear()
        handlers.read(value)
      },
      (error) => {
        inFlight = false
        if (stopped || done) return
        const wait = PAST_RETRY_MS[attempt] ?? PAST_RETRY_EVERY_MS
        attempt += 1
        if (clock.now() - started + wait > PAST_RETRY_FOR_MS) {
          gaveUp = true
          handlers.failed(error)
          return
        }
        timer = clock.setTimeout(ask, wait)
      }
    )
  }
  const round = (): void => {
    attempt = 0
    gaveUp = false
    started = clock.now()
    ask()
  }
  round()
  return {
    retry: () => {
      if (done || stopped) return
      // A retry while a read is in flight waits for that read's answer.
      if (inFlight) return
      if (gaveUp || timer !== null) round()
    },
    stop: () => {
      stopped = true
      clear()
    }
  }
}

/** Where the pane stands with the past: asking, read (an empty past
 *  included), or a round spent without an answer. */
export type PastState = 'reading' | 'read' | 'failed'

/** What the transcript's head says: the failure with its Retry, the
 *  invitation of an empty conversation, or nothing. The invitation needs a
 *  past actually read: while asking, a Retry's new round included, and after
 *  a failure, the conversation is not known to be empty (round 1 of the
 *  lane's verifier: a Retry showed "Start a conversation" for two minutes). */
export function pastHead(
  past: PastState,
  entries: number,
  ended: boolean
): 'failed' | 'empty' | null {
  if (past === 'failed') return 'failed'
  if (past === 'read' && entries === 0 && !ended) return 'empty'
  return null
}

/** How the pane's past state moves: an answer reads it, a spent round fails
 *  it, and a Retry goes back to reading whatever it was, so the head says
 *  nothing until the new round answers (round 2 of the lane's verifier: the
 *  transition lived in the component and nothing pinned it). An answer or a
 *  failure arriving after the past was read changes nothing. */
export function pastStep(past: PastState, event: 'read' | 'failed' | 'retry'): PastState {
  if (event === 'retry') return past === 'read' ? 'read' : 'reading'
  if (past === 'read') return 'read'
  return event
}
