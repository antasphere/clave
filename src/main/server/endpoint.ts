/**
 * Where the in-process server is, once it runs: kept apart from the start
 * itself so the IPC handler that answers the preload loads nothing of the
 * server (Effect, the framework) at boot.
 */
export interface ClaveServerEndpoint {
  url: string
  token: string
  /** Where the server runs: inside this app, or attached, as its own
   *  process. The preload reads it to pick the terminal pane's road: an
   *  attached app's terminal bytes come off the push channel, an in-process
   *  app's over IPC as always (one or the other, never both). */
  mode: 'in-process' | 'attached'
}

let endpoint: ClaveServerEndpoint | null = null

export function getClaveServerEndpoint(): ClaveServerEndpoint | null {
  return endpoint
}

export function setClaveServerEndpoint(next: ClaveServerEndpoint | null): void {
  endpoint = next
}

// ── Lane D (wave 3): whether the boot has decided ──
// The agent tools wait for the server while the boot is still deciding
// (`bootServer` in `src/main/index.ts` has not resolved) and fail at once
// once it has decided there is none ("the app runs without it"), rather than
// poll for a server that will never come.
let settled = false
let settledWaiters: (() => void)[] = []

export function isClaveServerBootSettled(): boolean {
  return settled
}

/** The boot decided: a server named through `setClaveServerEndpoint`, or none. */
export function markClaveServerBootSettled(): void {
  settled = true
  const waiters = settledWaiters
  settledWaiters = []
  for (const resolve of waiters) resolve()
}

/** How long a caller waits for the boot's decision at most: a boot that
 *  never decides (a lost mark, a hung start) must not hold a caller for the
 *  life of the process; past it the caller goes on as if nothing were named. */
export const BOOT_DECISION_WAIT_MS = 20_000

/** Resolves once the boot has decided, at once when it already has, and at
 *  the latest after `maxWaitMs`. */
export function whenClaveServerBootSettled(maxWaitMs = BOOT_DECISION_WAIT_MS): Promise<void> {
  if (settled) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(done, maxWaitMs)
    function done(): void {
      clearTimeout(timer)
      settledWaiters = settledWaiters.filter((w) => w !== done)
      resolve()
    }
    settledWaiters.push(done)
  })
}

/** Tests only. */
export function resetClaveServerBootForTests(): void {
  settled = false
  settledWaiters = []
  endpoint = null
}
