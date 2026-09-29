import { useEffect, useRef, useState, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useSessionStore } from '../../store/session-store'
import { useFileSearch, type FuzzyMatch } from '../../hooks/use-file-search'
import { insertPath } from '../../lib/shell'
import { FileIcon } from './file-icons'

function HighlightedText({
  text,
  indices
}: {
  text: string
  indices: number[]
  offset?: number
}): React.JSX.Element {
  if (indices.length === 0) return <>{text}</>
  const chars: React.ReactNode[] = []
  const indexSet = new Set(indices)
  for (let i = 0; i < text.length; i++) {
    if (indexSet.has(i)) {
      chars.push(
        <span key={i} className="text-accent font-semibold">
          {text[i]}
        </span>
      )
    } else {
      chars.push(text[i])
    }
  }
  return <>{chars}</>
}

function ResultRow({
  match,
  isSelected,
  onMouseEnter,
  onClick
}: {
  match: FuzzyMatch
  isSelected: boolean
  onMouseEnter: () => void
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors ${
        isSelected ? 'bg-surface-200' : 'hover:bg-surface-100'
      }`}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
    >
      <FileIcon name={match.filename} className="flex-shrink-0 text-text-tertiary" />
      <span className="flex-1 min-w-0 flex items-baseline gap-2 truncate">
        <span className="text-sm font-medium text-text-primary truncate">
          <HighlightedText
            text={match.filename}
            indices={match.matchIndices
              .filter((i) => i >= match.path.length - match.filename.length)
              .map((i) => i - (match.path.length - match.filename.length))}
          />
        </span>
        {match.directory && (
          <span className="text-xs text-text-tertiary truncate">{match.directory}</span>
        )}
      </span>
    </button>
  )
}

export function FilePalette(): React.JSX.Element {
  const isOpen = useSessionStore((s) => s.filePaletteOpen)
  const setOpen = useSessionStore((s) => s.setFilePaletteOpen)
  const focusedSessionId = useSessionStore((s) => s.focusedSessionId)
  const sessions = useSessionStore((s) => s.sessions)
  const setPreviewFile = useSessionStore((s) => s.setPreviewFile)

  const focusedSession = sessions.find((s) => s.id === focusedSessionId)
  const cwd = focusedSession?.cwd ?? null

  const { results, query, setQuery, loading, truncated } = useFileSearch(cwd, isOpen)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Reset selection when results change
  useEffect(() => {
    setSelectedIndex(0)
  }, [results])

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [isOpen])

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
  }, [setOpen, setQuery])

  // Global Escape handler (works even when input is disabled)
  useEffect(() => {
    if (!isOpen) return
    const handleEscape = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [isOpen, close])

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return
    const selected = listRef.current.children[selectedIndex] as HTMLElement | undefined
    selected?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleInsert = useCallback(
    (filePath: string, absolute: boolean) => {
      if (!focusedSessionId || !cwd) return
      const pathToInsert = absolute ? `${cwd}/${filePath}` : `./${filePath}`
      insertPath(focusedSessionId, pathToInsert)
      close()
    },
    [focusedSessionId, cwd, close]
  )

  const handleCopyPath = useCallback(
    (filePath: string) => {
      navigator.clipboard.writeText(`./${filePath}`)
      close()
    },
    [close]
  )

  const handlePreview = useCallback(
    (filePath: string) => {
      setPreviewFile(filePath, 'palette')
    },
    [setPreviewFile]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setSelectedIndex((i) => Math.min(i + 1, results.length - 1))
          break
        case 'ArrowUp':
          e.preventDefault()
          setSelectedIndex((i) => Math.max(i - 1, 0))
          break
        case 'Enter':
          e.preventDefault()
          if (results[selectedIndex]) {
            handleInsert(results[selectedIndex].path, e.metaKey)
          }
          break
        case 'c':
          if (e.metaKey && results[selectedIndex]) {
            e.preventDefault()
            handleCopyPath(results[selectedIndex].path)
          }
          break
        case ' ':
          if (results[selectedIndex]) {
            e.preventDefault()
            handlePreview(results[selectedIndex].path)
          }
          break
        case 'Escape':
          e.preventDefault()
          close()
          break
      }
    },
    [results, selectedIndex, handleInsert, handleCopyPath, handlePreview, close]
  )

  const noSession = !focusedSessionId || !cwd

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="modal-scrim z-50"
            onClick={close}
          />
          {/* Modal */}
          <motion.div
            initial={{ opacity: 0, scale: 0.96, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -8 }}
            transition={{ duration: 0.15, ease: [0.2, 0, 0, 1] }}
            className="fixed z-50 left-1/2 -translate-x-1/2 w-[560px]"
            style={{ top: '20%' }}
          >
            <div className="menu-surface menu-surface--sheet">
              {/* Search input */}
              <div className="px-4 py-3 border-b border-border-subtle">
                <input
                  ref={inputRef}
                  type="text"
                  placeholder={noSession ? 'Focus a session first' : 'Search files...'}
                  disabled={noSession}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="w-full bg-transparent text-sm font-mono text-text-primary placeholder:text-text-tertiary outline-none disabled:opacity-50"
                />
              </div>

              {/* Results */}
              <div ref={listRef} className="max-h-96 overflow-y-auto">
                {noSession ? (
                  <div className="px-4 py-8 text-center text-sm text-text-tertiary">
                    Focus a session first
                  </div>
                ) : loading ? (
                  <div className="px-4 py-8 text-center text-sm text-text-tertiary">
                    Loading files...
                  </div>
                ) : results.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-text-tertiary">
                    {query ? 'No files found' : 'No files in directory'}
                  </div>
                ) : (
                  results.map((match, i) => (
                    <ResultRow
                      key={match.path}
                      match={match}
                      isSelected={i === selectedIndex}
                      onMouseEnter={() => setSelectedIndex(i)}
                      onClick={() => handleInsert(match.path, false)}
                    />
                  ))
                )}
              </div>

              {/* Truncation warning */}
              {truncated && (
                <div className="px-4 py-1.5 text-xs text-yellow-500 bg-yellow-500/5 border-t border-border-subtle">
                  File list truncated (50,000+ files)
                </div>
              )}

              {/* Footer */}
              {!noSession && (
                <div className="px-4 py-2 border-t border-border-subtle flex items-center gap-4 text-[11px] text-text-tertiary">
                  <span>
                    <kbd className="px-1 py-0.5 rounded bg-surface-200 text-text-secondary">
                      Enter
                    </kbd>{' '}
                    insert
                  </span>
                  <span>
                    <kbd className="px-1 py-0.5 rounded bg-surface-200 text-text-secondary">
                      Cmd+Enter
                    </kbd>{' '}
                    absolute
                  </span>
                  <span>
                    <kbd className="px-1 py-0.5 rounded bg-surface-200 text-text-secondary">
                      Cmd+C
                    </kbd>{' '}
                    copy
                  </span>
                  <span>
                    <kbd className="px-1 py-0.5 rounded bg-surface-200 text-text-secondary">
                      Space
                    </kbd>{' '}
                    preview
                  </span>
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
