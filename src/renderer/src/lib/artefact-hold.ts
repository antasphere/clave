/**
 * The loop that holds a session's artefact preview while its frame is shown
 * (PRDCT-4474): the first hold, a renewal at a third of the hold's time, a
 * new try ten seconds after a failure, and a release at the end.
 *
 * One hold call at a time. A wake-up (the server came back) during a call in
 * flight is remembered and runs ONE more call once that one has answered:
 * two calls at once could each mint a hold, and the first id, overwritten,
 * would never be released, its forward kept open until the window navigates.
 */

/** How often a refused or failed hold is tried again while the loop runs. */
export const HOLD_RETRY_MS = 10_000
/** The shortest wait before a renewal, whatever the hold's time. */
export const HOLD_RENEW_MIN_MS = 1_000

export interface HoldLoopDeps {
  hold: (holdId?: string) => Promise<{ url: string; holdId: string; ttlMs: number }>
  release: (holdId: string) => Promise<void>
  onUrl: (url: string) => void
  /** The FIRST hold was refused: the sentence to show. A renewal that fails says nothing. */
  onRefused: (message: string) => void
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
}

/** An IPC error's own sentence, without Electron's prefix. */
export const holdErrorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    ''
  )

export function startHoldLoop(deps: HoldLoopDeps): { wake(): void; stop(): void } {
  const setTimer = deps.setTimer ?? setTimeout
  const clearTimer = deps.clearTimer ?? clearTimeout
  let stopped = false
  let holdId: string | undefined
  let url: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  let again = false

  const release = (id: string): void => {
    void deps.release(id).catch(() => {})
  }
  const later = (ms: number): void => {
    timer = setTimer(() => {
      timer = undefined
      call()
    }, ms)
  }
  /** After an answer: the call a wake-up asked for meanwhile, else the timer. */
  const next = (ms: number): void => {
    if (again) {
      again = false
      call()
    } else later(ms)
  }

  function call(): void {
    if (stopped) return
    if (inFlight) {
      again = true
      return
    }
    if (timer !== undefined) clearTimer(timer)
    timer = undefined
    inFlight = true
    deps.hold(holdId).then(
      (answer) => {
        inFlight = false
        // Stopped while the call was out: its hold is nobody's, so it goes.
        if (stopped) return release(answer.holdId)
        holdId = answer.holdId
        // A renewal that answers another address (the server started the
        // preview again) moves the frame to it.
        if (answer.url !== url) {
          url = answer.url
          deps.onUrl(answer.url)
        }
        next(Math.max(HOLD_RENEW_MIN_MS, answer.ttlMs / 3))
      },
      (error: unknown) => {
        inFlight = false
        if (stopped) return
        // The first hold refused shows why; a renewal that fails keeps the
        // frame (the forward's own page says the server is away) and tries again.
        if (holdId === undefined) deps.onRefused(holdErrorMessage(error))
        next(HOLD_RETRY_MS)
      }
    )
  }

  call()
  return {
    wake: call,
    stop: () => {
      if (stopped) return
      stopped = true
      if (timer !== undefined) clearTimer(timer)
      timer = undefined
      if (holdId !== undefined) release(holdId)
    }
  }
}
