import { useEffect, useState } from 'react'

/**
 * The clave-preview URL an .html file is served at — registered with the
 * main process, which scopes the file's token to its own directory. Keyed by
 * path so a file switch reads "loading" without a reset write.
 */
export function usePreviewUrl(filePath: string | null): {
  url: string | null
  error: string | null
} {
  const [result, setResult] = useState<{ forPath: string; url?: string; error?: string } | null>(
    null
  )

  useEffect(() => {
    if (!filePath) return
    let cancelled = false
    window.electronAPI
      .registerHtmlPreview(filePath)
      .then(({ url }) => {
        if (!cancelled) setResult({ forPath: filePath, url })
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setResult({ forPath: filePath, error: err instanceof Error ? err.message : String(err) })
      })
    return () => {
      cancelled = true
    }
  }, [filePath])

  const current = filePath && result?.forPath === filePath ? result : null
  return { url: current?.url ?? null, error: current?.error ?? null }
}
