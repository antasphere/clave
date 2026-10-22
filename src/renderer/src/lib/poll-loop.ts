/**
 * A poll that never overlaps itself (PRDCT-3775).
 *
 * The git panel used `setInterval`, which fires on time whether or not the
 * last round finished. Once a round took longer than its interval — a slow
 * disk, a busy Mac, fifty repos — rounds stacked, each one slowing the next,
 * until Clave was running hundreds of git processes. Here the next round is
 * scheduled only when the last one ENDED, and a slow round pushes the next one
 * further out: the wait is at least twice what the round took, up to
 * `maxIntervalMs`. A hidden window skips its rounds and catches up with one
 * as soon as it is looked at again (the caller triggers it).
 *
 * `trigger()` runs a round now — a repo the watcher reported, a refresh — and
 * while a round is running it only asks for one more after it, never a second
 * one beside it.
 */

export interface PollLoopOptions {
  run: () => Promise<unknown>
  /** The wait between rounds; read at each round, so it can change. */
  intervalMs: () => number
  /** The longest a slow round can push the next one out. */
  maxIntervalMs: number
  /** Added at random to each wait, so that many loops drift apart. */
  jitterMs?: number
  /** Run the first round at once rather than after the first wait. */
  immediate?: boolean
  /** True while nobody can see the result: the rounds are skipped. */
  isHidden?: () => boolean
  now?: () => number
  random?: () => number
}

export interface PollLoop {
  trigger(): void
  stop(): void
}

export function startPollLoop(opts: PollLoopOptions): PollLoop {
  const now = opts.now ?? Date.now
  const random = opts.random ?? Math.random
  let timer: ReturnType<typeof setTimeout> | null = null
  let running = false
  let pending = false
  let stopped = false

  const schedule = (delay: number): void => {
    if (stopped) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(tick, delay)
  }

  const nextDelay = (took: number): number => {
    const base = Math.min(opts.maxIntervalMs, Math.max(opts.intervalMs(), took * 2))
    const jitter = opts.jitterMs ? Math.floor(random() * opts.jitterMs) : 0
    return base + jitter
  }

  const round = async (): Promise<void> => {
    running = true
    const started = now()
    try {
      await opts.run()
    } catch {
      // A failed round is still a round: the next one comes at its time.
    }
    running = false
    if (stopped) return
    if (pending) {
      pending = false
      void round()
      return
    }
    schedule(nextDelay(now() - started))
  }

  function tick(): void {
    timer = null
    if (stopped || running) return
    if (opts.isHidden?.()) {
      schedule(nextDelay(0))
      return
    }
    void round()
  }

  if (opts.immediate) void round()
  else schedule(nextDelay(0))

  return {
    trigger(): void {
      if (stopped) return
      if (running) {
        pending = true
        return
      }
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      void round()
    },
    stop(): void {
      stopped = true
      pending = false
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}
