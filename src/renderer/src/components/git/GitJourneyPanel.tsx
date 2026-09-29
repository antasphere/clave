import { useState, useCallback, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { useSessionStore } from '../../store/session-store'
import { useGitJourney } from '../../hooks/use-git-journey'
import type { GitLogEntry, GitPushGroup, GitCommitFileStatus } from '../../../../preload/index.d'
import { ArrowPathIcon } from '@heroicons/react/24/outline'
import { CloseIcon, fileActionButtonClass } from '../files/FileActionIcons'

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
// CommitDot — a single dot in the push row
// ---------------------------------------------------------------------------

function CommitDot({
  commit,
  variant,
  isSelected,
  onClick
}: {
  commit: GitLogEntry
  variant: 'local' | 'pushed'
  isSelected?: boolean
  onClick: () => void
}): React.JSX.Element {
  const [hovered, setHovered] = useState(false)
  const dotRef = useRef<HTMLButtonElement>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (hovered && dotRef.current) {
      const rect = dotRef.current.getBoundingClientRect()
      setTooltipPos({ x: rect.left + rect.width / 2, y: rect.top })
    } else {
      setTooltipPos(null)
    }
  }, [hovered])

  const baseColor =
    variant === 'local'
      ? isSelected
        ? 'bg-green-300 scale-150'
        : 'bg-green-400 hover:bg-green-300 hover:scale-150'
      : isSelected
        ? 'bg-accent scale-150'
        : 'bg-text-tertiary hover:bg-accent hover:scale-150'

  return (
    <>
      <button
        ref={dotRef}
        className={`w-[7px] h-[7px] rounded-full transition-all ${baseColor}`}
        onClick={onClick}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      <AnimatePresence>
        {hovered && tooltipPos && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.1 }}
            className="fixed z-[100] px-2 py-1 rounded bg-surface-300 border border-border-subtle shadow-lg whitespace-nowrap pointer-events-none"
            style={{
              left: tooltipPos.x,
              top: tooltipPos.y - 8,
              transform: 'translate(-50%, -100%)'
            }}
          >
            <span className="text-[10px] font-mono text-text-tertiary">{commit.shortHash}</span>
            <span className="text-[10px] text-text-secondary ml-1.5">
              {commit.message.slice(0, 50)}
              {commit.message.length > 50 ? '...' : ''}
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

// ---------------------------------------------------------------------------
// CommitFileRow — a file in an expanded commit
// ---------------------------------------------------------------------------

