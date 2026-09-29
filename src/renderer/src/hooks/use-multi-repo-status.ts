import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { GitStatusResult } from '../../../preload/index.d'
import { useSessionStore } from '../store/session-store'
import { useGitBatch } from '../components/git/git-batch-context'

const POLL_INTERVAL = 5000
const FETCH_INTERVAL = 30000

type RepoEntry = { name: string; path: string; status: GitStatusResult }

export type MultiRepoMode =
  | { mode: 'single' }
  | { mode: 'multi'; repos: RepoEntry[]; truncated: boolean; live: boolean }
  | { mode: 'none' }
  | { mode: 'loading' }

export function useMultiRepoStatus(
  cwd: string | null,
  active: boolean
): {
  result: MultiRepoMode
  refresh: () => void
  refreshing: boolean
  lastUpdated: number | null
  hasNestedRepos: boolean
} {
  const { run } = useGitBatch()
  const [result, setResult] = useState<MultiRepoMode>({ mode: 'loading' })
  const [hasNestedRepos, setHasNestedRepos] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)
  const cwdRef = useRef(cwd)

  // Live-update settings. Above `pollLimit` repos the panel stops auto-polling
  // (manual + event-driven refresh only) to keep huge trees (e.g. "/") from
  // spawning a perpetual cascade — unless the user opts out via `pollAlways`.
  const pollLimit = useSessionStore((s) => s.gitLivePollLimit)
  const pollAlways = useSessionStore((s) => s.gitLivePollAlways)

  const isLive = useCallback(
    (count: number) => pollAlways || count <= pollLimit,
    [pollAlways, pollLimit]
  )

  const fetchAll = useCallback(
    async (force = false) => {
      if (!cwd || !window.electronAPI) return

      const status = await window.electronAPI.getGitStatus(cwd)
      if (cwdRef.current !== cwd) return

      if (status.isRepo) {
        const { repos: nested } = await window.electronAPI.discoverGitRepos(cwd, force)
        if (cwdRef.current !== cwd) return

        setHasNestedRepos(nested.length > 0)

        if (nested.length === 0) {
          setResult({ mode: 'single' })
          return
        }

        // Root + nested repos. Reuse the status we already have for the root.
        const rootName = cwd.split(/[\\/]/).pop() ?? cwd
        const nameByPath = new Map<string, string>([[cwd, rootName]])
        for (const r of nested) nameByPath.set(r.path, r.name)

        const allPaths = [cwd, ...nested.map((r) => r.path)]
        const live = isLive(allPaths.length)
        const statuses = await window.electronAPI.getGitStatusBatch(nested.map((r) => r.path))
        if (cwdRef.current !== cwd) return

        const repos: RepoEntry[] = [
          { name: rootName, path: cwd, status },
          ...statuses.map((s) => ({
            name: nameByPath.get(s.path) ?? s.path,
            path: s.path,
            status: s.status
          }))
        ]
        setResult({ mode: 'multi', repos, truncated: false, live })
        setLastUpdated(Date.now())
        return
      }

      // CWD is not a repo — discover repos in children
      setHasNestedRepos(false)

      const { repos: discovered, truncated } = await window.electronAPI.discoverGitRepos(cwd, force)
      if (cwdRef.current !== cwd) return

      if (discovered.length === 0) {
        setResult({ mode: 'none' })
        return
      }

      const live = isLive(discovered.length)
      const nameByPath = new Map(discovered.map((r) => [r.path, r.name]))
      const statuses = await window.electronAPI.getGitStatusBatch(discovered.map((r) => r.path))
      if (cwdRef.current !== cwd) return

      const repos: RepoEntry[] = statuses.map((s) => ({
        name: nameByPath.get(s.path) ?? s.path,
        path: s.path,
        status: s.status
      }))
      setResult({ mode: 'multi', repos, truncated, live })
      setLastUpdated(Date.now())
    },
    [cwd, isLive]
  )

  // Reset + initial fetch when cwd or active changes
  useEffect(() => {
    cwdRef.current = cwd
    if (!cwd || !active) {
      setResult({ mode: 'loading' })
      return
    }
    setResult({ mode: 'loading' })
    fetchAll()
  }, [cwd, active, fetchAll])

  // Only poll in multi mode that is "live" (small enough). Single mode uses
  // useGitStatus for its own polling.
  const isLiveMulti = result.mode === 'multi' && result.live
  useEffect(() => {
    if (!cwd || !active || !isLiveMulti) return
    const interval = setInterval(fetchAll, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [cwd, active, fetchAll, isLiveMulti])

  // Stable key for repo paths — only changes when repos are added/removed, not on status polls
  const repoPaths = useMemo(() => {
    if (result.mode !== 'multi') return ''
    return result.repos
      .map((r) => r.path)
      .sort()
      .join('\n')
  }, [result])

  // Periodic git fetch for all repos in live multi mode (bounded concurrency)
  useEffect(() => {
    if (!cwd || !active || !isLiveMulti || !repoPaths) return
    const paths = repoPaths.split('\n').filter(Boolean)
    if (paths.length === 0) return
    window.electronAPI.gitFetchBatch(paths)
    const interval = setInterval(() => {
      window.electronAPI.gitFetchBatch(paths)
    }, FETCH_INTERVAL)
    return () => clearInterval(interval)
  }, [cwd, active, isLiveMulti, repoPaths])

  // Event-driven refresh — keeps the panel fresh even when live polling is
  // paused (large multi-repo trees). Statuses are always re-read by fetchAll,
  // so an un-forced refresh is enough to reflect new commits.
  const isPausedMulti = result.mode === 'multi' && !result.live

  // (a) Window/git-tab regains focus — catches commits made in a terminal
  //     while the window was in the background.
  useEffect(() => {
    if (!cwd || !active || !isPausedMulti) return
    const onFocus = (): void => {
      fetchAll()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [cwd, active, isPausedMulti, fetchAll])

  // (b) Focused session's agent finishes a turn (active → idle) — catches the
  //     common case of an agent committing in a subfolder.
  const focusedActivity = useSessionStore((s) => {
    const id = s.focusedSessionId
    return id ? (s.sessions.find((x) => x.id === id)?.activityStatus ?? null) : null
  })
  const prevActivityRef = useRef(focusedActivity)
  useEffect(() => {
    const prev = prevActivityRef.current
    prevActivityRef.current = focusedActivity
    if (!cwd || !active || !isPausedMulti) return
    if (focusedActivity === 'idle' && prev === 'active') {
      fetchAll()
    }
  }, [focusedActivity, cwd, active, isPausedMulti, fetchAll])

  /**
   * Refresh is the DISCOVERY control: it goes to every remote, then re-reads.
   *
   * That is deliberately the slow one, and the only slow one. Pull all acts on
   * the ↓ badges and is instant; the badges can only be as true as the last
   * fetch, so something has to go and look — and it is better that the button
   * which takes twenty seconds is the button that says "refresh" than a pull
   * that silently sweeps ninety repos before doing what it was asked. It
   * reports on the bar's progress row like the other batch ops, so a sweep over
   * a large tree shows its own movement instead of a spinner.
   */
  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const paths = repoPaths.split('\n').filter(Boolean)
      if (paths.length > 0) {
        await run('fetch', async () => {
          const results = await window.electronAPI.gitRefreshRemotes(paths)
          const failed = results.filter((r) => r.error).length
          const reached = results.length - failed
          const parts = [`${reached} refreshed`]
          if (failed > 0) parts.push(`${failed} unreachable`)
          return parts.join(', ')
        })
      }
      await fetchAll(true)
    } finally {
      setRefreshing(false)
    }
  }, [fetchAll, run, repoPaths])

  return { result, refresh, refreshing, lastUpdated, hasNestedRepos }
}
