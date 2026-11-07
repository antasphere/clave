import { useCallback, useEffect, useRef, useState } from 'react'

interface UseCopyFeedback {
  /** True for the moment right after a copy — swap the glyph for a check. */
  copied: boolean
  copy: (text: string) => void
}

/**
 * Clipboard write plus the acknowledgement the app already speaks: a check for
 * 1.5s, then back to the copy glyph (the rhythm `SessionCopyOffers` set). A
 * clipboard write is invisible, so a button that does one has to say so.
 */
export function useCopyFeedback(): UseCopyFeedback {
  const [copied, setCopied] = useState(false)
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current)
    }
  }, [])

  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text)
    setCopied(true)
    if (resetTimer.current) clearTimeout(resetTimer.current)
    resetTimer.current = setTimeout(() => setCopied(false), 1500)
  }, [])

  return { copied, copy }
}
