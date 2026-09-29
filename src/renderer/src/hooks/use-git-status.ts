import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react'
import { useSessionStore } from '../store/session-store'
import type { GitStatusResult } from '../../../preload/index.d'

const POLL_INTERVAL = 5000
const FETCH_INTERVAL = 30000

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
  const [seen, setSeen] = useState<{ cwd: string | null; active: boolean } | null>(null)
  if (!seen || seen.cwd !== cwd || seen.active !== active) {
    setSeen({ cwd, active })
    setStatus(null)
    setError(null)
    if (cwd && active) setLoading(true)
  }

  // The fetch guard's cwd moves at commit, before any in-flight fetch for the
  // previous cwd can resolve against it.
  useLayoutEffect(() => {
    cwdRef.current = cwd
  }, [cwd])

  useEffect(() => {
    if (cwd && active) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch is async: every setState in it lands after its await, never synchronously here
      fetch().finally(() => setLoading(false))
    }
  }, [cwd, active, fetch])

  // Poll while active
  useEffect(() => {
    if (!cwd || !active) return
    const interval = setInterval(fetch, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [cwd, active, fetch])

  // Periodic git fetch to update remote tracking refs
  useEffect(() => {
    if (!cwd || !active) return
    window.electronAPI.gitFetch(cwd)
    const interval = setInterval(() => {
      window.electronAPI.gitFetch(cwd)
    }, FETCH_INTERVAL)
    return () => clearInterval(interval)
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
