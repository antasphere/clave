import { useCallback, useState } from 'react'
import { useSessionStore, type FileTab } from '../../store/session-store'
import { useDiff } from '../../hooks/use-diff'
import { useCopyFeedback } from '../../hooks/use-copy-feedback'
import { cn } from '@clave/ui/components'
import { CheckIcon } from '@heroicons/react/24/outline'
import { DiffLinesView } from '../git/DiffLinesView'
import { CopyIcon, FolderIcon, CloseIcon, fileActionButtonClass } from './FileActionIcons'

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

function statusColor(status: string): string {
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

interface DiffViewerProps {
  fileTab: FileTab
}

export function DiffViewer({ fileTab }: DiffViewerProps) {
  const removeFileTab = useSessionStore((s) => s.removeFileTab)
  const triggerGitRefresh = useSessionStore((s) => s.triggerGitRefresh)
  const gitRefreshTrigger = useSessionStore((s) => s.gitRefreshTrigger)
  const setFileTabDiffStaged = useSessionStore((s) => s.setFileTabDiffStaged)
  const fileTabs = useSessionStore((s) => s.fileTabs)

  const [operating, setOperating] = useState(false)

  const diff = fileTab.diff
  // Re-read latest tab from the store so stage/unstage can flip `staged` live
  const liveTab = fileTabs.find((t) => t.id === fileTab.id) ?? fileTab
  const liveDiff = liveTab.diff ?? diff

  const { diffLines, raw, loading, error, stats } = useDiff({
    cwd: liveDiff?.cwd ?? '',
    file: liveDiff?.file ?? '',
    type: liveDiff?.type ?? 'working',
    staged: liveDiff?.staged ?? false,
    fileStatus: liveDiff?.fileStatus ?? '',
    hash: liveDiff?.hash ?? null,
    refreshKey: gitRefreshTrigger
  })

  const filename = fileTab.filePath.split('/').pop() ?? ''

  const { copied, copy } = useCopyFeedback()
  // What you are looking at here is the patch, so that is what the button hands over.
  const canCopyPatch = !loading && !error && raw.length > 0

  const handleRevealInFinder = useCallback(() => {
    window.electronAPI?.showItemInFolder(fileTab.filePath)
  }, [fileTab.filePath])

  const handleStageToggle = useCallback(async () => {
    if (!liveDiff || liveDiff.type !== 'working' || operating) return
    setOperating(true)
    try {
      if (liveDiff.staged) {
        await window.electronAPI.gitUnstage(liveDiff.cwd, [liveDiff.file])
      } else {
        await window.electronAPI.gitStage(liveDiff.cwd, [liveDiff.file])
      }
      setFileTabDiffStaged(fileTab.id, !liveDiff.staged)
      triggerGitRefresh()
    } catch {
      // silently ignore
    } finally {
      setOperating(false)
    }
  }, [liveDiff, operating, triggerGitRefresh, setFileTabDiffStaged, fileTab.id])

  if (!liveDiff) {
    return (
      <div className="flex items-center justify-center h-full text-xs text-text-tertiary">
        Diff information missing
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-surface-0">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border-subtle flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className={`font-mono text-xs flex-shrink-0 ${statusColor(liveDiff.fileStatus)}`}
            title={liveDiff.fileStatus}
          >
            {statusDisplayLetter(liveDiff.fileStatus)}
          </span>
          <span className="text-sm font-medium text-text-primary truncate">{fileTab.name}</span>
          {fileTab.name !== filename && (
            <span className="text-xs text-text-tertiary truncate hidden sm:inline">{filename}</span>
          )}
          <span className="text-[10px] text-text-tertiary flex-shrink-0 uppercase tracking-wider">
            {liveDiff.type === 'commit' ? 'commit diff' : liveDiff.staged ? 'staged diff' : 'diff'}
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 ml-2">
          {liveDiff.type === 'working' && (
            <button
              onClick={handleStageToggle}
              disabled={operating}
              className="px-2 py-1 rounded text-xs text-text-secondary hover:text-text-primary hover:bg-surface-200 transition-colors disabled:opacity-40"
            >
              {liveDiff.staged ? 'Unstage' : 'Stage'}
            </button>
          )}
          {liveDiff.type === 'commit' && liveDiff.hash && (
            <span className="text-[10px] text-text-tertiary font-mono px-1">
              {liveDiff.hash.slice(0, 7)}
            </span>
          )}
          <button
            onClick={() => copy(raw)}
            disabled={!canCopyPatch}
            className={cn(fileActionButtonClass, copied && 'text-status-ready')}
            title={canCopyPatch ? 'Copy diff' : 'Nothing to copy'}
          >
            {copied ? <CheckIcon className="w-3 h-3" /> : <CopyIcon />}
          </button>
          <button
            onClick={handleRevealInFinder}
            className={fileActionButtonClass}
            title="Reveal in Finder"
          >
            <FolderIcon />
          </button>
          <button
            onClick={() => removeFileTab(fileTab.id)}
            className={fileActionButtonClass}
            title="Close"
          >
            <CloseIcon />
          </button>
        </div>
      </div>

      {/* Full path breadcrumb */}
      <div className="px-4 py-1 border-b border-border-subtle flex-shrink-0">
        <span className="text-[10px] text-text-tertiary truncate block">
          {fileTab.filePath.replace(/^\/Users\/[^/]+/, '~')}
        </span>
      </div>

      {/* Diff content */}
      <DiffLinesView lines={diffLines} loading={loading} error={error} className="flex-1 min-h-0" />

      {/* Footer */}
      {!loading && !error && diffLines.length > 0 && (
        <div className="flex items-center justify-between px-4 py-1.5 border-t border-border-subtle text-[10px] text-text-tertiary flex-shrink-0">
          <span>{diffLines.length} lines</span>
          <span>
            {stats.additions > 0 && <span className="text-green-400">+{stats.additions}</span>}
            {stats.additions > 0 && stats.deletions > 0 && ' '}
            {stats.deletions > 0 && <span className="text-red-400">-{stats.deletions}</span>}
          </span>
        </div>
      )}
    </div>
  )
}
