import { useState, useEffect, useCallback } from 'react'
import { useSessionStore } from '../../store/session-store'
import { GitSyncActionButton } from './GitPanelControls'
import type { GitLogEntry, GitCommitFileStatus } from '../../../../preload/index.d'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(isoDate: string): string {
  const now = Date.now()
  const then = new Date(isoDate).getTime()
  const diff = now - then
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  const years = Math.floor(months / 12)
  return `${years}y ago`
}

function commitFileStatusLetter(status: GitCommitFileStatus['status']): string {
  return status
}

function commitFileStatusColor(status: GitCommitFileStatus['status']): string {
  switch (status) {
    case 'A':
      return 'text-green-400'
    case 'M':
    case 'T':
      return 'text-git-modified'
    case 'D':
      return 'text-red-400'
    case 'R':
    case 'C':
      return 'text-blue-400'
  }
}

// ---------------------------------------------------------------------------
// CommitDetail — expanded commit showing changed files
// ---------------------------------------------------------------------------

function CommitDetail({
  cwd,
  commit,
  activeDiffFile,
  onSelectFile,
  onClose
}: {
  cwd: string
  commit: GitLogEntry
  activeDiffFile: string | null
  onSelectFile: (file: GitCommitFileStatus, allFiles: GitCommitFileStatus[], clickY: number) => void
  onClose: () => void
}): React.JSX.Element {
  const [files, setFiles] = useState<GitCommitFileStatus[]>([])
  const [loading, setLoading] = useState(true)
  // A new commit (or repo) is loading again from its first render, rather than
  // one frame later from the effect that fetches it.
  const commitKey = `${cwd}\n${commit.hash}`
  const [loadingKey, setLoadingKey] = useState(commitKey)
  if (commitKey !== loadingKey) {
    setLoadingKey(commitKey)
    setLoading(true)
  }

  useEffect(() => {
    let cancelled = false
    window.electronAPI
      .gitCommitFiles(cwd, commit.hash)
      .then((result) => {
        if (!cancelled) setFiles(result)
      })
      .catch(() => {
        if (!cancelled) setFiles([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [cwd, commit.hash])

  return (
    <div className="border-t border-border-subtle bg-surface-50/50">
      {/* Commit message + metadata */}
      <div className="px-3 py-1.5 space-y-0.5">
        <p className="text-xs text-text-primary whitespace-pre-wrap break-words">{commit.message}</p>
        <div className="text-[10px] text-text-tertiary flex items-center gap-2">
          <span>{commit.author}</span>
          <span>{relativeTime(commit.date)}</span>
          <button
            className="ml-auto text-text-tertiary hover:text-text-primary transition-colors"
            onClick={onClose}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path
                d="M2 2l6 6M8 2l-6 6"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </div>

      {/* Changed files */}
      {loading ? (
        <div className="px-3 py-2 text-[10px] text-text-tertiary">Loading files...</div>
      ) : files.length === 0 ? (
        <div className="px-3 py-2 text-[10px] text-text-tertiary">No files changed</div>
      ) : (
        <div className="pb-1">
          {files.map((file) => {
            const fileName = file.path.includes('/')
              ? file.path.split('/').pop()!
              : file.path
            const dir = file.path.includes('/')
              ? file.path.slice(0, file.path.lastIndexOf('/') + 1)
              : ''
            const isActive = activeDiffFile === file.path
            return (
              <div
                key={file.path}
                className={`flex items-center gap-1.5 px-3 py-0.5 text-xs transition-colors cursor-pointer group ${
                  isActive ? 'bg-accent/15 border-l-2 border-l-accent' : 'hover:bg-surface-100 border-l-2 border-l-transparent'
                }`}
                onClick={(e) => onSelectFile(file, files, e.clientY)}
              >
                <span
                  className={`font-mono w-3 flex-shrink-0 ${commitFileStatusColor(file.status)}`}
                >
                  {commitFileStatusLetter(file.status)}
                </span>
                <span className="text-text-primary truncate hover:underline">{fileName}</span>
                {dir && (
                  <span className="text-text-tertiary truncate text-[10px]">{dir}</span>
                )}
                <span className="ml-auto flex-shrink-0 text-[10px] font-mono text-text-tertiary">
                  {file.insertions > 0 && (
                    <span className="text-green-400">+{file.insertions}</span>
                  )}
                  {file.insertions > 0 && file.deletions > 0 && ' '}
                  {file.deletions > 0 && (
                    <span className="text-red-400">-{file.deletions}</span>
                  )}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// CommitRow — a single row in the log list
// ---------------------------------------------------------------------------

function CommitRow({
  commit,
  isExpanded,
  onClick,
  variant
}: {
  commit: GitLogEntry
  isExpanded: boolean
  onClick: () => void
  variant?: 'outgoing' | 'incoming' | 'normal'
}): React.JSX.Element {
  // Subtle left border for outgoing/incoming commits
  const borderClass =
    variant === 'outgoing'
      ? 'border-l-2 border-l-green-400/40'
      : variant === 'incoming'
        ? 'border-l-2 border-l-git-incoming/40'
        : 'border-l-2 border-l-transparent'

  return (
    <div
      className={`flex items-center gap-2 px-3 py-1 text-xs transition-colors cursor-pointer ${borderClass} ${
        isExpanded ? 'bg-surface-100' : 'hover:bg-surface-100/50'
      }`}
      onClick={onClick}
    >
      <span className="font-mono text-text-tertiary flex-shrink-0 text-[10px]">
        {commit.shortHash}
      </span>
      <span className="text-text-primary truncate flex-1" title={commit.message}>{commit.message}</span>
      <span className="text-[10px] text-text-tertiary flex-shrink-0 whitespace-nowrap">
        {relativeTime(commit.date)}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SectionHeader for the log
// ---------------------------------------------------------------------------

function LogSectionHeader({
  label,
  count,
  color,
  tone,
  action,
  actionTitle,
  onAction,
  actionDisabled
}: {
  label: string
  count: number
  color: string
  /** Tints the sync button — the changes view spells these out the same way. */
  tone?: 'incoming' | 'outgoing'
  action?: string
  actionTitle?: string
  onAction?: () => void
  actionDisabled?: boolean
}): React.JSX.Element {
  return (
    <div className="flex items-center px-3 pt-2.5 pb-1">
      <span className={`text-[10px] font-semibold uppercase tracking-wider ${color}`}>
        {label} ({count})
      </span>
      {action && onAction && tone && (
        <span className="ml-auto">
          <GitSyncActionButton
            tone={tone}
            label={action}
            title={actionTitle ?? action}
            disabled={actionDisabled}
            onClick={onAction}
          />
        </span>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// SyncDivider — visual separator between sections
// ---------------------------------------------------------------------------

function SyncDivider({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <div className="flex-1 h-px bg-border-subtle" />
      <span className="text-[9px] uppercase tracking-wider text-text-tertiary font-medium">
        {label}
      </span>
      <div className="flex-1 h-px bg-border-subtle" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// GitLogView — main exported component
// ---------------------------------------------------------------------------

export function GitLogView({
  cwd,
  branch,
  ahead,
  behind
}: {
  cwd: string
  branch: string
  ahead: number
  behind: number
}): React.JSX.Element {
  const setDiffPreview = useSessionStore((s) => s.setDiffPreview)
  const [outgoing, setOutgoing] = useState<GitLogEntry[]>([])
  const [incoming, setIncoming] = useState<GitLogEntry[]>([])
  const [history, setHistory] = useState<GitLogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [operating, setOperating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expandedHash, setExpandedHash] = useState<string | null>(null)

  const diffPreview = useSessionStore((s) => s.diffPreview)

  const openCommitDiff = useCallback(
    (hash: string, file: GitCommitFileStatus, allFiles: GitCommitFileStatus[], clickY?: number) => {
      setDiffPreview({
        file: file.path,
        cwd,
        type: 'commit',
        staged: false,
        fileStatus: file.status,
        hash,
        siblings: allFiles.map((f) => ({ file: f.path, staged: false, fileStatus: f.status })),
        clickY
      })
    },
    [cwd, setDiffPreview]
  )

  const fetchLog = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)

      const [outgoingResult, incomingResult, logResult] = await Promise.all([
        ahead > 0 ? window.electronAPI.gitOutgoingCommits(cwd) : Promise.resolve([]),
        behind > 0 ? window.electronAPI.gitIncomingCommits(cwd) : Promise.resolve([]),
        window.electronAPI.gitLog(cwd, 100)
      ])

      setOutgoing(outgoingResult)
      setIncoming(incomingResult)

      // Filter out outgoing commits from the full log to avoid duplicates
      const outgoingHashes = new Set(outgoingResult.map((c) => c.hash))
      setHistory(logResult.filter((c) => !outgoingHashes.has(c.hash)))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [cwd, ahead, behind])

  useEffect(() => {
    fetchLog()
  }, [fetchLog])

  const handlePush = useCallback(async () => {
    setOperating(true)
    setError(null)
    try {
      await window.electronAPI.gitPush(cwd)
      await fetchLog()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setOperating(false)
    }
  }, [cwd, fetchLog])

  const handlePull = useCallback(async () => {
    setOperating(true)
    setError(null)
    try {
      await window.electronAPI.gitPull(cwd, 'auto')
      await fetchLog()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setOperating(false)
    }
  }, [cwd, fetchLog])

  const toggleCommit = useCallback(
    (hash: string) => {
      setExpandedHash((prev) => (prev === hash ? null : hash))
    },
    []
  )

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-xs text-text-tertiary">Loading history...</span>
      </div>
    )
  }

  const hasOutgoing = outgoing.length > 0
  const hasIncoming = incoming.length > 0
  const hasSections = hasOutgoing || hasIncoming

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {error && (
        <div className="px-3 py-1.5 bg-red-500/10 text-red-400 text-xs flex-shrink-0">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {/* Outgoing commits */}
        {hasOutgoing && (
          <>
            <LogSectionHeader
              label="Outgoing"
              count={outgoing.length}
              color="text-green-400"
              tone="outgoing"
              action="Push"
              actionTitle="Push these commits to the remote"
              onAction={handlePush}
              actionDisabled={operating}
            />
            {outgoing.map((commit) => (
              <div key={commit.hash}>
                <CommitRow
                  commit={commit}
                  isExpanded={expandedHash === commit.hash}
                  onClick={() => toggleCommit(commit.hash)}
                  variant="outgoing"
                />
                {expandedHash === commit.hash && (
                  <CommitDetail
                    cwd={cwd}
                    commit={commit}
                    activeDiffFile={diffPreview?.hash === commit.hash ? diffPreview.file : null}
                    onSelectFile={(file, allFiles, clickY) =>
                      openCommitDiff(commit.hash, file, allFiles, clickY)
                    }
                    onClose={() => setExpandedHash(null)}
                  />
                )}
              </div>
            ))}
          </>
        )}

        {/* Incoming commits */}
        {hasIncoming && (
          <>
            {hasOutgoing && <SyncDivider label={`origin/${branch}`} />}
            <LogSectionHeader
              label="Incoming"
              count={incoming.length}
              color="text-git-incoming"
              tone="incoming"
              action="Pull (rebase)"
              actionTitle="Pull these commits — fast-forward if possible, otherwise rebase (autostash)"
              onAction={handlePull}
              actionDisabled={operating}
            />
            {incoming.map((commit) => (
              <div key={commit.hash}>
                <CommitRow
                  commit={commit}
                  isExpanded={expandedHash === commit.hash}
                  onClick={() => toggleCommit(commit.hash)}
                  variant="incoming"
                />
                {expandedHash === commit.hash && (
                  <CommitDetail
                    cwd={cwd}
                    commit={commit}
                    activeDiffFile={diffPreview?.hash === commit.hash ? diffPreview.file : null}
                    onSelectFile={(file, allFiles, clickY) =>
                      openCommitDiff(commit.hash, file, allFiles, clickY)
                    }
                    onClose={() => setExpandedHash(null)}
                  />
                )}
              </div>
            ))}
          </>
        )}

        {/* Synced history */}
        {hasSections && <SyncDivider label="history" />}
        {history.map((commit) => (
          <div key={commit.hash}>
            <CommitRow
              commit={commit}
              isExpanded={expandedHash === commit.hash}
              onClick={() => toggleCommit(commit.hash)}
              variant="normal"
            />
            {expandedHash === commit.hash && (
              <CommitDetail
                cwd={cwd}
                commit={commit}
                activeDiffFile={diffPreview?.hash === commit.hash ? diffPreview.file : null}
                onSelectFile={(file, allFiles, clickY) =>
                  openCommitDiff(commit.hash, file, allFiles, clickY)
                }
                onClose={() => setExpandedHash(null)}
              />
            )}
          </div>
        ))}

        {!hasOutgoing && !hasIncoming && history.length === 0 && (
          <div className="flex-1 flex items-center justify-center py-8">
            <span className="text-xs text-text-tertiary">No commit history</span>
          </div>
        )}
        {/* Breathing room under the last commit — the list can be scrolled a
            little past its end instead of stopping flush on the panel edge. */}
        <div className="flex-shrink-0 h-12" aria-hidden />
      </div>
    </div>
  )
}
