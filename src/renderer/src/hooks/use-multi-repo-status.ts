import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { GitStatusResult } from '../../../preload/index.d'
import { useSessionStore } from '../store/session-store'
import { useGitBatch } from '../components/git/git-batch-context'
import { startPollLoop } from '../lib/poll-loop'
import {
  GIT_FETCH_JITTER_MS,
  GIT_FETCH_POLL_MS,
  GIT_STATUS_BACKSTOP_MS,
  GIT_STATUS_MAX_POLL_MS,
  GIT_STATUS_POLL_MS,
  isDocumentHidden,
  mergeStatuses,
  newWatchSubscriberId
} from '../lib/git-poll'

type RepoEntry = { name: string; path: string; status: GitStatusResult }

export type MultiRepoMode =
  | { mode: 'single' }
  | { mode: 'multi'; repos: RepoEntry[]; truncated: boolean; live: boolean }
  | { mode: 'none' }
  | { mode: 'loading' }

/**
 * The last reading of each folder, kept outside the component (PRDCT-3776).
 * Switching from the git tab to the files tab and back used to reset the
 * panel to its loading state and wait for the whole tree to be read again;
 * now the panel opens on what it last showed and the read refreshes it.
 */
interface CachedReading {
  result: MultiRepoMode
  lastUpdated: number | null
  hasNestedRepos: boolean
}
const readingCache = new Map<string, CachedReading>()

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
  const [result, setResultState] = useState<MultiRepoMode>(
    () => (cwd ? readingCache.get(cwd)?.result : undefined) ?? { mode: 'loading' }
  )
  const [hasNestedRepos, setHasNestedReposState] = useState(
    () => (cwd ? readingCache.get(cwd)?.hasNestedRepos : undefined) ?? false
  )
  const [refreshing, setRefreshing] = useState(false)
  const [lastUpdated, setLastUpdatedState] = useState<number | null>(
    () => (cwd ? readingCache.get(cwd)?.lastUpdated : undefined) ?? null
  )
  const cwdRef = useRef(cwd)

  // Every write of the reading also lands in the cache, under the folder it
  // was read for — never under a folder the panel moved to since.
  const remember = useCallback((forCwd: string, patch: Partial<CachedReading>): void => {
    const prev = readingCache.get(forCwd) ?? {
      result: { mode: 'loading' } as MultiRepoMode,
      lastUpdated: null,
      hasNestedRepos: false
    }
    readingCache.set(forCwd, { ...prev, ...patch })
  }, [])
  const setResult = useCallback(
    (next: MultiRepoMode): void => {
      setResultState(next)
      if (cwd && next.mode !== 'loading') remember(cwd, { result: next })
    },
    [cwd, remember]
  )
  const setHasNestedRepos = useCallback(
    (next: boolean): void => {
      setHasNestedReposState(next)
      if (cwd) remember(cwd, { hasNestedRepos: next })
    },
    [cwd, remember]
  )
  const setLastUpdated = useCallback(
    (next: number): void => {
      setLastUpdatedState(next)
      if (cwd) remember(cwd, { lastUpdated: next })
    },
    [cwd, remember]
  )

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
    [cwd, isLive, setResult, setHasNestedRepos, setLastUpdated]
  )

  // On a folder change or a return to the git tab: show the folder's last
  // reading at once (the loading state only for a folder never read), then
  // read it again.
  useEffect(() => {
    cwdRef.current = cwd
    if (!cwd) {
      setResultState({ mode: 'loading' })
      return
    }
    const cached = readingCache.get(cwd)
    setResultState(cached?.result ?? { mode: 'loading' })
    setHasNestedReposState(cached?.hasNestedRepos ?? false)
    setLastUpdatedState(cached?.lastUpdated ?? null)
    if (!active) return
    fetchAll()
  }, [cwd, active, fetchAll])

  // Only poll in multi mode that is "live" (small enough). Single mode uses
  // useGitStatus for its own polling.
  const isLiveMulti = result.mode === 'multi' && result.live

  // Stable key for repo paths — only changes when repos are added/removed, not on status polls
  const repoPaths = useMemo(() => {
    if (result.mode !== 'multi') return ''
    return result.repos
      .map((r) => r.path)
      .sort()
      .join('\n')
  }, [result])

  // Live multi mode: the listed repos are watched, and a repo the watcher
  // reports is read again on its own. A full re-read runs behind it on a
  // timer — every five seconds while the watch is not up, every thirty once
  // every repo is watched — and never starts before the last one ended.
  useEffect(() => {
    if (!cwd || !active || !isLiveMulti || !repoPaths) return
    const paths = repoPaths.split('\n').filter(Boolean)
    if (paths.length === 0) return
    const listed = new Set(paths)
    let allWatched = false
    const subscriberId = newWatchSubscriberId('git-multi')
    const loop = startPollLoop({
      run: () => fetchAll(),
      intervalMs: () => (allWatched ? GIT_STATUS_BACKSTOP_MS : GIT_STATUS_POLL_MS),
      maxIntervalMs: GIT_STATUS_MAX_POLL_MS,
      isHidden: isDocumentHidden
    })

    // The repos reported while a partial read runs wait for the next one, so
    // a burst of changes never puts two reads of the same repos side by side.
    let changed = new Set<string>()
    let reading = false
    const readChanged = async (): Promise<void> => {
      if (reading || changed.size === 0) return
      reading = true
      const batch = [...changed]
      changed = new Set()
      try {
        const statuses = await window.electronAPI.getGitStatusBatch(batch)
        if (cwdRef.current === cwd) {
          setResultState((prev) => {
            const next = mergeStatuses(prev, statuses)
            if (next !== prev) remember(cwd, { result: next })
            return next
          })
          setLastUpdated(Date.now())
        }
      } catch {
        // The timer's full read covers a failed partial one.
      } finally {
        reading = false
      }
      if (changed.size > 0) void readChanged()
    }
    const offChanged = window.electronAPI.onGitReposChanged?.((repos) => {
      for (const repo of repos) if (listed.has(repo)) changed.add(repo)
      void readChanged()
    })
    window.electronAPI
      .gitWatchRepos?.(subscriberId, paths)
      .then((ok) => {
        allWatched = ok.length === paths.length
      })
      .catch(() => {
        allWatched = false
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
  }, [cwd, active, isLiveMulti, repoPaths, fetchAll, remember, setLastUpdated])

  // Background git fetch for the listed repos in live multi mode: every three
  // minutes, staggered. Main skips a repo fetched a moment ago by anyone, and
  // its queue bounds how many fetch at once across the app.
  useEffect(() => {
    if (!cwd || !active || !isLiveMulti || !repoPaths) return
    const paths = repoPaths.split('\n').filter(Boolean)
    if (paths.length === 0) return
    const loop = startPollLoop({
      run: () => window.electronAPI.gitFetchBatch(paths),
      intervalMs: () => GIT_FETCH_POLL_MS,
      maxIntervalMs: GIT_FETCH_POLL_MS * 2,
      jitterMs: GIT_FETCH_JITTER_MS,
      isHidden: isDocumentHidden,
      immediate: true
    })
    return () => loop.stop()
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
