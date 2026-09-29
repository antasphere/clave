import { useState, useEffect, useMemo } from 'react'

export interface FuzzyMatch {
  path: string
  filename: string
  directory: string
  score: number
  matchIndices: number[]
}

function isSegmentStart(path: string, index: number): boolean {
  if (index === 0) return true
  const prev = path[index - 1]
  return prev === '/' || prev === '.' || prev === '-' || prev === '_'
}

function fuzzyMatch(
  query: string,
  target: string
): { score: number; matchIndices: number[] } | null {
  const lowerQuery = query.toLowerCase()
  const lowerTarget = target.toLowerCase()
  const indices: number[] = []
  let score = 0
  let targetIdx = 0

  for (let qi = 0; qi < lowerQuery.length; qi++) {
    const qChar = lowerQuery[qi]
    let found = false
    while (targetIdx < lowerTarget.length) {
      if (lowerTarget[targetIdx] === qChar) {
        indices.push(targetIdx)

        // Score consecutive matches
        if (indices.length > 1 && indices[indices.length - 1] === indices[indices.length - 2] + 1) {
          score += 10
        }

        // Score segment-start matches
        if (isSegmentStart(target, targetIdx)) {
          score += 8
        }

        targetIdx++
        found = true
        break
      }
      targetIdx++
    }
    if (!found) return null
  }

  // Bonus for filename matches
  const lastSlash = target.lastIndexOf('/')
  const filenameStart = lastSlash + 1
  const filenameMatches = indices.filter((i) => i >= filenameStart).length
  score += filenameMatches * 3

  // Penalize path length and depth
  score -= target.length * 0.1
  score -= (target.split('/').length - 1) * 2

  return { score, matchIndices: indices }
}

export function useFileSearch(
  cwd: string | null,
  isOpen: boolean
): {
  results: FuzzyMatch[]
  query: string
  setQuery: React.Dispatch<React.SetStateAction<string>>
  loading: boolean
  truncated: boolean
} {
  const [files, setFiles] = useState<string[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [query, setQuery] = useState('')

  // Load file list when palette opens
  useEffect(() => {
    if (!isOpen || !cwd) {
      setFiles([])
      setTruncated(false)
      setQuery('')
      return
    }

    let cancelled = false
    setLoading(true)

    const load = async (): Promise<void> => {
      try {
        const result = await window.electronAPI?.listFiles(cwd)
        if (cancelled || !result) return
        setFiles(result.files)
        setTruncated(result.truncated)
      } catch (err) {
        console.error('Failed to list files:', err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()

    return () => {
      cancelled = true
    }
  }, [cwd, isOpen])

  const results = useMemo((): FuzzyMatch[] => {
    if (!query.trim()) {
      // Show shallow files sorted alphabetically when no query
      return files
        .filter((f) => !f.includes('/'))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
        .slice(0, 12)
        .map((f) => ({
          path: f,
          filename: f,
          directory: '',
          score: 0,
          matchIndices: []
        }))
    }

    const matches: FuzzyMatch[] = []
    for (const filePath of files) {
      const result = fuzzyMatch(query, filePath)
      if (result) {
        const lastSlash = filePath.lastIndexOf('/')
        matches.push({
          path: filePath,
          filename: lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath,
          directory: lastSlash >= 0 ? filePath.slice(0, lastSlash) : '',
          score: result.score,
          matchIndices: result.matchIndices
        })
      }
    }

    matches.sort((a, b) => b.score - a.score)
    return matches.slice(0, 12)
  }, [files, query])

  return { results, query, setQuery, loading, truncated }
}
