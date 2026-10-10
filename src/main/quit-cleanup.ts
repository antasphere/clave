/**
 * The quit's waits, bounded (PRDCT-3375, PRDCT-3290).
 *
 * `before-quit` defers the quit until the sessions have shut down and the
 * server has stopped. Wave 2 saw one such quit hang for twenty-six minutes
 * and wave 3 one for thirteen, with nothing in the log to say which of the
 * two waits never settled. A ceiling alone would hide the stall; this one
 * names it: past `ceilingMs` the log says which waits are still pending, and
 * the quit goes on anyway. The hammer is the caller's (`index.ts`): a quit
 * that still does not end a moment later exits the process.
 *
 * Pure: no Electron, timers injectable, so a unit test drives it with fake
 * timers and a wait that never settles.
 */
export interface QuitWait {
  /** How the log names it: `the sessions' shutdown`, `the server's stop`. */
  readonly name: string
  readonly promise: Promise<unknown>
}

export interface QuitOutcome {
  /** How long the waits took, or the ceiling when they did not settle. */
  readonly ms: number
  /** The waits still pending when the ceiling passed; empty when all settled. */
  readonly pending: readonly string[]
}

export interface QuitCleanupOptions {
  readonly ceilingMs: number
  readonly log: (line: string) => void
  readonly now?: () => number
  readonly setTimeout?: typeof globalThis.setTimeout
  readonly clearTimeout?: typeof globalThis.clearTimeout
}

/** The ceiling of the app's quit cleanup. A quit with nothing wrong takes well
 *  under a second; the end-to-end harness bounds `app.close()` above this and
 *  its hammer (`tests/e2e/harness.mjs`), so the app always speaks first. */
export const QUIT_CEILING_MS = 8_000
/** How long after the cleanup the process may still be here before it is exited. */
export const QUIT_HAMMER_MS = 2_000

/**
 * Resolves once every wait has settled (a rejection is settled too: it is
 * logged, never thrown), or once `ceilingMs` passed, with the names of the
 * waits still pending written to the log and returned.
 */
export function awaitQuitWaits(
  waits: readonly QuitWait[],
  options: QuitCleanupOptions
): Promise<QuitOutcome> {
  const now = options.now ?? Date.now
  const schedule = options.setTimeout ?? globalThis.setTimeout
  const cancel = options.clearTimeout ?? globalThis.clearTimeout
  const started = now()
  const pending = new Set(waits.map((wait) => wait.name))
  return new Promise((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      cancel(timer)
      resolve({ ms: now() - started, pending: [...pending] })
    }
    const timer = schedule(() => {
      if (pending.size > 0)
        options.log(
          `[quit] still waiting after ${options.ceilingMs} ms on: ${[...pending].join(', ')}; quitting anyway`
        )
      finish()
    }, options.ceilingMs)
    if (pending.size === 0) finish()
    for (const wait of waits) {
      wait.promise
        .then(
          () => undefined,
          (error) => options.log(`[quit] ${wait.name} failed: ${String(error)}`)
        )
        .finally(() => {
          pending.delete(wait.name)
          if (pending.size === 0) finish()
        })
    }
  })
}

/**
 * The hammer: once the cleanup is over and the quit is asked for again, a
 * process still here `ms` later is exited with code 1, the log saying so. A
 * quit that reaches it is one that would otherwise never have ended, so what
 * `app.exit` skips (`will-quit`, the renderers' unload) is the price of
 * ending at all. Pure: `exit` and the timer are injected, so a unit test
 * drives it with fake timers.
 */
export function armQuitHammer(options: {
  readonly ms: number
  readonly exit: (code: number) => void
  readonly log: (line: string) => void
  readonly setTimeout?: typeof globalThis.setTimeout
}): void {
  const schedule = options.setTimeout ?? globalThis.setTimeout
  schedule(() => {
    options.log(`[quit] still running ${options.ms} ms after the cleanup; exiting`)
    options.exit(1)
  }, options.ms)
}
