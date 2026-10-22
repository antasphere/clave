import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react'
import { useSessionStore } from '../store/session-store'
import type { GitStatusResult } from '../../../preload/index.d'
import { startPollLoop } from '../lib/poll-loop'
import {
  GIT_FETCH_JITTER_MS,
  GIT_FETCH_POLL_MS,
  GIT_STATUS_BACKSTOP_MS,
  GIT_STATUS_MAX_POLL_MS,
  GIT_STATUS_POLL_MS,
  isDocumentHidden,
  newWatchSubscriberId
} from '../lib/git-poll'

/**
 * The last status read for each folder, kept outside the component
 * (PRDCT-3776): leaving the git tab unmounts nothing but flips `active`, and
 * coming back used to start from an empty panel and wait for a fresh read.
 * Now the panel shows what it last knew in the first frame and the read
 * refreshes it.
 */
const statusCache = new Map<string, GitStatusResult>()

export function useGitStatus(
  cwd: string | null,
  active: boolean
): {
  status: GitStatusResult | null
  loading: boolean
  error: string | null
  refresh: () => void
} {
  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cwdRef = useRef(cwd)

  const fetch = useCallback(async () => {
    if (!cwd || !window.electronAPI?.getGitStatus) return
    try {
      const result = await window.electronAPI.getGitStatus(cwd)
      statusCache.set(cwd, result)
      // Only update if cwd hasn't changed during the fetch
      if (cwdRef.current === cwd) {
        setStatus(result)
        setError(null)
      }
    } catch (err) {
      if (cwdRef.current === cwd) {
        setError(err instanceof Error ? err.message : 'Failed to get git status')
      }
    }
  }, [cwd])

  // Reset state when cwd changes. Done while rendering, against what the last
  // render saw, so no frame shows the previous repo's status under the new cwd.
  // The new cwd's last known status, when there is one, is shown at once; the
  // loading state is for a folder never read.
  const [seen, setSeen] = useState<{ cwd: string | null; active: boolean } | null>(null)
  if (!seen || seen.cwd !== cwd || seen.active !== active) {
    setSeen({ cwd, active })
    const cached = cwd ? (statusCache.get(cwd) ?? null) : null
    setStatus(cached)
    setError(null)
    setLoading(!!cwd && active && !cached)
  }

  // The fetch guard's cwd moves at commit, before any in-flight fetch for the
  // previous cwd can resolve against it.
  useLayoutEffect(() => {
    cwdRef.current = cwd
  }, [cwd])

  // Read while active: at once, then each time the repo watcher reports a
  // change, with a timer behind it — every five seconds while the repo is not
  // watched, every thirty once it is. A round never starts before the last
  // one ended, and a hidden window skips its rounds until it is shown again.
  useEffect(() => {
    if (!cwd || !active) return
    let watched = false
    const subscriberId = newWatchSubscriberId('git-status')
    const loop = startPollLoop({
      run: () => fetch().finally(() => setLoading(false)),
      intervalMs: () => (watched ? GIT_STATUS_BACKSTOP_MS : GIT_STATUS_POLL_MS),
      maxIntervalMs: GIT_STATUS_MAX_POLL_MS,
      isHidden: isDocumentHidden,
      immediate: true
    })
    const offChanged = window.electronAPI.onGitReposChanged?.((repos) => {
      if (repos.includes(cwd)) loop.trigger()
    })
    window.electronAPI
      .gitWatchRepos?.(subscriberId, [cwd])
      .then((ok) => {
        watched = ok.includes(cwd)
      })
      .catch(() => {
        watched = false
      })
    const onVisible = (): void => {
      if (!isDocumentHidden()) loop.trigger()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      loop.stop()
      offChanged?.()
      document.removeEventListener('visibilitychange', onVisible)
      void window.electronAPI.gitUnwatchRepos?.(subscriberId)
    }
  }, [cwd, active, fetch])

  // Background git fetch to update remote tracking refs: every three minutes,
  // staggered. Main skips it for a repo fetched a moment ago by anyone.
  useEffect(() => {
    if (!cwd || !active) return
    const loop = startPollLoop({
      run: () => window.electronAPI.gitFetch(cwd),
      intervalMs: () => GIT_FETCH_POLL_MS,
      maxIntervalMs: GIT_FETCH_POLL_MS * 2,
      jitterMs: GIT_FETCH_JITTER_MS,
      isHidden: isDocumentHidden,
      immediate: true
    })
    return () => loop.stop()
  }, [cwd, active])

  // External refresh trigger from store
  const gitRefreshTrigger = useSessionStore((s) => s.gitRefreshTrigger)
  useEffect(() => {
    if (gitRefreshTrigger > 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch is async: every setState in it lands after its await, never synchronously here
      fetch()
    }
  }, [gitRefreshTrigger, fetch])

  const refresh = useCallback(() => {
    setLoading(true)
    fetch().finally(() => setLoading(false))
  }, [fetch])

  return { status, loading, error, refresh }
}
