import { useEffect, useMemo, useState } from 'react'
import { parseDiffLines, type DiffLine } from '../lib/diff-utils'
import type { GitRangeDirection } from '../../../shared/git-range'

export interface UseDiffArgs {
  cwd: string
  file: string
  type: 'working' | 'commit' | GitRangeDirection
  staged: boolean
  fileStatus: string
  hash: string | null
  /** Bump to force a re-fetch (e.g. after stage/unstage or git refresh). */
  refreshKey?: number
}

export interface UseDiffResult {
  diffLines: DiffLine[]
  /** The patch as git printed it — what a copy button on a diff should hand over. */
  raw: string
  loading: boolean
  error: string | null
  stats: { additions: number; deletions: number }
}

export function useDiff({
  cwd,
  file,
  type,
  staged,
  fileStatus,
  hash,
  refreshKey
}: UseDiffArgs): UseDiffResult {
  const [diff, setDiff] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!cwd || !file) {
      setDiff(null)
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)

    const fetch = async (): Promise<void> => {
      try {
        let result: string
        if (type !== 'working' && type !== 'commit') {
          result = await window.electronAPI.gitRangeDiff(cwd, type, file)
        } else if (type === 'commit' && hash) {
          result = await window.electronAPI.gitCommitDiff(cwd, hash, file)
        } else {
          const isUntracked = fileStatus === 'untracked'
          result = await window.electronAPI.gitDiff(cwd, file, staged, isUntracked)
        }
        if (!cancelled) setDiff(result)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetch()

    return () => {
      cancelled = true
    }
  }, [cwd, file, type, staged, fileStatus, hash, refreshKey])

  const diffLines = useMemo<DiffLine[]>(() => {
    if (diff === null) return []
    const isUntracked = fileStatus === 'untracked'
    const isNewFile = fileStatus === 'A' || fileStatus === 'added'
    if (isUntracked || (isNewFile && !diff.includes('@@'))) {
      return diff.split('\n').map((line) => ({ type: 'add', content: line }))
    }
    return parseDiffLines(diff)
  }, [diff, fileStatus])

  const stats = useMemo(() => {
    let additions = 0
    let deletions = 0
    for (const line of diffLines) {
      if (line.type === 'add') additions++
      else if (line.type === 'del') deletions++
    }
    return { additions, deletions }
  }, [diffLines])

  return { diffLines, raw: diff ?? '', loading, error, stats }
}
