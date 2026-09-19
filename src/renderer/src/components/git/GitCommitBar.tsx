import { useState, useCallback, useEffect, useRef } from 'react'
import { ChevronDownIcon, SparklesIcon } from '@heroicons/react/24/outline'
import { IconButton } from '@clave/ui/components'
import { useSessionStore } from '../../store/session-store'
import type { PullStrategy } from './git-status-utils'

export function PullButton({
  cwd,
  operating,
  onOperation
}: {
  cwd: string
  operating: boolean
  onOperation: (fn: () => Promise<void>) => void
}) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  const handlePull = useCallback(
    (strategy: PullStrategy) => {
      setMenuOpen(false)
      onOperation(async () => {
        await window.electronAPI.gitPull(cwd, strategy)
      })
    },
    [cwd, onOperation]
  )

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  return (
    <div className="relative" ref={menuRef}>
      <div className="flex items-center">
        <IconButton
          className="text-xs font-medium pl-2 pr-1 py-1 rounded-l bg-surface-100 text-text-secondary hover:text-text-primary disabled:opacity-40 transition-all"
          disabled={operating}
          onClick={() => handlePull('auto')}
          tooltip="Pull remote changes"
          side="top"
        >
          {'\u2193'} Pull
        </IconButton>
        <IconButton
          className="text-xs py-1 pr-1.5 pl-0.5 rounded-r bg-surface-100 text-text-tertiary hover:text-text-primary disabled:opacity-40 transition-all border-l border-border-subtle"
          disabled={operating}
          onClick={() => setMenuOpen((v) => !v)}
          tooltip="Pull options"
          side="top"
        >
          <ChevronDownIcon className="w-3 h-3" />
        </IconButton>
      </div>
      {menuOpen && (
        <div
          className="menu-surface menu-pop-mount absolute bottom-full right-0 mb-1 z-50 min-w-[160px] p-1"
          // Opens upward from the bar, so it grows from its bottom edge.
          style={{ transformOrigin: '100% 100%' }}
        >
          {([
            ['auto', 'Pull'],
            ['merge', 'Pull (Merge)'],
            ['rebase', 'Pull (Rebase)'],
            ['ff-only', 'Pull (FF only)']
          ] as [PullStrategy, string][]).map(([strategy, label]) => (
            <button
              key={strategy}
              className="menu-item menu-item--muted"
              onClick={() => handlePull(strategy)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function CommitBar({
  cwd,
  stagedCount,
  totalFileCount,
  unstagedFilePaths,
  ahead,
  behind,
  hasUpstream,
  operating,
  onOperation
}: {
  cwd: string
  stagedCount: number
  totalFileCount: number
  unstagedFilePaths: string[]
  ahead: number
  behind: number
  hasUpstream: boolean
  operating: boolean
  onOperation: (fn: () => Promise<void>) => void
}) {
  const commitMessage = useSessionStore((s) => s.commitMessages[cwd] ?? '')
  const generating = useSessionStore((s) => s.generatingCommitCwds.has(cwd))
  const [generateError, setGenerateError] = useState<string | null>(null)
  const setCommitMessage = useCallback(
    (msg: string) => useSessionStore.getState().setCommitMessage(cwd, msg),
    [cwd]
  )

  const handleGenerateMessage = useCallback(async () => {
    if (totalFileCount === 0 || generating) return
    setGenerateError(null)
    const store = useSessionStore.getState()
    store.setGeneratingCommit(cwd, true)
    try {
      // Only stage files that aren't already staged
      if (unstagedFilePaths.length > 0) {
        await window.electronAPI.gitStage(cwd, unstagedFilePaths)
      }
      const message = await window.electronAPI.gitGenerateCommitMessage(cwd)
      // Write to store directly so it persists even if component unmounted
      useSessionStore.getState().setCommitMessage(cwd, message)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('Failed to generate commit message:', msg)
      setGenerateError(msg)
    } finally {
      useSessionStore.getState().setGeneratingCommit(cwd, false)
    }
  }, [cwd, totalFileCount, unstagedFilePaths, generating])

  const handleCommit = useCallback(() => {
    if (!commitMessage.trim() || stagedCount === 0) return
    const msg = commitMessage
    onOperation(async () => {
      await window.electronAPI.gitCommit(cwd, msg)
      useSessionStore.getState().setCommitMessage(cwd, '')
    })
  }, [cwd, commitMessage, stagedCount, onOperation])

  const handlePush = useCallback(() => {
    onOperation(async () => {
      await window.electronAPI.gitPush(cwd)
    })
  }, [cwd, onOperation])

  const handlePublishBranch = useCallback(() => {
    onOperation(async () => {
      await window.electronAPI.gitPublishBranch(cwd)
    })
  }, [cwd, onOperation])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && e.metaKey) {
        e.preventDefault()
        handleCommit()
      }
    },
    [handleCommit]
  )

  return (
    <div className="border-t border-border-subtle p-2 flex-shrink-0 flex flex-col gap-2">
      <div className="relative">
        <textarea
          className="w-full bg-surface-100 text-text-primary text-xs rounded px-2 py-1.5 pr-7 resize-none outline-none border border-transparent focus:border-accent placeholder:text-text-tertiary"
          rows={2}
          placeholder={generating ? 'Generating commit message...' : 'Commit message...'}
          value={commitMessage}
          onChange={(e) => setCommitMessage(e.target.value as string)}
          onKeyDown={handleKeyDown}
          disabled={operating || generating}
        />
        <IconButton
          className="absolute right-1.5 top-1.5 p-0.5 rounded text-text-tertiary hover:text-accent disabled:opacity-30 transition-colors"
          disabled={totalFileCount === 0 || generating || operating}
          onClick={handleGenerateMessage}
          tooltip="Generate commit message"
          side="top"
        >
          {generating ? (
            <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          ) : (
            <SparklesIcon className="w-3.5 h-3.5" />
          )}
        </IconButton>
      </div>
      {generateError && (
        <div className="text-[10px] text-red-400 px-1 truncate" title={generateError}>
          {generateError}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <button
          className="flex-1 text-xs font-medium px-2 py-1 rounded bg-accent text-white disabled:opacity-40 transition-opacity"
          disabled={operating || stagedCount === 0 || !commitMessage.trim()}
          onClick={handleCommit}
        >
          Commit
        </button>
        {!hasUpstream ? (
          <IconButton
            className="text-xs font-medium px-2 py-1 rounded bg-green-500/15 text-green-400 hover:bg-green-500/25 disabled:opacity-40 transition-all"
            disabled={operating}
            onClick={handlePublishBranch}
            tooltip="Publish branch to origin (git push -u)"
            side="top"
          >
            {'\u2191'} Publish Branch{ahead > 0 ? ` (${ahead})` : ''}
          </IconButton>
        ) : (
          <>
            {ahead > 0 && (
              <IconButton
                className="text-xs font-medium px-2 py-1 rounded bg-green-500/15 text-green-400 hover:bg-green-500/25 disabled:opacity-40 transition-all"
                disabled={operating}
                onClick={handlePush}
                tooltip="Push to remote"
                side="top"
              >
                {'\u2191'} Push
              </IconButton>
            )}
            {behind > 0 && (
              <PullButton cwd={cwd} operating={operating} onOperation={onOperation} />
            )}
          </>
        )}
      </div>
    </div>
  )
}
