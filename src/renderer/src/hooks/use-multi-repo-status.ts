import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import type { GitStatusResult } from '../../../preload/index.d'
import { useSessionStore } from '../store/session-store'
import { useGitBatch } from '../components/git/git-batch-context'
import { startPollLoop } from '../lib/poll-loop'
import { repoDisplayName } from '../lib/git-paths'
import { primeGitStatus } from './use-git-status'
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

/** One row of the list. `status` is `null` while the row's first reading is
 *  on its way: the row is there by name, in its place, and its badges land
 *  when git answers (PRDCT-4142). */
export type RepoEntry = { name: string; path: string; status: GitStatusResult | null }

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
 *
 * A first reading is published in stages rather than at its end (PRDCT-4142).
 * It used to read the root, discover the nested repositories, read every one
 * of them in one batch and publish once the slowest had answered, so a
 * workspace of ninety repositories showed nothing for the whole wait. Now the
 * root's status is shown as soon as git returns it, every nested row appears
 * by name the moment discovery returns, in discovery's order, and each row's
 * badges land as its own status does. Nothing moves: the rows are fixed at
 * discovery, and a status fills its row in place.
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

      // What this folder's rows already show: a row keeps its last badges
      // while its new reading is on its way, and only a row never read shows
      // the reading state.
      const known = (): Map<string, GitStatusResult> => {
        const prev = readingCache.get(cwd)?.result
        const m = new Map<string, GitStatusResult>()
        if (prev?.mode === 'multi')
          for (const r of prev.repos) if (r.status) m.set(r.path, r.status)
        return m
      }
      const publish = (next: MultiRepoMode): void => {
        if (cwdRef.current === cwd) setResult(next)
      }
      // Stage 3: one read per row, through main's queue, each folded into the
      // list as it lands. The round ends when the last one has answered, so the
      // poll loop never starts the next round beside it.
      const readEach = async (paths: string[]): Promise<void> => {
        await Promise.all(
          paths.map(async (path) => {
            try {
              const status = await window.electronAPI.getGitStatus(path)
              if (cwdRef.current !== cwd) return
              setResultState((prev) => {
                const next = mergeStatuses(prev, [{ path, status }])
                if (next !== prev) remember(cwd, { result: next })
                return next
              })
            } catch (error) {
              // The row keeps what it had, or its reading state; the next
              // round reads it again.
              if (cwdRef.current === cwd)
                console.warn(
                  '[clave] git repo read failed',
                  path,
                  error instanceof Error ? error.message : 'Failed to get git status'
                )
            }
          })
        )
        if (cwdRef.current === cwd) setLastUpdated(Date.now())
      }

      try {
        const status = await window.electronAPI.getGitStatus(cwd)
        if (cwdRef.current !== cwd) return

        if (status.isRepo) {
          // Stage 1: the root is a repository and its status is in hand. The
          // single-repo panel opens on it now (primed, so it does not ask git
          // again); discovery decides below whether nested repositories turn
          // the folder into a list, and a list already shown gets its root
          // row's status refreshed in place.
          primeGitStatus(cwd, status)
          const prev = readingCache.get(cwd)?.result
          if (!prev || prev.mode === 'loading') publish({ mode: 'single' })
          else if (prev.mode === 'multi') publish(mergeStatuses(prev, [{ path: cwd, status }]))

          const { repos: nested } = await window.electronAPI.discoverGitRepos(cwd, force)
          if (cwdRef.current !== cwd) return

          setHasNestedRepos(nested.length > 0)

          if (nested.length === 0) {
            publish({ mode: 'single' })
            setLastUpdated(Date.now())
            return
          }

          // Stage 2: every row by name, the root's status in hand, each nested
          // row's last known status or the reading state.
          const rootName = repoDisplayName(cwd)
          const live = isLive(nested.length + 1)
          const was = known()
          publish({
            mode: 'multi',
            repos: [
              { name: rootName, path: cwd, status },
              ...nested.map((r) => ({
                name: r.name,
                path: r.path,
                status: was.get(r.path) ?? null
              }))
            ],
            truncated: false,
            live
          })
          await readEach(nested.map((r) => r.path))
          return
        }

        // CWD is not a repo — discover repos in children
        setHasNestedRepos(false)

        const { repos: discovered, truncated } = await window.electronAPI.discoverGitRepos(
          cwd,
          force
        )
        if (cwdRef.current !== cwd) return

        if (discovered.length === 0) {
          publish({ mode: 'none' })
          setLastUpdated(Date.now())
          return
        }

        const live = isLive(discovered.length)
        const was = known()
        publish({
          mode: 'multi',
          repos: discovered.map((r) => ({
            name: r.name,
            path: r.path,
            status: was.get(r.path) ?? null
          })),
          truncated,
          live
        })
        await readEach(discovered.map((r) => r.path))
      } catch (error) {
        if (cwdRef.current !== cwd) return
        console.warn(
          '[clave] git panel read failed',
          error instanceof Error ? error.message : 'Failed to get git status'
        )
        setResultState((prev) => {
          if (prev.mode !== 'loading') return prev
          const next: MultiRepoMode = { mode: 'single' }
          remember(cwd, { result: next })
          return next
        })
      }
    },
    [cwd, isLive, setResult, setHasNestedRepos, setLastUpdated, remember]
  )

  // On a folder change or a return to the git tab: show the folder's last
  // reading at once (the loading state only for a folder never read), then
  // read it again — unless that reading is younger than the poll interval,
  // in which case it is as fresh as a new one would be and the loop's own
  // schedule takes over. A quick bounce between tabs costs no read.
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
    if (cached?.lastUpdated != null && Date.now() - cached.lastUpdated < GIT_STATUS_POLL_MS) return
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
      // Hidden: the reported repos wait, and are read when the window is shown.
      if (reading || changed.size === 0 || isDocumentHidden()) return
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
      if (isDocumentHidden()) return
      loop.trigger()
      void readChanged()
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
