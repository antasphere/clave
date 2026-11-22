/** `promise` if it settles in `ms`, else `fallback`: a listing under a
 *  caller's deadline (the agents' tool bridge allows ten seconds) must not
 *  wait on one slow CLI for every harness. The work keeps running, so the
 *  next call finds it cached. */
export function withinBudget<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise.then(resolve, () => resolve(fallback)).finally(() => clearTimeout(timer))
  })
}

/** What a launch listing waits for `agy models`, about 1.5 s on a good day. */
export const ANTIGRAVITY_LISTING_BUDGET_MS = 3_000
