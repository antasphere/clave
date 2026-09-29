import { useEffect, useState, useCallback, useRef, useLayoutEffect } from 'react'
import { motion } from 'framer-motion'
import { ArrowTopRightOnSquareIcon } from '@heroicons/react/24/outline'
import { useSessionStore } from '../../store/session-store'
import { useDiff } from '../../hooks/use-diff'
import { DiffLinesView } from './DiffLinesView'
import { CloseIcon, fileActionButtonClass } from '../files/FileActionIcons'

function commitFileStatusColor(status: string): string {
  switch (status) {
    case 'A':
    case 'added':
    case 'untracked':
      return 'text-green-400'
    case 'M':
    case 'T':
    case 'modified':
      return 'text-git-modified'
    case 'D':
    case 'deleted':
      return 'text-red-400'
    case 'R':
    case 'C':
    case 'renamed':
    case 'copied':
      return 'text-blue-400'
    default:
      return 'text-text-tertiary'
  }
}

function statusDisplayLetter(status: string): string {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'A'
    case 'modified':
      return 'M'
    case 'deleted':
      return 'D'
    case 'renamed':
      return 'R'
    case 'copied':
      return 'C'
    default:
      return status.charAt(0).toUpperCase()
  }
}

export function GitDiffPreview(): React.JSX.Element | null {
  const diffPreview = useSessionStore((s) => s.diffPreview)
  const setDiffPreview = useSessionStore((s) => s.setDiffPreview)
  const triggerGitRefresh = useSessionStore((s) => s.triggerGitRefresh)
  const addFileTab = useSessionStore((s) => s.addFileTab)
  const fileTreeOpen = useSessionStore((s) => s.fileTreeOpen)
  const fileTreeWidth = useSessionStore((s) => s.fileTreeWidth)
  const journeyPanel = useSessionStore((s) => s.journeyPanel)

  const [operating, setOperating] = useState(false)

  const close = useCallback(() => setDiffPreview(null), [setDiffPreview])

  // Click-outside: close when clicking anywhere outside the panel
  // (ignore clicks on sibling floating panels like GitJourneyPanel)
  useEffect(() => {
    if (!diffPreview) return
    const handleMouseDown = (e: MouseEvent): void => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        const target = e.target as HTMLElement
        if (target.closest('[data-floating-panel]')) return
        close()
      }
    }
    window.addEventListener('mousedown', handleMouseDown)
    return () => window.removeEventListener('mousedown', handleMouseDown)
  }, [diffPreview, close])

  const { diffLines, loading, error, stats } = useDiff({
    cwd: diffPreview?.cwd ?? '',
    file: diffPreview?.file ?? '',
    type: diffPreview?.type ?? 'working',
    staged: diffPreview?.staged ?? false,
    fileStatus: diffPreview?.fileStatus ?? '',
    hash: diffPreview?.hash ?? null
  })

  // Keyboard
  useEffect(() => {
    if (!diffPreview) return
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        return
      }
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && diffPreview.siblings?.length) {
        e.preventDefault()
        const siblings = diffPreview.siblings
        const currentIndex = siblings.findIndex((s) => s.file === diffPreview.file)
        if (currentIndex === -1) return

        const nextIndex = e.key === 'ArrowDown' ? currentIndex + 1 : currentIndex - 1
        if (nextIndex < 0 || nextIndex >= siblings.length) return

        const next = siblings[nextIndex]
        setDiffPreview({
          ...diffPreview,
          file: next.file,
          staged: next.staged,
          fileStatus: next.fileStatus
        })
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [diffPreview, close, setDiffPreview])

  const handleStageToggle = useCallback(async () => {
    if (!diffPreview || diffPreview.type !== 'working' || operating) return
    setOperating(true)
    try {
      if (diffPreview.staged) {
        await window.electronAPI.gitUnstage(diffPreview.cwd, [diffPreview.file])
      } else {
        await window.electronAPI.gitStage(diffPreview.cwd, [diffPreview.file])
      }
      triggerGitRefresh()
      // Update the preview to reflect new staged state
      setDiffPreview({ ...diffPreview, staged: !diffPreview.staged })
    } catch {
      // silently ignore
    } finally {
      setOperating(false)
    }
  }, [diffPreview, operating, triggerGitRefresh, setDiffPreview])

  // Measure panel height and compute top position based on clickY
  const panelRef = useRef<HTMLDivElement>(null)
  const [panelTop, setPanelTop] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (!diffPreview || !panelRef.current) return
    const clickY = diffPreview.clickY
    if (clickY == null) {
      setPanelTop(null)
      return
    }
    const vh = window.innerHeight
    const panelHeight = panelRef.current.offsetHeight
    const padding = 16
    // Center the panel on the click position
    let top = clickY - panelHeight / 2
    // Clamp within viewport
    top = Math.max(padding, Math.min(top, vh - panelHeight - padding))
    setPanelTop(top)
  })

  const openAsTab = useCallback(() => {
    if (!diffPreview) return
    const filename = diffPreview.file.split('/').pop() ?? diffPreview.file
    addFileTab({
      id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      filePath: `${diffPreview.cwd}/${diffPreview.file}`,
      name: filename,
      kind: 'diff',
      diff: {
        type: diffPreview.type,
        cwd: diffPreview.cwd,
        file: diffPreview.file,
        staged: diffPreview.staged,
        fileStatus: diffPreview.fileStatus,
        hash: diffPreview.hash
      }
    })
    close()
  }, [diffPreview, addFileTab, close])

  if (!diffPreview) return null

  const filename = diffPreview.file.split('/').pop() ?? ''
  const baseRight = fileTreeOpen ? fileTreeWidth + 8 : 16
  const rightOffset = journeyPanel ? baseRight + 480 + 8 : baseRight
  const panelWidth = 520

  return (
    <>
      <motion.div
        ref={panelRef}
        data-floating-panel
        initial={{ opacity: 0, x: 8 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 8 }}
        transition={{ duration: 0.15, ease: [0.2, 0, 0, 1] }}
        className="menu-surface menu-surface--sheet fixed z-50 flex flex-col"
        style={
          {
            right: rightOffset,
            top: panelTop != null ? panelTop : '4%',
            maxHeight: '92vh',
            width: panelWidth,
            WebkitAppRegion: 'no-drag'
          } as React.CSSProperties
        }
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-subtle flex-shrink-0">
          <div className="flex-1 min-w-0 flex items-center gap-2">
            <span
              className={`font-mono text-xs flex-shrink-0 ${commitFileStatusColor(diffPreview.fileStatus)}`}
            >
              {statusDisplayLetter(diffPreview.fileStatus)}
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium text-text-primary truncate">{filename}</div>
              {diffPreview.file !== filename && (
                <div className="text-xs text-text-tertiary truncate">{diffPreview.file}</div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0 ml-2">
            {diffPreview.type === 'working' && (
              <button
                onClick={handleStageToggle}
                disabled={operating}
                className="px-2 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-surface-200 transition-colors disabled:opacity-40"
              >
                {diffPreview.staged ? 'Unstage' : 'Stage'}
              </button>
            )}
            {diffPreview.type === 'commit' && diffPreview.hash && (
              <span className="text-[10px] text-text-tertiary font-mono">
                {diffPreview.hash.slice(0, 7)}
              </span>
            )}
            <button onClick={openAsTab} className={fileActionButtonClass} title="Open as tab">
              <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />
            </button>
            <button onClick={close} className={fileActionButtonClass}>
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* Diff content */}
        <DiffLinesView
          lines={diffLines}
          loading={loading}
          error={error}
          className="flex-1 min-h-0"
        />

        {/* Footer */}
        {!loading && !error && diffLines.length > 0 && (
          <div className="flex items-center justify-between px-4 py-1.5 border-t border-border-subtle text-[10px] text-text-tertiary flex-shrink-0">
            <span className="flex items-center gap-2">
              {diffPreview.siblings && diffPreview.siblings.length > 1 && (
                <span>
                  {diffPreview.siblings.findIndex((s) => s.file === diffPreview.file) + 1}/
                  {diffPreview.siblings.length}
                </span>
              )}
              <span>{diffLines.length} lines</span>
            </span>
            <span>
              {stats.additions > 0 && <span className="text-green-400">+{stats.additions}</span>}
              {stats.additions > 0 && stats.deletions > 0 && ' '}
              {stats.deletions > 0 && <span className="text-red-400">-{stats.deletions}</span>}
            </span>
          </div>
        )}
      </motion.div>
    </>
  )
}