function CommitFileRow({
  file,
  isFocused,
  onClick
}: {
  file: GitCommitFileStatus
  isFocused: boolean
  onClick: () => void
}): React.JSX.Element {
  const fileName = file.path.includes('/') ? file.path.split('/').pop()! : file.path
  const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : ''

  return (
    <div
      className={`flex items-center gap-1.5 pl-6 pr-3 py-0.5 text-xs transition-colors cursor-pointer ${
        isFocused ? 'bg-surface-200' : 'hover:bg-surface-100/50'
      }`}
      onClick={onClick}
    >
      <span className={`font-mono w-3 flex-shrink-0 ${commitFileStatusColor(file.status)}`}>
        {file.status}
      </span>
      <span className="text-text-primary truncate hover:underline">{fileName}</span>
      {dir && <span className="text-text-tertiary truncate text-[10px]">{dir}</span>}
      <span className="ml-auto flex-shrink-0 text-[10px] font-mono text-text-tertiary">
        {file.insertions > 0 && <span className="text-green-400">+{file.insertions}</span>}
        {file.insertions > 0 && file.deletions > 0 && ' '}
        {file.deletions > 0 && <span className="text-red-400">-{file.deletions}</span>}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Types for flat navigation
// ---------------------------------------------------------------------------

type NavItem =
  | { type: 'push'; groupId: string }
  | { type: 'commit'; groupId: string; hash: string }
  | { type: 'file'; groupId: string; hash: string; filePath: string }

function navItemKey(item: NavItem): string {
  if (item.type === 'push') return `push:${item.groupId}`
  if (item.type === 'commit') return `commit:${item.hash}`
  return `file:${item.hash}:${item.filePath}`
}

// ---------------------------------------------------------------------------
// GitJourneyPanel — main exported component
// ---------------------------------------------------------------------------

export function GitJourneyPanel(): React.JSX.Element | null {
  const journeyPanel = useSessionStore((s) => s.journeyPanel)
  const closeJourneyPanel = useSessionStore((s) => s.closeJourneyPanel)
  const setDiffPreview = useSessionStore((s) => s.setDiffPreview)
  const diffPreview = useSessionStore((s) => s.diffPreview)
  const fileTreeOpen = useSessionStore((s) => s.fileTreeOpen)
  const fileTreeWidth = useSessionStore((s) => s.fileTreeWidth)

  const { data, loading, error, refresh, loadMore } = useGitJourney(
    journeyPanel?.cwd ?? null,
    !!journeyPanel
  )

  // Centralized expand state
  const [expandedPushIds, setExpandedPushIds] = useState<Set<string>>(new Set())
  const [expandedCommitHashes, setExpandedCommitHashes] = useState<Set<string>>(new Set())

  // Commit files cache
  const [commitFilesCache, setCommitFilesCache] = useState<Record<string, GitCommitFileStatus[]>>(
    {}
  )
  const [loadingCommits, setLoadingCommits] = useState<Set<string>>(new Set())

  // AI summary state
  const [summaries, setSummaries] = useState<
    Record<string, { title: string; description: string }>
  >({})
  const [summarizing, setSummarizing] = useState<Set<string>>(new Set())
  const summaryFetched = useRef<Set<string>>(new Set())

  // Focused item for keyboard nav — use ref to avoid stale closures in keydown handler
  const [focusedKey, setFocusedKey] = useState<string | null>(null)
  const focusedKeyRef = useRef<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  // Keep ref in sync
  useEffect(() => {
    focusedKeyRef.current = focusedKey
  }, [focusedKey])

  const togglePush = useCallback((groupId: string) => {
    setExpandedPushIds((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [])

  const toggleCommit = useCallback((hash: string) => {
    setExpandedCommitHashes((prev) => {
      const next = new Set(prev)
      if (next.has(hash)) next.delete(hash)
      else next.add(hash)
      return next
    })
  }, [])

  // Fetch commit files when a commit is expanded
  useEffect(() => {
    if (!journeyPanel) return
    for (const hash of expandedCommitHashes) {
      if (commitFilesCache[hash] || loadingCommits.has(hash)) continue
      // eslint-disable-next-line react-hooks/set-state-in-effect -- marks the request in flight in the same step that sends it, so the next run of this effect does not send it twice
      setLoadingCommits((prev) => new Set(prev).add(hash))
      window.electronAPI
        .gitCommitFiles(journeyPanel.cwd, hash)
        .then((files) => setCommitFilesCache((prev) => ({ ...prev, [hash]: files })))
        .catch(() => setCommitFilesCache((prev) => ({ ...prev, [hash]: [] })))
        .finally(() =>
          setLoadingCommits((prev) => {
            const next = new Set(prev)
            next.delete(hash)
            return next
          })
        )
    }
  }, [expandedCommitHashes, journeyPanel, commitFilesCache, loadingCommits])

  // Fetch AI summaries when a push is expanded
  useEffect(() => {
    if (!journeyPanel || !data) return
    for (const groupId of expandedPushIds) {
      if (summaries[groupId] || summarizing.has(groupId) || summaryFetched.current.has(groupId))
        continue
      summaryFetched.current.add(groupId)
      const group = [
        ...data.pushGroups,
        ...(data.local.length > 0
          ? [{ id: 'local', commits: data.local, pushedAt: '' } as GitPushGroup]
          : [])
      ].find((g) => g.id === groupId)
      if (!group) continue

      // eslint-disable-next-line react-hooks/set-state-in-effect -- marks the request in flight in the same step that sends it, beside the IPC call this effect exists to make
      setSummarizing((prev) => new Set(prev).add(groupId))
      const messages = group.commits.map((c) => c.message)
      window.electronAPI
        .gitSummarizePush(journeyPanel.cwd, messages, `${group.commits.length} commit(s)`)
        .then((result) => setSummaries((prev) => ({ ...prev, [groupId]: result })))
        .catch(() =>
          setSummaries((prev) => ({
            ...prev,
            [groupId]: { title: messages[0] || 'Changes', description: '' }
          }))
        )
        .finally(() =>
          setSummarizing((prev) => {
            const next = new Set(prev)
            next.delete(groupId)
            return next
          })
        )
    }
  }, [expandedPushIds, journeyPanel, data, summaries, summarizing])

  // Build flat nav list from current state
  const buildNavList = useCallback((): NavItem[] => {
    if (!data) return []
    const items: NavItem[] = []

    // Local commits
    if (data.local.length > 0) {
      items.push({ type: 'push', groupId: 'local' })
      if (expandedPushIds.has('local')) {
        for (const commit of data.local) {
          items.push({ type: 'commit', groupId: 'local', hash: commit.hash })
          if (expandedCommitHashes.has(commit.hash) && commitFilesCache[commit.hash]) {
            for (const file of commitFilesCache[commit.hash]) {
              items.push({ type: 'file', groupId: 'local', hash: commit.hash, filePath: file.path })
            }
          }
        }
      }
    }

    // Push groups
    for (const group of data.pushGroups) {
      items.push({ type: 'push', groupId: group.id })
      if (expandedPushIds.has(group.id)) {
        for (const commit of group.commits) {
          items.push({ type: 'commit', groupId: group.id, hash: commit.hash })
          if (expandedCommitHashes.has(commit.hash) && commitFilesCache[commit.hash]) {
            for (const file of commitFilesCache[commit.hash]) {
              items.push({
                type: 'file',
                groupId: group.id,
                hash: commit.hash,
                filePath: file.path
              })
            }
          }
        }
      }
    }
    return items
  }, [data, expandedPushIds, expandedCommitHashes, commitFilesCache])

  const onSelectFile = useCallback(
    (hash: string, file: GitCommitFileStatus) => {
      if (!journeyPanel) return
      const files = commitFilesCache[hash] ?? []
      setDiffPreview(
        {
          file: file.path,
          cwd: journeyPanel.cwd,
          type: 'commit',
          staged: false,
          fileStatus: file.status,
          hash,
          siblings: files.map((f) => ({ file: f.path, staged: false, fileStatus: f.status }))
        },
        { fromJourney: true }
      )
    },
    [journeyPanel, setDiffPreview, commitFilesCache]
  )

  // Stable refs for the keyboard handler to avoid stale closures
  const buildNavListRef = useRef(buildNavList)
  const commitFilesCacheRef = useRef(commitFilesCache)
  const diffPreviewRef = useRef(diffPreview)
  useEffect(() => {
    buildNavListRef.current = buildNavList
  }, [buildNavList])
  useEffect(() => {
    commitFilesCacheRef.current = commitFilesCache
  }, [commitFilesCache])
  useEffect(() => {
    diffPreviewRef.current = diffPreview
  }, [diffPreview])

  // Keyboard navigation — single handler, registered once
  useEffect(() => {
    if (!journeyPanel) return
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (diffPreviewRef.current) {
          setDiffPreview(null)
        } else {
          closeJourneyPanel()
        }
        return
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const navList = buildNavListRef.current()
        if (navList.length === 0) return

        const current = focusedKeyRef.current
        let currentIdx = current ? navList.findIndex((item) => navItemKey(item) === current) : -1

        // If current focus is no longer in the list, reset
        if (currentIdx === -1) {
          currentIdx = e.key === 'ArrowDown' ? -1 : navList.length
        }

        const nextIdx =
          e.key === 'ArrowDown'
            ? Math.min(currentIdx + 1, navList.length - 1)
            : Math.max(currentIdx - 1, 0)

        const next = navList[nextIdx]
        const key = navItemKey(next)
        focusedKeyRef.current = key
        setFocusedKey(key)

        // If it's a file, show its diff
        if (next.type === 'file') {
          const files = commitFilesCacheRef.current[next.hash] ?? []
          const file = files.find((f) => f.path === next.filePath)
          if (file) onSelectFile(next.hash, file)
        } else {
          // Moving onto a push or commit — close diff preview
          setDiffPreview(null)
        }

        requestAnimationFrame(() => {
          const el = contentRef.current?.querySelector(`[data-nav-key="${key}"]`)
          el?.scrollIntoView({ block: 'nearest' })
        })
      }

      if (e.key === 'Enter') {
        e.preventDefault()
        const current = focusedKeyRef.current
        if (!current) return
        const navList = buildNavListRef.current()
        const item = navList.find((i) => navItemKey(i) === current)
        if (!item) return

        if (item.type === 'push') togglePush(item.groupId)
        else if (item.type === 'commit') toggleCommit(item.hash)
        else if (item.type === 'file') {
          const files = commitFilesCacheRef.current[item.hash] ?? []
          const file = files.find((f) => f.path === item.filePath)
          if (file) onSelectFile(item.hash, file)
        }
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [journeyPanel, closeJourneyPanel, setDiffPreview, togglePush, toggleCommit, onSelectFile])

  // Click-outside: close when clicking anywhere outside the panel
  // (ignore clicks on sibling panels like GitDiffPreview)
  useEffect(() => {
    if (!journeyPanel) return
    const handleMouseDown = (e: MouseEvent): void => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        // Don't close if clicking on a sibling floating panel (e.g. diff preview)
        const target = e.target as HTMLElement
        if (target.closest('[data-floating-panel]')) return
        closeJourneyPanel()
      }
    }
    window.addEventListener('mousedown', handleMouseDown)
    return () => window.removeEventListener('mousedown', handleMouseDown)
  }, [journeyPanel, closeJourneyPanel])

  if (!journeyPanel) return null

  const rightOffset = fileTreeOpen ? fileTreeWidth + 8 : 16
  const panelWidth = 480

  // Gather all groups for rendering
  const allGroups: Array<{ group: GitPushGroup; isLocal: boolean }> = []
  if (data?.local && data.local.length > 0) {
    allGroups.push({ group: { id: 'local', pushedAt: '', commits: data.local }, isLocal: true })
  }
  if (data?.pushGroups) {
    for (const g of data.pushGroups) {
      allGroups.push({ group: g, isLocal: false })
    }
  }

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
            top: '4%',
            maxHeight: '92vh',
            width: panelWidth,
            WebkitAppRegion: 'no-drag'
          } as React.CSSProperties
        }
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border-subtle flex-shrink-0">
          <div className="flex-1 min-w-0 flex items-center gap-2">
            <svg
              width="14"
              height="14"
              viewBox="0 0 12 12"
              fill="none"
              className="text-text-secondary flex-shrink-0"
            >
              <circle cx="3" cy="2.5" r="1.3" stroke="currentColor" strokeWidth="1.1" />
              <circle cx="9" cy="6" r="1.3" stroke="currentColor" strokeWidth="1.1" />
              <circle cx="3" cy="9.5" r="1.3" stroke="currentColor" strokeWidth="1.1" />
              <path
                d="M3 3.8v4.4M4.3 2.8l3.4 2.5M7.7 6.7l-3.4 2"
                stroke="currentColor"
                strokeWidth="1.1"
                strokeLinecap="round"
              />
            </svg>
            <div className="min-w-0">
              <div className="text-sm font-medium text-text-primary truncate">
                {journeyPanel.repoName}
              </div>
              {data?.branch && (
                <div className="text-[10px] text-text-tertiary truncate">{data.branch}</div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0 ml-2">
            <button onClick={refresh} className="btn-icon btn-icon-sm" title="Refresh">
              <ArrowPathIcon className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={closeJourneyPanel} className={fileActionButtonClass}>
              <CloseIcon />
            </button>
          </div>
        </div>

        {/* Content */}
        <div ref={contentRef} className="flex-1 overflow-y-auto min-h-0">
          {loading && !data ? (
            <div className="flex items-center justify-center py-12">
              <span className="text-xs text-text-tertiary">Loading journey...</span>
            </div>
          ) : error ? (
            <div className="px-4 py-3 text-xs text-red-400">{error}</div>
          ) : data ? (
            <>
              {data.fallbackMode && (
                <div className="px-4 py-1.5 bg-surface-50 text-[10px] text-text-tertiary border-b border-border-subtle/30">
                  Grouped by day (no push history available)
                </div>
              )}

              {allGroups.map(({ group, isLocal }) => {
                const pushKey = `push:${group.id}`
                const expanded = expandedPushIds.has(group.id)
                const isSummarizing = summarizing.has(group.id)
                const summary = summaries[group.id]

                return (
                  <div key={group.id} className="border-b border-border-subtle/30">
                    {/* Push row header */}
                    <div
                      data-nav-key={pushKey}
                      className={`w-full text-left px-4 py-2.5 transition-colors cursor-pointer ${
                        focusedKey === pushKey ? 'bg-surface-200' : 'hover:bg-surface-100/50'
                      }`}
                      onClick={() => {
                        togglePush(group.id)
                        setFocusedKey(pushKey)
                      }}
                    >
                      {isLocal ? (
                        <div className="flex items-center justify-between gap-2 mb-1.5">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-green-400">
                            Local ({group.commits.length})
                          </span>
                        </div>
                      ) : (
                        <div className="flex items-center justify-between gap-2 mb-1.5">
                          <span className="text-xs text-text-primary truncate font-medium flex items-center gap-1.5">
                            {summary?.title ?? group.commits[0]?.message.slice(0, 60) ?? 'Push'}
                            {isSummarizing && (
                              <span className="w-1.5 h-1.5 rounded-full bg-accent/60 animate-pulse flex-shrink-0" />
                            )}
                          </span>
                          <span className="text-[10px] text-text-tertiary flex-shrink-0 whitespace-nowrap flex items-center gap-1.5">
                            {group.commits[0]?.author && <span>{group.commits[0].author}</span>}
                            <span>{relativeTime(group.pushedAt)}</span>
                          </span>
                        </div>
                      )}
                      {/* Dots */}
                      <div className="flex items-center gap-1 flex-wrap">
                        {group.commits.map((commit) => (
                          <CommitDot
                            key={commit.hash}
                            commit={commit}
                            variant={isLocal ? 'local' : 'pushed'}
                            isSelected={expandedCommitHashes.has(commit.hash)}
                            onClick={() => {
                              if (!expanded) togglePush(group.id)
                              toggleCommit(commit.hash)
                              setFocusedKey(`commit:${commit.hash}`)
                            }}
                          />
                        ))}
                      </div>
                    </div>

                    {/* Expanded content */}
                    <AnimatePresence>
                      {expanded && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.15 }}
                          className="overflow-hidden"
                        >
                          {/* AI description */}
                          {!isLocal && (isSummarizing || summary?.description) && (
                            <div className="px-4 py-1.5 border-t border-border-subtle/30">
                              {isSummarizing && (
                                <div className="flex items-center gap-1.5">
                                  <div className="w-1.5 h-1.5 rounded-full bg-accent/60 animate-pulse" />
                                  <span className="text-[10px] text-text-tertiary">
                                    Generating description...
                                  </span>
                                </div>
                              )}
                              {!isSummarizing && summary?.description && (
                                <p className="text-[11px] text-text-secondary leading-relaxed">
                                  {summary.description}
                                </p>
                              )}
                            </div>
                          )}

                          {/* Commit list */}
                          <div className="border-t border-border-subtle/30">
                            {group.commits.map((commit) => {
                              const commitKey = `commit:${commit.hash}`
                              const commitExpanded = expandedCommitHashes.has(commit.hash)
                              const files = commitFilesCache[commit.hash]
                              const filesLoading = loadingCommits.has(commit.hash)

                              return (
                                <div key={commit.hash}>
                                  <div
                                    data-nav-key={commitKey}
                                    className={`w-full flex items-center gap-2 px-4 py-1 text-xs transition-colors cursor-pointer ${
                                      focusedKey === commitKey
                                        ? 'bg-surface-200'
                                        : 'hover:bg-surface-100/50'
                                    }`}
                                    onClick={() => {
                                      toggleCommit(commit.hash)
                                      setFocusedKey(commitKey)
                                    }}
                                  >
                                    <span className="font-mono text-text-tertiary flex-shrink-0 text-[10px]">
                                      {commit.shortHash}
                                    </span>
                                    <span className="text-text-primary truncate flex-1 text-left">
                                      {commit.message}
                                    </span>
                                    <span className="text-[10px] text-text-tertiary flex-shrink-0">
                                      {relativeTime(commit.date)}
                                    </span>
                                  </div>
                                  {commitExpanded && (
                                    <div className="border-t border-border-subtle/50">
                                      {filesLoading ? (
                                        <div className="pl-6 py-1.5 text-[10px] text-text-tertiary">
                                          Loading files...
                                        </div>
                                      ) : !files || files.length === 0 ? (
                                        <div className="pl-6 py-1.5 text-[10px] text-text-tertiary">
                                          No files changed
                                        </div>
                                      ) : (
                                        <div className="py-0.5">
                                          {files.map((file) => {
                                            const fileKey = `file:${commit.hash}:${file.path}`
                                            return (
                                              <div key={file.path} data-nav-key={fileKey}>
                                                <CommitFileRow
                                                  file={file}
                                                  isFocused={focusedKey === fileKey}
                                                  onClick={() => {
                                                    onSelectFile(commit.hash, file)
                                                    setFocusedKey(fileKey)
                                                  }}
                                                />
                                              </div>
                                            )
                                          })}
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                )
              })}

              {data.hasMore && (
                <button
                  className="w-full py-2 text-[10px] text-text-tertiary hover:text-text-secondary transition-colors"
                  onClick={loadMore}
                >
                  Load more...
                </button>
              )}

              {allGroups.length === 0 && (
                <div className="flex items-center justify-center py-12">
                  <span className="text-xs text-text-tertiary">No commit history</span>
                </div>
              )}
            </>
          ) : null}
        </div>
      </motion.div>
    </>
  )
}
