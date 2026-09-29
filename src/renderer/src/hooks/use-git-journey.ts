import { useState, useEffect, useCallback, useRef } from 'react'
import type { GitJourneyResult } from '../../../preload/index.d'

export function useGitJourney(
  cwd: string | null,
  active: boolean
): {
  data: GitJourneyResult | null
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  loadMore: () => void
} {
  const [data, setData] = useState<GitJourneyResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const maxCountRef = useRef(200)

  const fetch = useCallback(async () => {
    if (!cwd) return
    setLoading(true)
    setError(null)
    try {
      const result = await window.electronAPI.gitJourney(cwd, maxCountRef.current)
      setData(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [cwd])

  useEffect(() => {
    if (active && cwd) fetch()
  }, [active, cwd, fetch])

  const refresh = useCallback(() => fetch(), [fetch])

  const loadMore = useCallback(() => {
    maxCountRef.current += 200
    fetch()
  }, [fetch])

  return { data, loading, error, refresh, loadMore }
}
