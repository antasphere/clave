/**
 * How often the git panel reads its repos (PRDCT-3775). Both polling hooks
 * share these, so the single-repo and the multi-repo panel cannot drift apart.
 */

/** A repo nobody is watching for changes is read this often. */
export const GIT_STATUS_POLL_MS = 5_000

/** A watched repo reports its own changes; the timer is only a safety net. */
export const GIT_STATUS_BACKSTOP_MS = 30_000

/** The longest a slow round can push the next status read out. */
export const GIT_STATUS_MAX_POLL_MS = 60_000

/** The background fetch: every three minutes, staggered by up to twenty
 *  seconds so that panels and windows do not all go to the remotes at once.
 *  Main skips a repo fetched in the last two and a half minutes anyway. */
export const GIT_FETCH_POLL_MS = 180_000
export const GIT_FETCH_JITTER_MS = 20_000

export const isDocumentHidden = (): boolean =>
  typeof document !== 'undefined' && document.visibilityState === 'hidden'

/** A subscriber id for the repo watcher, unique to one mounted hook. */
export const newWatchSubscriberId = (kind: string): string =>
  `${kind}-${Math.random().toString(36).slice(2, 10)}`

/**
 * A reading with `updates` folded in, repo by repo: what a watcher-driven
 * read of a few repos does to the panel's list. The same object comes back
 * when nothing in it changed, so React keeps the render it has.
 */
export function mergeStatuses<
  S,
  R extends { mode: string; repos?: Array<{ path: string; status: S }> }
>(result: R, updates: Array<{ path: string; status: S }>): R {
  if (result.mode !== 'multi' || !result.repos || updates.length === 0) return result
  const byPath = new Map(updates.map((u) => [u.path, u.status]))
  let changed = false
  const repos = result.repos.map((r) => {
    const status = byPath.get(r.path)
    if (status === undefined) return r
    changed = true
    return { ...r, status }
  })
  return changed ? { ...result, repos } : result
}
