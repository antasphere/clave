import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react'
import { useSessionStore } from '../../store/session-store'
import { useGitStatus } from '../../hooks/use-git-status'
import { ConfirmDialog } from '@clave/ui/components'
import { ContextMenu } from '../ui/ContextMenu'
import { Tooltip, TooltipTrigger, TooltipContent } from '@clave/ui/components'
import { shortenPath } from '../../lib/utils'
import { ArrowTopRightOnSquareIcon, ArrowUturnLeftIcon, PlusIcon, MinusIcon, InformationCircleIcon, ArrowPathIcon, FolderIcon, CubeIcon, ChevronUpIcon } from '@heroicons/react/24/outline'
import { buildGitTree, compactTree, collectAllDirPaths } from '../../lib/git-file-tree'
import {
  buildRepoTree,
  flattenRepoTree,
  collectRepoTreeDirPaths,
  orderWithWorktrees,
  worktreeSourcePath,
  type FlatRepoRow,
  type RepoTreeDir
} from '../../lib/git-repo-tree'
import { collapsedFromExpanded, toRelative } from '../../lib/panel-expansion'
import { GitLogView } from './GitLogView'
import { FileRow, GitTreeSection } from './GitFileRows'
import {
  SectionHeader,
  ErrorBanner,
  GitSyncBadge,
  GitSyncActionButton,
  GitBaseBadge
} from './GitPanelControls'
import { CommitBar } from './GitCommitBar'
import type { GitFileStatus, GitStatusResult } from '../../../../preload/index.d'
import type { GitRangeDirection } from '../../../../shared/git-range'

// ---------------------------------------------------------------------------
// Per-cwd expanded directory cache — survives RepoSection unmount/remount
// ---------------------------------------------------------------------------

interface ExpandedCache {
  staged: Set<string>
  unstaged: Set<string>
  untracked: Set<string>
}

const expandedCacheMap = new Map<string, ExpandedCache>()

function getExpandedCache(cwd: string): ExpandedCache {
  let cache = expandedCacheMap.get(cwd)
  if (!cache) {
    cache = { staged: new Set(), unstaged: new Set(), untracked: new Set() }
    expandedCacheMap.set(cwd, cache)
  }
  return cache
}

// Short clock label (HH:MM) for the "Updated …" hint in the paused banner.
function formatUpdatedAt(ts: number): string {
  return new Date(ts).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  })
}

// ---------------------------------------------------------------------------
// RangeSection — the aggregate file list of a sync range (PRDCT-1539/1679):
// incoming = what a pull will bring, outgoing = what a push will send.
// Rendered like the other sections (same indentation, list|tree toggle),
// read-only rows, ⚠ on files that also have local changes.
// ---------------------------------------------------------------------------

// Range diffs report letter statuses; the row components speak the word union.
const RANGE_STATUS_WORD: Record<string, GitFileStatus['status']> = {
  A: 'staged',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  T: 'modified',
  C: 'staged'
}

/** The section's header: the two remote ranges by name, the two worktree ranges by their base. */
function rangeLabel(direction: GitRangeDirection, baseLabel: string): string {
  switch (direction) {
    case 'incoming':
      return 'Incoming'
    case 'outgoing':
      return 'Outgoing'
    case 'worktree':
      return `Since ${baseLabel}`
    case 'base':
      return `Behind ${baseLabel}`
  }
}

function RangeSection({
  cwd,
  direction,
  baseLabel = '',
  sectionIndentPx,
  fileIndentPx,
  treeBaseIndentPx,
  localPaths,
  refreshTick,
  hasUpstream,
  onSync,
  operating
}: {
  cwd: string
  direction: GitRangeDirection
  /** The base branch as the badge shows it — names the two worktree sections (PRDCT-2356). */
  baseLabel?: string
  sectionIndentPx: number
  fileIndentPx: number
  treeBaseIndentPx: number
  /** Paths with local changes — flagged on overlapping range rows. */
  localPaths: Set<string>
  /** Bump to refetch — tied to ahead/behind so the list follows the fetch cycle. */
  refreshTick: number
  /** Names the honest empty state: no upstream means nothing to compare against. */
  hasUpstream: boolean
  /** Runs the sync this section previews — pull for incoming, push for outgoing.
   *  The worktree ranges have no one-click action and pass none. */
  onSync?: () => void
  operating: boolean
}): React.JSX.Element | null {
  const gitViewMode = useSessionStore((s) => s.gitViewMode)
  const setDiffPreview = useSessionStore((s) => s.setDiffPreview)
  const diffPreview = useSessionStore((s) => s.diffPreview)
  const [files, setFiles] = useState<GitFileStatus[] | null>(null)
  const [treeExpanded, setTreeExpanded] = useState<Set<string>>(new Set())

  useEffect(() => {
    let cancelled = false
    window.electronAPI.gitRangeFiles(cwd, direction).then((raw) => {
      if (cancelled) return
      const mapped: GitFileStatus[] = raw.map((f) => ({
        path: f.path,
        status: RANGE_STATUS_WORD[f.status] ?? 'modified',
        staged: false
      }))
      setFiles(mapped)
      setTreeExpanded(collectAllDirPaths(compactTree(buildGitTree(mapped))))
    })
    return () => {
      cancelled = true
    }
  }, [cwd, direction, refreshTick])

  const openRangeDiff = useCallback(
    (file: GitFileStatus, clickY?: number) => {
      setDiffPreview({
        file: file.path,
        cwd,
        type: direction,
        staged: false,
        fileStatus: file.status,
        hash: null,
        siblings: (files ?? []).map((f) => ({ file: f.path, staged: false, fileStatus: f.status })),
        clickY
      })
    },
    [setDiffPreview, cwd, direction, files]
  )

  const toggleTreeDir = useCallback((path: string) => {
    setTreeExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  // Still loading — the header lands on the next tick.
  if (!files) return null

  const activeDiffFile =
    diffPreview && diffPreview.cwd === cwd && diffPreview.type === direction
      ? diffPreview.file
      : null

  // The rows themselves stay view-only — clicking a file opens its net diff and
  // never syncs. The one thing that does sync is the header's spelled-out
  // Pull / Push button, on the two remote ranges only: the worktree ranges
  // (PRDCT-2356) show what a rebase would bring or what the worktree added,
  // and neither is a click away by design. An empty result explains itself
  // instead of going silent.
  const remoteTone = direction === 'incoming' || direction === 'outgoing' ? direction : null
  return (
    <>
      <SectionHeader
        label={rangeLabel(direction, baseLabel)}
        indentPx={sectionIndentPx}
        count={files.length}
        disabled={operating}
        trailing={
          files.length > 0 && remoteTone && onSync ? (
            <GitSyncActionButton
              tone={remoteTone}
              label={remoteTone === 'incoming' ? 'Pull (rebase)' : 'Push'}
              title={
                remoteTone === 'incoming'
                  ? `Pull ${files.length} incoming file${files.length === 1 ? '' : 's'} — fast-forward if possible, otherwise rebase (autostash)`
                  : `Push ${files.length} outgoing file${files.length === 1 ? '' : 's'} to the remote`
              }
              disabled={operating}
              onClick={onSync}
            />
          ) : undefined
        }
      />
      {files.length === 0 ? (
        <div className="flex items-center h-[var(--panel-row-h)] pr-3 text-[11px] text-text-tertiary" style={{ paddingLeft: fileIndentPx }}>
          {direction === 'worktree'
            ? 'No commits of its own since the cut.'
            : direction === 'base'
              ? `Nothing gained on ${baseLabel} since the cut.`
              : hasUpstream
                ? direction === 'incoming'
                  ? 'Nothing incoming — up to date with the remote.'
                  : 'Nothing to push.'
                : 'This branch has no published counterpart to compare against yet.'}
        </div>
      ) : gitViewMode === 'tree' ? (
        <GitTreeSection
          baseIndentPx={treeBaseIndentPx}
          files={files}
          cwd={cwd}
          selectedPaths={EMPTY_PATH_SET}
          expandedPaths={treeExpanded}
          activeDiffFile={activeDiffFile}
          onToggleExpanded={toggleTreeDir}
          onClickFile={openRangeDiff}
          onSelect={() => {}}
          onStageToggle={() => {}}
          onDiscard={() => {}}
          disabled={operating}
          readOnly
          overlapPaths={localPaths}
        />
      ) : (
        files.map((f, i) => (
          <FileRow
            key={`${direction}-${f.path}`}
            rule={i > 0}
            indentPx={fileIndentPx}
            file={f}
            cwd={cwd}
            isActiveDiff={activeDiffFile === f.path}
            onClickName={(clickY) => openRangeDiff(f, clickY)}
            disabled={operating}
            readOnly
            overlap={localPaths.has(f.path)}
          />
        ))
      )}
    </>
  )
}

const EMPTY_PATH_SET = new Set<string>()

// Breathing room under the last row of a scrolling git list: the content can
// be scrolled a little past its end instead of ending flush on the panel edge.
const SCROLL_GUTTER_PX = 48

function ScrollGutter(): React.JSX.Element {
  return <div className="flex-shrink-0" style={{ height: SCROLL_GUTTER_PX }} aria-hidden />
}

// ---------------------------------------------------------------------------
// EmptyStateBox — the contained field a repo shows in place of a file list
// when there is nothing to list. Indented to the section depth so it lines up
// with the rows it stands in for, and filling the panel when it is the only
// thing in it.
// ---------------------------------------------------------------------------

function EmptyStateBox({
  label,
  indentPx,
  fill
}: {
  label: string
  indentPx: number
  /** Single-repo panel: grow into the height the file list would have had. */
  fill: boolean
}): React.JSX.Element {
  return (
    <div
      className={`git-empty-box ${fill ? 'flex-1 min-h-[72px]' : ''} my-2 py-6`}
      style={{ marginLeft: indentPx, marginRight: 12 }}
    >
      <span className="text-xs text-text-tertiary text-center px-3">{label}</span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// RepoSection — reusable file list + commit bar + diff view for a single repo
// ---------------------------------------------------------------------------

function RepoSection({
  cwd,
  status,
  filterPrefix,
  refresh,
  fillHeight = true,
  depth = 0,
  showIncoming = false,
  showOutgoing = false,
  showWorktree = false,
  showBase = false,
  showChanges = true
}: {
  cwd: string
  status: GitStatusResult
  filterPrefix?: string | null
  refresh: () => void
  fillHeight?: boolean
  /** Tree level of the section headers — files sit one level deeper, so the
   *  repo's content continues the spatial tree's indentation. */
  depth?: number
  /** Unfold the aggregate pull preview (opened by the ↓ badge-button). */
  showIncoming?: boolean
  /** Unfold the aggregate push preview (opened by the ↑ badge-button). */
  showOutgoing?: boolean
  /** Unfold what the worktree added since its base (opened by the purple + badge, PRDCT-2356). */
  showWorktree?: boolean
  /** Unfold what the base gained since the cut (opened by the base badge's drift). */
  showBase?: boolean
  /** Show the local work — staged, modified, untracked. On by default; the
   *  + badge-button folds it away so only the sync ranges remain. */
  showChanges?: boolean
}) {
  const sectionIndentPx = 12 + depth * TREE_INDENT_PX
  const fileIndentPx = sectionIndentPx + TREE_INDENT_PX
  const treeBaseIndentPx = (depth + 1) * TREE_INDENT_PX
  const gitViewMode = useSessionStore((s) => s.gitViewMode)
  const gitShowCommitBar = useSessionStore((s) => s.gitShowCommitBar)
  const setDiffPreview = useSessionStore((s) => s.setDiffPreview)
  const diffPreview = useSessionStore((s) => s.diffPreview)
  const addFileTab = useSessionStore((s) => s.addFileTab)
  const collapseAllTrigger = useSessionStore((s) => s.collapseAllTrigger)
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [operating, setOperating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    file: GitFileStatus
    x: number
    y: number
  } | null>(null)

  // Restore expanded state from per-cwd cache
  const cache = getExpandedCache(cwd)
  const [stagedExpanded, _setStagedExpanded] = useState<Set<string>>(() => cache.staged)
  const [unstagedExpanded, _setUnstagedExpanded] = useState<Set<string>>(() => cache.unstaged)
  const [untrackedExpanded, _setUntrackedExpanded] = useState<Set<string>>(() => cache.untracked)

  // Wrap setters to also persist to cache
  const setStagedExpanded: typeof _setStagedExpanded = useCallback((action) => {
    _setStagedExpanded((prev) => {
      const next = typeof action === 'function' ? action(prev) : action
      getExpandedCache(cwd).staged = next
      return next
    })
  }, [cwd])

  const setUnstagedExpanded: typeof _setUnstagedExpanded = useCallback((action) => {
    _setUnstagedExpanded((prev) => {
      const next = typeof action === 'function' ? action(prev) : action
      getExpandedCache(cwd).unstaged = next
      return next
    })
  }, [cwd])

  const setUntrackedExpanded: typeof _setUntrackedExpanded = useCallback((action) => {
    _setUntrackedExpanded((prev) => {
      const next = typeof action === 'function' ? action(prev) : action
      getExpandedCache(cwd).untracked = next
      return next
    })
  }, [cwd])

  const [confirmDiscard, setConfirmDiscard] = useState<{
    files: Array<{ path: string; status: string; staged: boolean }>
    label: string
  } | null>(null)
  const prevViewMode = useRef(gitViewMode)
  const prevCwdRef = useRef(cwd)

  // Sync expanded state from cache when cwd changes while mounted
  useEffect(() => {
    if (prevCwdRef.current !== cwd) {
      prevCwdRef.current = cwd
      const c = getExpandedCache(cwd)
      _setStagedExpanded(c.staged)
      _setUnstagedExpanded(c.unstaged)
      _setUntrackedExpanded(c.untracked)
    }
  }, [cwd])

  const openDiffPreviewRef = useRef<(file: GitFileStatus, clickY?: number) => void>(() => {})

  const openDiffPreview = useCallback(
    (file: GitFileStatus, clickY?: number) => {
      openDiffPreviewRef.current(file, clickY)
    },
    []
  )

  const handleSelect = useCallback(
    (path: string, metaKey: boolean) => {
      if (metaKey) {
        setSelectedPaths((prev) => {
          const next = new Set(prev)
          if (next.has(path)) next.delete(path)
          else next.add(path)
          return next
        })
      } else {
        setSelectedPaths(new Set())
      }
    },
    []
  )

  const repoRoot = status?.repoRoot ?? cwd

  // Collapse all when trigger fires
  useEffect(() => {
    if (collapseAllTrigger > 0) {
      setStagedExpanded(new Set())
      setUnstagedExpanded(new Set())
      setUntrackedExpanded(new Set())
    }
  }, [collapseAllTrigger])

  // Auto-expand all dirs when switching to tree mode
  useEffect(() => {
    if (gitViewMode === 'tree' && prevViewMode.current === 'list' && status?.files) {
      const allFiles = status.files
      const tree = compactTree(buildGitTree(allFiles))
      const allPaths = collectAllDirPaths(tree)
      setStagedExpanded(allPaths)
      setUnstagedExpanded(allPaths)
      setUntrackedExpanded(allPaths)
    }
    prevViewMode.current = gitViewMode
  }, [gitViewMode, status?.files])

  const makeToggle = useCallback(
    (setter: React.Dispatch<React.SetStateAction<Set<string>>>) => (path: string) => {
      setter((prev) => {
        const next = new Set(prev)
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
        }
        return next
      })
    },
    []
  )

  const toggleStagedExpanded = useCallback(makeToggle(setStagedExpanded), [makeToggle])
  const toggleUnstagedExpanded = useCallback(makeToggle(setUnstagedExpanded), [makeToggle])
  const toggleUntrackedExpanded = useCallback(makeToggle(setUntrackedExpanded), [makeToggle])

  // Compute relative filter prefix from the repo root
  const relativeFilterPrefix = useMemo(() => {
    if (!filterPrefix || !status?.repoRoot) return null
    const repoRoot = status.repoRoot
    if (!filterPrefix.startsWith(repoRoot + '/')) return null
    return filterPrefix.slice(repoRoot.length + 1) + '/'
  }, [filterPrefix, status?.repoRoot])

  const { staged, unstaged, untracked } = useMemo(() => {
    if (!status?.files) return { staged: [], unstaged: [], untracked: [] }
    const staged: GitFileStatus[] = []
    const unstaged: GitFileStatus[] = []
    const untracked: GitFileStatus[] = []
    for (const f of status.files) {
      if (relativeFilterPrefix && !f.path.startsWith(relativeFilterPrefix)) continue
      if (f.status === 'untracked') {
        untracked.push(f)
      } else if (f.staged) {
        staged.push(f)
      } else {
        unstaged.push(f)
      }
    }
    return { staged, unstaged, untracked }
  }, [status?.files, relativeFilterPrefix])

  // Derive active diff file for highlighting
  const activeDiffFile = diffPreview?.type === 'working' && diffPreview.cwd === cwd ? diffPreview.file : null

  // Update ref so openDiffPreview can access latest file lists
  openDiffPreviewRef.current = (file: GitFileStatus, clickY?: number) => {
    const allFiles = [...staged, ...unstaged, ...untracked]
    setDiffPreview({
      file: file.path,
      cwd,
      type: 'working',
      staged: file.staged,
      fileStatus: file.status,
      hash: null,
      siblings: allFiles.map((f) => ({ file: f.path, staged: f.staged, fileStatus: f.status })),
      clickY
    })
  }

  const runOperation = useCallback(
    async (fn: () => Promise<void>) => {
      setError(null)
      setOperating(true)
      try {
        await fn()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setOperating(false)
        refresh()
      }
    },
    [refresh]
  )

  const stageFile = useCallback(
    (path: string) => {
      runOperation(() => window.electronAPI.gitStage(cwd, [path]))
    },
    [cwd, runOperation]
  )

  const unstageFile = useCallback(
    (path: string) => {
      runOperation(() => window.electronAPI.gitUnstage(cwd, [path]))
    },
    [cwd, runOperation]
  )

  const stageAll = useCallback(
    (files: GitFileStatus[]) => {
      runOperation(() =>
        window.electronAPI.gitStage(
          cwd,
          files.map((f) => f.path)
        )
      )
    },
    [cwd, runOperation]
  )

  const unstageAll = useCallback(() => {
    runOperation(() =>
      window.electronAPI.gitUnstage(
        cwd,
        staged.map((f) => f.path)
      )
    )
  }, [cwd, staged, runOperation])

  const promptDiscardFile = useCallback((file: GitFileStatus) => {
    const name = file.path.includes('/') ? file.path.split('/').pop()! : file.path
    setConfirmDiscard({
      files: [{ path: file.path, status: file.status, staged: file.staged }],
      label: `Discard changes to ${name}? This cannot be undone.`
    })
  }, [])

  const promptDiscardAll = useCallback((files: GitFileStatus[]) => {
    setConfirmDiscard({
      files: files.map((f) => ({ path: f.path, status: f.status, staged: f.staged })),
      label: `Discard all changes in ${files.length} file${files.length === 1 ? '' : 's'}? This cannot be undone.`
    })
  }, [])

  const executeDiscard = useCallback(() => {
    if (!confirmDiscard) return
    const filesToDiscard = confirmDiscard.files
    setConfirmDiscard(null)
    runOperation(() => window.electronAPI.gitDiscard(cwd, filesToDiscard))
  }, [cwd, confirmDiscard, runOperation])

  const openAsTab = useCallback(
    (file: GitFileStatus) => {
      const filename = file.path.includes('/') ? file.path.split('/').pop()! : file.path
      addFileTab({
        id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        filePath: `${repoRoot}/${file.path}`,
        name: filename,
        kind: 'diff',
        diff: {
          type: 'working',
          cwd,
          file: file.path,
          staged: file.staged,
          fileStatus: file.status,
          hash: null
        }
      })
    },
    [addFileTab, cwd, repoRoot]
  )

  const handleRowContextMenu = useCallback(
    (file: GitFileStatus, clientX: number, clientY: number) => {
      setContextMenu({ file, x: clientX, y: clientY })
    },
    []
  )

  const contextMenuItems = useMemo(() => {
    if (!contextMenu) return []
    const file = contextMenu.file
    const items: Array<{
      label: string
      onClick: () => void
      icon?: React.ReactNode
      danger?: boolean
    }> = [
      {
        label: 'Open as tab',
        icon: <ArrowTopRightOnSquareIcon className="w-3.5 h-3.5" />,
        onClick: () => openAsTab(file)
      },
      {
        label: file.staged ? 'Unstage' : 'Stage',
        icon: file.staged
          ? <MinusIcon className="w-3.5 h-3.5" />
          : <PlusIcon className="w-3.5 h-3.5" />,
        onClick: () => (file.staged ? unstageFile(file.path) : stageFile(file.path))
      },
      {
        label: 'Discard changes',
        icon: <ArrowUturnLeftIcon className="w-3.5 h-3.5" />,
        danger: true,
        onClick: () => promptDiscardFile(file)
      }
    ]
    return items
  }, [contextMenu, openAsTab, stageFile, unstageFile, promptDiscardFile])

  const totalFiltered = staged.length + unstaged.length + untracked.length

  const localPaths = useMemo(() => new Set(status.files.map((f) => f.path)), [status.files])

  // The sync-range sections (aggregate pull/push previews), opened by the
  // ↓/↑ badge-buttons; rendered in both the clean and the dirty layout.
  const incomingOpen = showIncoming && status.behind > 0
  const outgoingOpen = showOutgoing && status.ahead > 0
  // The two worktree ranges (PRDCT-2356), against the branch the worktree was
  // cut from; only a worktree with a nameable base has them.
  const wt = status.worktree
  const baseOpen = showBase && !!wt?.base && wt.behind > 0
  const worktreeOpen = showWorktree && !!wt?.base && wt.ahead > 0
  const anyRangeOpen = incomingOpen || outgoingOpen || baseOpen || worktreeOpen
  const rangeSections = (
    <>
      {baseOpen && wt && (
        <RangeSection
          cwd={repoRoot}
          direction="base"
          baseLabel={wt.baseLabel}
          sectionIndentPx={sectionIndentPx}
          fileIndentPx={fileIndentPx}
          treeBaseIndentPx={treeBaseIndentPx}
          localPaths={localPaths}
          refreshTick={wt.behind}
          hasUpstream={status.hasUpstream}
          operating={operating}
        />
      )}
      {worktreeOpen && wt && (
        <RangeSection
          cwd={repoRoot}
          direction="worktree"
          baseLabel={wt.baseLabel}
          sectionIndentPx={sectionIndentPx}
          fileIndentPx={fileIndentPx}
          treeBaseIndentPx={treeBaseIndentPx}
          localPaths={localPaths}
          refreshTick={wt.ahead}
          hasUpstream={status.hasUpstream}
          operating={operating}
        />
      )}
      {incomingOpen && (
        <RangeSection
          cwd={repoRoot}
          direction="incoming"
          sectionIndentPx={sectionIndentPx}
          fileIndentPx={fileIndentPx}
          treeBaseIndentPx={treeBaseIndentPx}
          localPaths={localPaths}
          refreshTick={status.behind}
          hasUpstream={status.hasUpstream}
          onSync={() => runOperation(() => window.electronAPI.gitPull(repoRoot, 'auto'))}
          operating={operating}
        />
      )}
      {outgoingOpen && (
        <RangeSection
          cwd={repoRoot}
          direction="outgoing"
          sectionIndentPx={sectionIndentPx}
          fileIndentPx={fileIndentPx}
          treeBaseIndentPx={treeBaseIndentPx}
          localPaths={localPaths}
          refreshTick={status.ahead}
          hasUpstream={status.hasUpstream}
          onSync={() => runOperation(() => window.electronAPI.gitPush(repoRoot))}
          operating={operating}
        />
      )}
    </>
  )

  // Nothing to list: either the repo really is clean, or the + badge folded the
  // local work away. Both render the same contained field — the label is what
  // tells them apart, so a folded list never reads as a clean tree.
  const isClean = status.files.length === 0 || (!!relativeFilterPrefix && totalFiltered === 0)
  const changesHidden = !isClean && !showChanges

  if (isClean || changesHidden) {
    return (
      <>
        {error && <ErrorBanner message={error} />}
        {/* Scroll container — a long range list must scroll here exactly as
            it does in the dirty layout (verifier round 4, finding 1). */}
        <div className={`${fillHeight ? 'flex-1 overflow-y-auto' : ''} flex flex-col`}>
          <EmptyStateBox
            label={
              changesHidden
                ? `${totalFiltered} local change${totalFiltered === 1 ? '' : 's'} hidden`
                : relativeFilterPrefix
                  ? 'No changes in this folder'
                  : 'Working tree clean'
            }
            indentPx={sectionIndentPx}
            fill={fillHeight}
          />
          {rangeSections}
          {/* Only when something below the box can actually scroll — an
              unconditional gutter would just push the filling box up. */}
          {anyRangeOpen && <ScrollGutter />}
        </div>
        {gitShowCommitBar &&
          (changesHidden ||
            status.ahead > 0 ||
            status.behind > 0 ||
            (!status.hasUpstream && !!status.branch)) && (
            <CommitBar
              cwd={cwd}
              stagedCount={staged.length}
              totalFileCount={totalFiltered}
              unstagedFilePaths={[...unstaged, ...untracked].map((f) => f.path)}
              ahead={status.ahead}
              behind={status.behind}
              hasUpstream={status.hasUpstream}
              operating={operating}
              onOperation={runOperation}
            />
          )}
      </>
    )
  }

  // File list + commit bar
  return (
    <>
      {error && <ErrorBanner message={error} />}
      {relativeFilterPrefix && (
        <div className="px-3 py-1 text-[10px] text-text-tertiary border-b border-border-subtle flex-shrink-0">
          Filtered to: {relativeFilterPrefix}
        </div>
      )}
      <div className={`${fillHeight ? 'flex-1 overflow-y-auto' : ''}`}>
        {staged.length > 0 && (
          <>
            <SectionHeader
              label="Staged"
              indentPx={sectionIndentPx}
              count={staged.length}
              action="Unstage All"
              onAction={unstageAll}
              discardAction="Discard All"
              onDiscardAction={() => promptDiscardAll(staged)}
              disabled={operating}
            />
            {gitViewMode === 'tree' ? (
              <GitTreeSection
                baseIndentPx={treeBaseIndentPx}
                files={staged}
                cwd={repoRoot}
                selectedPaths={selectedPaths}
                expandedPaths={stagedExpanded}
                activeDiffFile={activeDiffFile}
                onToggleExpanded={toggleStagedExpanded}
                onClickFile={openDiffPreview}
                onSelect={handleSelect}
                onStageToggle={(f) => unstageFile(f.path)}
                onDiscard={promptDiscardFile}
                onContextMenu={handleRowContextMenu}
                disabled={operating}
              />
            ) : (
              staged.map((f, i) => (
                <FileRow
                  key={`s-${f.path}`}
                  rule={i > 0}
                  indentPx={fileIndentPx}
                  file={f}
                  cwd={repoRoot}
                  isSelected={selectedPaths.has(f.path)}
                  isActiveDiff={activeDiffFile === f.path}
                  onClickName={(clickY) => openDiffPreview(f, clickY)}
                  onSelect={handleSelect}
                  onStageToggle={() => unstageFile(f.path)}
                  onDiscard={() => promptDiscardFile(f)}
                  onContextMenu={handleRowContextMenu}
                  disabled={operating}
                  selectedPaths={selectedPaths}
                />
              ))
            )}
          </>
        )}
        {unstaged.length > 0 && (
          <>
            <SectionHeader
              label="Modified"
              indentPx={sectionIndentPx}
              count={unstaged.length}
              action="Stage All"
              onAction={() => stageAll(unstaged)}
              discardAction="Discard All"
              onDiscardAction={() => promptDiscardAll(unstaged)}
              disabled={operating}
            />
            {gitViewMode === 'tree' ? (
              <GitTreeSection
                baseIndentPx={treeBaseIndentPx}
                files={unstaged}
                cwd={repoRoot}
                selectedPaths={selectedPaths}
                expandedPaths={unstagedExpanded}
                activeDiffFile={activeDiffFile}
                onToggleExpanded={toggleUnstagedExpanded}
                onClickFile={openDiffPreview}
                onSelect={handleSelect}
                onStageToggle={(f) => stageFile(f.path)}
                onDiscard={promptDiscardFile}
                onContextMenu={handleRowContextMenu}
                disabled={operating}
              />
            ) : (
              unstaged.map((f, i) => (
                <FileRow
                  key={`u-${f.path}`}
                  rule={i > 0}
                  indentPx={fileIndentPx}
                  file={f}
                  cwd={repoRoot}
                  isSelected={selectedPaths.has(f.path)}
                  isActiveDiff={activeDiffFile === f.path}
                  onClickName={(clickY) => openDiffPreview(f, clickY)}
                  onSelect={handleSelect}
                  onStageToggle={() => stageFile(f.path)}
                  onDiscard={() => promptDiscardFile(f)}
                  onContextMenu={handleRowContextMenu}
                  disabled={operating}
                  selectedPaths={selectedPaths}
                />
              ))
            )}
          </>
        )}
        {untracked.length > 0 && (
          <>
            <SectionHeader
              label="Untracked"
              indentPx={sectionIndentPx}
              count={untracked.length}
              action="Stage All"
              onAction={() => stageAll(untracked)}
              discardAction="Discard All"
              onDiscardAction={() => promptDiscardAll(untracked)}
              disabled={operating}
            />
            {gitViewMode === 'tree' ? (
              <GitTreeSection
                baseIndentPx={treeBaseIndentPx}
                files={untracked}
                cwd={repoRoot}
                selectedPaths={selectedPaths}
                expandedPaths={untrackedExpanded}
                activeDiffFile={activeDiffFile}
                onToggleExpanded={toggleUntrackedExpanded}
                onClickFile={openDiffPreview}
                onSelect={handleSelect}
                onStageToggle={(f) => stageFile(f.path)}
                onDiscard={promptDiscardFile}
                onContextMenu={handleRowContextMenu}
                disabled={operating}
              />
            ) : (
              untracked.map((f, i) => (
                <FileRow
                  key={`t-${f.path}`}
                  rule={i > 0}
                  indentPx={fileIndentPx}
                  file={f}
                  cwd={repoRoot}
                  isSelected={selectedPaths.has(f.path)}
                  isActiveDiff={activeDiffFile === f.path}
                  onClickName={(clickY) => openDiffPreview(f, clickY)}
                  onSelect={handleSelect}
                  onStageToggle={() => stageFile(f.path)}
                  onDiscard={() => promptDiscardFile(f)}
                  onContextMenu={handleRowContextMenu}
                  disabled={operating}
                  selectedPaths={selectedPaths}
                />
              ))
            )}
          </>
        )}
        {rangeSections}
        {fillHeight && <ScrollGutter />}
      </div>
      {gitShowCommitBar && (
        <CommitBar
          cwd={cwd}
          stagedCount={staged.length}
          totalFileCount={staged.length + unstaged.length + untracked.length}
          unstagedFilePaths={[...unstaged, ...untracked].map((f) => f.path)}
          ahead={status.ahead}
          behind={status.behind}
          hasUpstream={status.hasUpstream}
          operating={operating}
          onOperation={runOperation}
        />
      )}
      <ConfirmDialog
        isOpen={confirmDiscard !== null}
        title="Discard changes"
        message={confirmDiscard?.label ?? ''}
        onConfirm={executeDiscard}
        onCancel={() => setConfirmDiscard(null)}
      />
      {contextMenu && (
        <ContextMenu
          items={contextMenuItems}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        />
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// GitStatusPanel — single-repo view (existing behavior)
// ---------------------------------------------------------------------------

export function GitStatusPanel({
  cwd,
  isActive,
  filterPrefix,
  externalStatus,
  externalRefresh,
  showIncoming = false,
  showOutgoing = false,
  showChanges = true
}: {
  cwd: string | null
  isActive: boolean
  filterPrefix?: string | null
  externalStatus?: GitStatusResult | null
  externalRefresh?: () => void
  /** Single-repo mode: the toolbar's ↓/↑/+ badge-buttons drive these. */
  showIncoming?: boolean
  showOutgoing?: boolean
  showChanges?: boolean
}) {
  const focusedSessionId = useSessionStore((s) => s.focusedSessionId)
  const gitPanelMode = useSessionStore((s) => s.gitPanelMode)
  const internal = useGitStatus(externalStatus !== undefined ? null : cwd, isActive)
  const status = externalStatus !== undefined ? externalStatus : internal.status
  const loading = externalStatus !== undefined ? false : internal.loading
  const refresh = externalRefresh ?? internal.refresh

  if (!focusedSessionId || !cwd) {
    return (
      <div className="flex-1 flex items-center justify-center px-3">
        <span className="text-xs text-text-tertiary text-center">
          Focus a session to view git status
        </span>
      </div>
    )
  }

  if (loading && !status) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-xs text-text-tertiary">Loading...</span>
      </div>
    )
  }

  if (status && !status.isRepo) {
    return (
      <div className="flex-1 flex items-center justify-center px-3">
        <span className="text-xs text-text-tertiary text-center">Not a git repository</span>
      </div>
    )
  }

  if (!status) return null

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {gitPanelMode === 'log' ? (
        <GitLogView
          cwd={cwd}
          branch={status.branch}
          ahead={status.ahead}
          behind={status.behind}
        />
      ) : (
        <RepoSection
          cwd={cwd}
          status={status}
          filterPrefix={filterPrefix}
          refresh={refresh}
          fillHeight
          showIncoming={showIncoming}
          showOutgoing={showOutgoing}
          showChanges={showChanges}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// MultiRepoGitPanel — multi-repo collapsible view with minimize/dock
// ---------------------------------------------------------------------------

// Indent per tree level — header rows only; expanded repo content stays
// full-width so file rows keep their room in the narrow panel.
const TREE_INDENT_PX = 12

/**
 * The repo row's leading mark. A cube rather than a folder — the row is not a
 * folder, and the tree already has folder rows beside it — and rather than the
 * branch glyph, which is the Git TAB's mark: a repo is not a branch, and the
 * two would read as the same object at two sizes. Heroicons has no git icon;
 * of what it does have, the cube is the one that carries the folder outline's
 * weight, so the icon column lines up instead of skipping a beat at every repo.
 */
function RepoGlyph(): React.JSX.Element {
  return <CubeIcon className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
}

/** Chevron (10) + gap (6) + half the glyph (7): the column the stem and the guides share. */
const TREE_GLYPH_CENTER_PX = 23

/**
 * The worktree row's leading mark (PRDCT-2356): a guide spanning the repo
 * row's chevron-and-glyph columns, the line continuing from the source repo
 * above on the glyph's centre and a dot at this row, with the row's own
 * chevron after it. The line IS the icon: it says "of the repo above" the way
 * a folder's indentation says "inside", without the row being a folder. The
 * last worktree ends the line at its dot.
 */
function WorktreeGuide({
  merged,
  card
}: {
  merged: boolean
  /** The dot's popover: the worktree's minimal metadata (PRDCT-2360). */
  card: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <span
          // The last worktree's line ending is the line element's business
          // (.git-worktree-line--last); the guide carries the dot alone.
          className={`git-worktree-guide ${merged ? 'git-worktree-guide--merged' : ''}`}
          data-git-worktree-merged={merged ? 'true' : undefined}
        />
      </TooltipTrigger>
      {/* The popover's own material, as the toolbar's workspace popover: the
          menu surface, a label, item-shaped rows. */}
      <TooltipContent side="bottom" align="start" className="menu-surface git-worktree-card !p-1">
        {card}
      </TooltipContent>
    </Tooltip>
  )
}

/** `16 Sep, 12:02` in the reader's locale; the year only when it is not this one. */
function formatMoment(ms: number): string {
  const d = new Date(ms)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit'
  }).format(d)
}

/**
 * What the dot says on hover, in the shape of the toolbar's workspace
 * popover: a label, then two rows of a primary line over a tertiary one.
 * The branch with where it was cut from and both counts; when it was
 * created, with whether it is merged. Minimal by Romain's ask; no action.
 */
function WorktreeCard({
  branch,
  wt
}: {
  branch: string
  wt: NonNullable<GitStatusResult['worktree']>
}): React.JSX.Element {
  const baseLine = wt.base
    ? [
        `cut from ${wt.baseLabel}`,
        ...(wt.behind > 0 ? [`${wt.behind} behind`] : []),
        `${wt.ahead} ahead`
      ].join(' · ')
    : 'cut from no branch'
  return (
    <>
      <div className="menu-label">Worktree</div>
      <div className="git-worktree-card-row">
        <span className="git-worktree-card-primary">{branch === 'HEAD' ? 'detached' : branch}</span>
        <span className="git-worktree-card-secondary">{baseLine}</span>
      </div>
      {wt.createdAt && (
        <div className="git-worktree-card-row">
          <span className="git-worktree-card-primary">Created {formatMoment(wt.createdAt)}</span>
          <span className="git-worktree-card-secondary">
            {wt.merged ? `merged into ${wt.baseLabel}` : wt.base ? 'not merged yet' : ''}
          </span>
        </div>
      )}
    </>
  )
}

/** The sections a repo row's badges toggle open. */
type RowSection = 'incoming' | 'outgoing' | 'changes' | 'worktree' | 'base'

/**
 * The hairline between two rows of the repo tree.
 *
 * Drawn at the depth of the row BELOW it rather than the one above, which is
 * the fix for what the old foot-drawn rule got wrong: only a repo drew one, so
 * a tree of repos and the plain folders holding them came out ruled under every
 * repo and under nothing else — a line above the first folder, a line below the
 * last repo inside it, and nothing between the folders themselves. A row knows
 * its own depth; the row that happens to precede it does not.
 *
 * Every row takes one but the first, a folder's first child included. That
 * pairing used to be exempt on the theory that a line there cuts a folder off
 * from its own contents; in the panel it read as the one place the ruling gave
 * out, so the exemption is gone — here and in the Files tab, which rules by the
 * same sentence.
 *
 * `data-tree-rule` carries that depth for the E2E spec, which asserts on the
 * boundaries rather than on pixels.
 */
function TreeRule({ depth, insetPx = 0 }: { depth: number; insetPx?: number }): React.JSX.Element {
  return (
    <div
      className="tree-rule"
      data-tree-rule={depth}
      // `insetPx` moves the rule's start past a column it must not cross:
      // a worktree row's rule begins after its guide, so the vertical line
      // there runs through unbroken.
      style={{ marginLeft: 12 + depth * TREE_INDENT_PX + insetPx, marginRight: 12 }}
    />
  )
}

/** Where a worktree row's own chevron starts: past the guide (30px) and a gap. */
const WORKTREE_RULE_INSET_PX = 36

function MultiRepoSection({
  name,
  repoPath,
  status,
  refresh,
  isSelected,
  onSelect,
  selectedRepoPaths,
  depth = 0,
  rule = false,
  worktree,
  hasWorktrees = false
}: {
  name: string
  repoPath: string
  status: GitStatusResult
  refresh: () => void
  isSelected?: boolean
  onSelect?: (path: string, metaKey: boolean) => void
  selectedRepoPaths?: Set<string>
  depth?: number
  /** Close the block above this one with a rule at this row's own depth. */
  rule?: boolean
  /** This row is a worktree hanging under its source repo (PRDCT-2356); `last` ends the guide here. */
  worktree?: { last: boolean }
  /** Worktree rows follow this repo — draw the stem their guides continue. */
  hasWorktrees?: boolean
}) {
  const gitPanelMode = useSessionStore((s) => s.gitPanelMode)
  const openJourneyPanel = useSessionStore((s) => s.openJourneyPanel)
  const collapseAllTrigger = useSessionStore((s) => s.collapseAllTrigger)
  const changeCount = status.files.length
  const wt = status.worktree
  // The opened folder isn't itself a repo root — git resolved it to a parent
  // repository, so the changes shown actually belong to that parent.
  const isParentRepo = !!status.repoRoot && status.repoRoot !== repoPath
  const parentRepoName = isParentRepo ? status.repoRoot.split(/[\\/]/).pop() || status.repoRoot : ''

  // A repo row starts CLOSED, whatever it is carrying.
  //
  // It used to open itself whenever it had changes or was behind its remote,
  // which in a workspace of ninety repositories meant the git tab opened onto
  // a wall of unrolled file lists and Collapse All was the first click of
  // every visit. The counts are on the row itself — the ↓ ↑ + badges say what
  // is inside without unfolding it, and each badge opens its own section — so
  // nothing is hidden by starting shut, it is summarised.
  //
  // This also closes PRDCT-1672. That bug was a stale `collapseAllTrigger`
  // press folding rows on mount, because the effect guarded only on `> 0` and
  // the counter never resets; the row now mounts folded regardless, so there
  // is no default left for a stale press to override, and the trigger is not
  // read here at all.
  const [expanded, setExpanded] = useState(false)
  const [showIncoming, setShowIncoming] = useState(false)
  const [showOutgoing, setShowOutgoing] = useState(false)
  // A worktree row's two purple sections (PRDCT-2356): what its base gained
  // since the cut, and what the worktree added.
  const [showBase, setShowBase] = useState(false)
  const [showWorktree, setShowWorktree] = useState(false)
  // The local work is what the panel is for, so this one starts on — it is
  // what the row unfolds INTO once you open it, not whether it is open.
  const [showChanges, setShowChanges] = useState(true)

  // The badges are buttons: each unfolds its own section inside the repo's
  // content (and opens the repo if it was folded).
  const toggleSection = useCallback(
    (e: React.MouseEvent, section: RowSection) => {
      e.stopPropagation()
      const sections: Record<RowSection, [boolean, (open: boolean) => void]> = {
        incoming: [showIncoming, setShowIncoming],
        outgoing: [showOutgoing, setShowOutgoing],
        changes: [showChanges, setShowChanges],
        worktree: [showWorktree, setShowWorktree],
        base: [showBase, setShowBase]
      }
      const [isOpen, setter] = sections[section]
      if (!isOpen) {
        setter(true)
        setExpanded(true)
      } else if (!expanded) {
        // Section already on but the repo is folded: reveal, don't toggle off.
        setExpanded(true)
      } else {
        setter(false)
      }
    },
    [showIncoming, showOutgoing, showChanges, showWorktree, showBase, expanded]
  )

  // Collapse all when trigger fires. Still honoured — a press must shut a row
  // the user opened — and now safe on mount too, since a row that mounts
  // folded cannot be wrongly folded by a stale press (PRDCT-1672).
  useEffect(() => {
    if (collapseAllTrigger > 0) {
      setExpanded(false)
    }
  }, [collapseAllTrigger])

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      if (selectedRepoPaths && selectedRepoPaths.size > 1 && selectedRepoPaths.has(repoPath)) {
        const paths = Array.from(selectedRepoPaths).join('\n')
        e.dataTransfer.setData('text/plain', paths)
      } else {
        e.dataTransfer.setData('text/plain', repoPath)
      }
      e.dataTransfer.effectAllowed = 'copy'
    },
    [repoPath, selectedRepoPaths]
  )

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.metaKey && onSelect) {
        e.preventDefault()
        onSelect(repoPath, true)
        return
      }
      onSelect?.(repoPath, false)
      setExpanded((v) => !v)
    },
    [repoPath, onSelect]
  )

  return (
    <div className={worktree ? 'relative' : undefined}>
      {rule && <TreeRule depth={depth} insetPx={worktree ? WORKTREE_RULE_INSET_PX : 0} />}
      {/* The guide line of a worktree block, row AND unfolded content: the
          content sits far enough in to leave the line clear (see the depth
          it takes below). The last worktree's line stops at its dot, which
          sits one hairline lower when a rule opens the block. */}
      {worktree && (
        <span
          className={`git-worktree-line ${worktree.last ? 'git-worktree-line--last' : ''}`}
          style={{
            left: 12 + depth * TREE_INDENT_PX + TREE_GLYPH_CENTER_PX,
            ...(worktree.last
              ? { height: `calc(var(--git-tree-row-h) / 2 + ${rule ? 1 : 0}px)` }
              : {})
          }}
          aria-hidden
        />
      )}
      {/* Collapsible header */}
      <button
        data-tree-row={depth}
        data-tree-kind={worktree ? 'worktree' : 'repo'}
        data-tree-name={name}
        data-tree-worktree-of={wt?.of}
        data-tree-worktree-last={worktree?.last ? 'true' : undefined}
        data-tree-has-worktrees={hasWorktrees ? 'true' : undefined}
        // Same marker the directory rows carry. A repo row said nothing about
        // whether it was open, so a spec could only infer it from what was
        // rendered below — which reads as "shut" just as well when the folder
        // ABOVE it is closed and the row is not on screen at all.
        data-tree-collapsed={expanded ? undefined : 'true'}
        className={`git-tree-row w-full flex items-center gap-1.5 pr-3 text-xs transition-colors ${
          isSelected ? 'bg-surface-200' : 'hover:bg-surface-100'
        }`}
        style={{ paddingLeft: 12 + depth * TREE_INDENT_PX }}
        onClick={handleClick}
        onDoubleClick={(e) => {
          e.stopPropagation()
          openJourneyPanel(repoPath, name)
        }}
        draggable
        onDragStart={handleDragStart}
      >
        {/* The stem the worktree guides below continue — folded rows only:
            unfolded, the repo's own lists sit between and the line would cut
            through their labels. */}
        {hasWorktrees && !expanded && (
          <span
            className="git-worktree-stem"
            style={{ left: 12 + depth * TREE_INDENT_PX + TREE_GLYPH_CENTER_PX }}
            aria-hidden
          />
        )}
        {/* A worktree row leads with its guide and folds AFTER it: the dot is
            the row's place under its repo, the chevron its own fold, so the
            name lands one step deeper than the repo's and reads as nested. */}
        {worktree && wt && (
          <WorktreeGuide
            merged={wt.merged}
            card={<WorktreeCard branch={status.branch} wt={wt} />}
          />
        )}

        {/* Chevron */}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          className={`text-text-tertiary flex-shrink-0 transition-transform duration-150 ${
            expanded ? 'rotate-90' : ''
          }`}
        >
          <path d="M3 1.5l4 3.5-4 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>

        {!worktree && <RepoGlyph />}

        {/* Repo name. No tooltip on it: the path popover it used to carry on
            a long hover was noise (Romain, on the app); a worktree's path and
            base live in the popover on its dot. */}
        <span
          className={`git-tree-row-name font-medium truncate ${
            wt?.merged ? 'git-tree-row-name--merged' : 'text-text-primary'
          }`}
          // The floor is five characters. A shorter name keeps exactly its
          // own width instead: the floor would give it a wider box than
          // its text, and a button centres its text, so the slack showed
          // as a gap before the name (Romain, on the app).
          style={name.length <= 5 ? { minWidth: 'max-content' } : undefined}
        >
          {name}
        </span>

        {/* Branch badge. It gives way before the name does: in a narrow panel a
            worktree row carries up to four badges, and a name cut to one letter
            says less than a branch cut short. */}
        <span className="git-tree-row-branch text-text-tertiary truncate [flex-shrink:4]">
          {status.branch}
        </span>

        {/* The base badge (PRDCT-2356): the branch this worktree was cut from
            and how far it has moved since — its own toggle when it has. */}
        {wt?.base && (
          <GitBaseBadge
            label={wt.baseLabel}
            behind={wt.behind}
            active={showBase}
            // Merged, the drift is what the base gained since a landed
            // squash, still true and no longer news, like the count.
            muted={wt.merged}
            onToggle={(e) => toggleSection(e, 'base')}
            title={
              wt.behind > 0
                ? `Cut from ${wt.base}, which has ${wt.behind} commit${wt.behind === 1 ? '' : 's'} this worktree lacks — show what they change`
                : `Cut from ${wt.base}, which has not moved since`
            }
          />
        )}

        {/* The worktree's own commits since the cut, beside the base badge:
            the two purple numbers are one comparison, against the base; the
            right-hand group is against the remote and the working tree. */}
        {wt?.base && wt.ahead > 0 && (
          <GitSyncBadge
            tone="worktree"
            count={wt.ahead}
            active={showWorktree}
            onToggle={(e) => toggleSection(e, 'worktree')}
            // Merged, the commits are still not IN the base as commits (a
            // squash lands one), so the count stays and reads muted.
            muted={wt.merged}
            title={
              wt.merged
                ? `${wt.ahead} commit${wt.ahead === 1 ? '' : 's'} since ${wt.baseLabel}, already merged into it — show what they changed`
                : `Show what this worktree changed since ${wt.baseLabel}`
            }
          />
        )}

        {/* Badges (right-aligned) — one toggle per section of the repo's content */}
        <span className="ml-auto flex-shrink-0 flex items-center gap-1.5">
          {status.behind > 0 && (
            <GitSyncBadge
              tone="incoming"
              count={status.behind}
              active={showIncoming}
              onToggle={(e) => toggleSection(e, 'incoming')}
              title="Show what a pull will bring"
            />
          )}
          {status.ahead > 0 && (
            <GitSyncBadge
              tone="outgoing"
              count={status.ahead}
              active={showOutgoing}
              onToggle={(e) => toggleSection(e, 'outgoing')}
              title="Show what a push will send"
            />
          )}
          {changeCount > 0 && (
            <GitSyncBadge
              tone="changes"
              count={changeCount}
              active={showChanges}
              onToggle={(e) => toggleSection(e, 'changes')}
              title={showChanges ? 'Hide local changes' : 'Show local changes'}
            />
          )}
        </span>
      </button>

      {/* Parent-repo notice — the opened folder isn't a repo; changes come from above */}
      {isParentRepo && (
        <div
          className="flex items-center gap-1 pr-3 pb-1.5 text-[10px] text-text-tertiary"
          style={{ paddingLeft: 12 + depth * TREE_INDENT_PX }}
        >
          <InformationCircleIcon className="w-3 h-3 flex-shrink-0" />
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <span className="truncate cursor-default">Part of {parentRepoName}</span>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="font-mono max-w-[300px]">
              This folder isn’t a git repository. The changes shown belong to the parent repository {shortenPath(status.repoRoot)}, which contains it.
            </TooltipContent>
          </Tooltip>
        </div>
      )}

      {/* Expanded content */}
      {expanded && (
        <div className="flex flex-col">
          {gitPanelMode === 'log' ? (
            <GitLogView
              cwd={repoPath}
              branch={status.branch}
              ahead={status.ahead}
              behind={status.behind}
            />
          ) : (
            <RepoSection
              cwd={repoPath}
              status={status}
              refresh={refresh}
              fillHeight={false}
              // A worktree's content sits two indents deeper than its repo's
              // would: past the guide line, which runs on beside it.
              depth={depth + (worktree ? 3 : 1)}
              showIncoming={showIncoming}
              showOutgoing={showOutgoing}
              showWorktree={showWorktree}
              showBase={showBase}
              showChanges={showChanges}
            />
          )}
        </div>
      )}

    </div>
  )
}

// ---------------------------------------------------------------------------
// Spatial repo tree (PRDCT-1235 / PRDCT-1455) — repos render at their real
// place on disk instead of one alphabetical list. Directory rows collapse;
// a collapsed folder rolls its subtree's counts up so nothing hides.
// ---------------------------------------------------------------------------

// The folded state of these directory rows is NOT held here. It is derived
// from the side panel's one shared expanded set (session-store's
// `panelExpandedDirs`, mapped by panel-expansion.ts), which is what lets the
// Files tab and this one agree on which folders are open — and what makes a
// fresh folder start collapsed rather than fully unrolled.

function RepoDirRow({
  node,
  depth,
  collapsed,
  onToggle,
  statusByPath,
  rule = false
}: {
  node: RepoTreeDir
  depth: number
  collapsed: boolean
  onToggle: () => void
  statusByPath: Map<string, GitStatusResult>
  /** Close the block above this one with a rule at this row's own depth. */
  rule?: boolean
}): React.JSX.Element {
  // Subtree roll-up — shown only while folded; expanded children carry their own.
  const rollup = useMemo(() => {
    let changes = 0
    let ahead = 0
    let behind = 0
    for (const p of node.repoPaths) {
      const s = statusByPath.get(p)
      if (!s) continue
      changes += s.files.length
      ahead += s.ahead
      behind += s.behind
    }
    return { changes, ahead, behind }
  }, [node, statusByPath])

  return (
    <div>
      {rule && <TreeRule depth={depth} />}
      <button
      data-tree-row={depth}
      data-tree-kind="dir"
      data-tree-name={node.name}
      data-tree-collapsed={collapsed ? 'true' : undefined}
      className="git-tree-row w-full flex items-center gap-1.5 pr-3 text-xs hover:bg-surface-100 transition-colors"
      style={{ paddingLeft: 12 + depth * TREE_INDENT_PX }}
      // A double-click is one gesture, not two toggles. Every click used to
      // toggle, so a double-click on an open folder folded it and reopened it
      // in the same breath — and, while a fold still cleared the subtree from
      // the shared set, reopened it with everything beneath folded flat, which
      // read as Collapse All. `detail` is the browser's own click count, so the
      // second click of a double-click acts on nothing and the row lands where
      // the first click put it, the same as the Files tab's rows.
      onClick={(e) => {
        if (e.detail > 1) return
        onToggle()
      }}
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="none"
        className={`text-text-tertiary flex-shrink-0 transition-transform duration-150 ${
          collapsed ? '' : 'rotate-90'
        }`}
      >
        <path d="M3 1.5l4 3.5-4 3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <FolderIcon className="w-3.5 h-3.5 text-text-tertiary flex-shrink-0" />
      <span className="text-text-secondary font-medium truncate">{node.name}</span>
      {collapsed && (
        <span className="ml-auto flex-shrink-0 flex items-center gap-1.5">
          {rollup.behind > 0 && (
            <span className="text-[10px] font-medium text-git-incoming">
              {'↓'}{rollup.behind}
            </span>
          )}
          {rollup.ahead > 0 && (
            <span className="text-[10px] font-medium text-green-400">
              {'↑'}{rollup.ahead}
            </span>
          )}
          {rollup.changes > 0 && (
            <span className="badge bg-surface-200 text-text-secondary min-w-[18px] text-center">
              {rollup.changes}
            </span>
          )}
        </span>
      )}
      </button>
    </div>
  )
}

/**
 * Why this folder is not auto-refreshing, and what to do about it.
 *
 * Two different facts share it. Live updates PAUSE above a settable number of
 * repositories (polling a hundred of them every five seconds is real work), and
 * that one is the user's to change — so the note names the current limit and
 * opens the setting. Discovery TRUNCATES at a fixed 300, which nobody can
 * raise, so that half only explains itself.
 *
 * Folded by default: the collapsed line is the whole news, and a reader who
 * wants the reason opens it.
 */
function GitPanelFootnote({
  repoCount,
  truncated,
  refreshing,
  lastUpdated,
  refresh
}: {
  repoCount: number
  truncated: boolean
  refreshing: boolean
  lastUpdated: number | null
  refresh: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const pollLimit = useSessionStore((s) => s.gitLivePollLimit)
  const setActiveView = useSessionStore((s) => s.setActiveView)

  return (
    <div className="git-footnote" data-git-footnote data-open={open ? 'true' : undefined}>
      <div className="git-footnote-line">
        <button
          className="git-footnote-summary"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          data-git-footnote-toggle
        >
          <InformationCircleIcon className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">
            {truncated ? `First ${repoCount} repos` : 'Live updates paused'}
            {lastUpdated !== null && (
              <span className="opacity-70"> · {formatUpdatedAt(lastUpdated)}</span>
            )}
          </span>
          <ChevronUpIcon
            className={`w-3 h-3 flex-shrink-0 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          />
        </button>
        <button
          className="git-footnote-action"
          onClick={refresh}
          disabled={refreshing}
          aria-label="Refresh"
        >
          <ArrowPathIcon className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>
      {open && (
        <div className="git-footnote-body" data-git-footnote-body>
          <p>
            {truncated
              ? `This folder holds more repositories than the panel indexes at once, so it lists the first ${repoCount}. Open a folder further in to see the rest.`
              : `Auto-refresh stops above ${pollLimit} repositories and this folder has ${repoCount}. It still refreshes when you ask, when an agent finishes, and when the window comes back to the front.`}
          </p>
          {!truncated && (
            <div className="git-footnote-buttons">
              {/* One button, and it goes to the number rather than changing it.
                  A "keep watching all 85" that silently raised the limit and
                  then retired the note left no way back to the setting it had
                  just moved — the only affordance for a thing you might want to
                  undo has to be the place you can undo it. */}
              <button
                className="btn-compact btn-secondary"
                onClick={() => setActiveView('settings')}
                data-git-footnote-settings
              >
                Change limit
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function MultiRepoGitPanel({
  repos,
  rootPath,
  basePath,
  refresh,
  truncated = false,
  live = true,
  refreshing = false,
  lastUpdated = null
}: {
  repos: Array<{ name: string; path: string; status: GitStatusResult }>
  rootPath?: string | null
  /** The panel's folder — the tree's root. Falls back to a flat list when null. */
  basePath?: string | null
  refresh: () => void
  truncated?: boolean
  live?: boolean
  refreshing?: boolean
  lastUpdated?: number | null
}) {
  const [nestedDocked, setNestedDocked] = useState(false)
  const [selectedRepoPaths, setSelectedRepoPaths] = useState<Set<string>>(new Set())

  const handleRepoSelect = useCallback(
    (path: string, metaKey: boolean) => {
      if (metaKey) {
        setSelectedRepoPaths((prev) => {
          const next = new Set(prev)
          if (next.has(path)) next.delete(path)
          else next.add(path)
          return next
        })
      } else {
        setSelectedRepoPaths(new Set())
      }
    },
    []
  )

  const rootRepo = rootPath ? repos.find((r) => r.path === rootPath) ?? null : null
  const nestedRepos = useMemo(
    () => (rootPath ? repos.filter((r) => r.path !== rootPath) : repos),
    [repos, rootPath]
  )
  const hasRoot = rootRepo !== null

  const nestedChangeCount = useMemo(
    () => nestedRepos.reduce((sum, r) => sum + r.status.files.length, 0),
    [nestedRepos]
  )

  const statusByPath = useMemo(
    () => new Map(repos.map((r) => [r.path, r.status])),
    [repos]
  )

  // Each worktree's source, as discovery spells the source's path (PRDCT-2356):
  // git names it resolved, the list may hold it through a symlink.
  const roots = useMemo(
    () => repos.map((r) => ({ path: r.path, repoRoot: r.status.repoRoot })),
    [repos]
  )
  const withSources = useMemo(
    () =>
      nestedRepos.map((r) => ({
        ...r,
        worktreeOf: worktreeSourcePath(r.status.worktree?.of, roots),
        createdAt: r.status.worktree?.createdAt ?? null
      })),
    [nestedRepos, roots]
  )

  // The spatial tree of the (nested) repos, rooted at the panel's folder.
  const repoTree = useMemo(
    () =>
      basePath
        ? buildRepoTree(
            basePath,
            withSources.map((r) => ({
              name: r.name,
              path: r.path,
              worktreeOf: r.worktreeOf,
              createdAt: r.createdAt
            }))
          )
        : null,
    [basePath, withSources]
  )

  // The flat fallback's order, with each repo's worktrees under it (PRDCT-2356).
  const flatRows = useMemo(() => orderWithWorktrees(withSources), [withSources])

  // Folded directories, DERIVED from the panel's shared expanded set rather
  // than held here (see panel-expansion.ts). Two things follow from that, and
  // both are the point:
  //
  //  - A folder opened in the Files tab is open here too, and the other way
  //    round. The two tabs used to keep separate caches, so a path walked in
  //    one had to be walked again in the other.
  //  - The default is COLLAPSED. This tree used to start with every folder
  //    open — the set was of folded folders, and a fresh one is empty — so the
  //    git tab greeted you with the whole tree unrolled and Collapse All was
  //    the first click of every visit.
  //
  // The collapse-all trigger is not read here any more: it empties the shared
  // set at the store, and this derivation follows. A guarded adjust against a
  // monotonic counter is what PRDCT-1672 is about, and there is now no local
  // state for a stale press to clobber.
  // `basePath` is optional AND nullable at the prop boundary; the mapping
  // helpers take one absent form, not two.
  const base = basePath ?? null
  const cacheKey = base ?? ''
  const expandedDirs = useSessionStore((s) => s.panelExpandedDirs[cacheKey])
  const setPanelDirExpanded = useSessionStore((s) => s.setPanelDirExpanded)

  const collapsedDirs = useMemo(
    () =>
      repoTree
        ? collapsedFromExpanded(
            base,
            collectRepoTreeDirPaths(repoTree),
            expandedDirs ?? EMPTY_PATH_SET
          )
        : EMPTY_PATH_SET,
    [repoTree, base, expandedDirs]
  )

  // `segments` is what the row stands for. This tree compacts single-child
  // chains into one row whose label carries every folder it swallowed
  // ("deep/one/two") while its path is only the deepest, so folding it must
  // clear all three — those ancestors are pass-through folders no row here
  // will ever name again. A row that compacted nothing counts 1 and clears
  // only itself, which is also what the Files tab does with its own rows.
  const toggleDir = useCallback(
    (dirPath: string, label: string) => {
      const rel = toRelative(base, dirPath)
      if (rel === null || rel === '') return
      const segments = label.split('/').filter(Boolean).length || 1
      setPanelDirExpanded(cacheKey, rel, collapsedDirs.has(dirPath), segments)
    },
    [base, cacheKey, collapsedDirs, setPanelDirExpanded]
  )

  const treeRows = useMemo(
    () => (repoTree ? flattenRepoTree(repoTree, collapsedDirs) : null),
    [repoTree, collapsedDirs]
  )

  /**
   * Where a rule goes: above every row but the first, at that row's own depth —
   * a folder and its first repo included. The first row closes nothing, and the
   * root repo above the tree is closed by the dock separator instead.
   */
  const renderTreeRow = (row: FlatRepoRow, index: number): React.JSX.Element | null => {
    const rule = index > 0
    if (row.node.type === 'dir') {
      return (
        <RepoDirRow
          key={`dir:${row.node.path}`}
          node={row.node}
          depth={row.depth}
          collapsed={row.collapsed}
          onToggle={() => toggleDir(row.node.path, row.node.name)}
          statusByPath={statusByPath}
          rule={rule}
        />
      )
    }
    const status = statusByPath.get(row.node.path)
    if (!status) return null
    const isWorktree = row.node.type === 'worktree'
    return (
      <MultiRepoSection
        key={row.node.path}
        name={row.node.name}
        repoPath={row.node.path}
        status={status}
        refresh={refresh}
        isSelected={selectedRepoPaths.has(row.node.path)}
        onSelect={handleRepoSelect}
        selectedRepoPaths={selectedRepoPaths}
        depth={row.depth}
        rule={rule}
        worktree={isWorktree ? { last: row.last ?? true } : undefined}
        hasWorktrees={row.node.type === 'repo' && row.node.worktrees.length > 0}
      />
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* The list is the container the narrow-row rules read: see .git-repo-list. */}
      <div className="git-repo-list flex-1 overflow-y-auto">
        {/* Root repo */}
        {rootRepo && (
          <MultiRepoSection
            name={rootRepo.name}
            repoPath={rootRepo.path}
            status={rootRepo.status}
            refresh={refresh}
            isSelected={selectedRepoPaths.has(rootRepo.path)}
            onSelect={handleRepoSelect}
            selectedRepoPaths={selectedRepoPaths}
          />
        )}

        {/* Separator with dock arrow — only when root + nested coexist and nested are visible */}
        {hasRoot && nestedRepos.length > 0 && !nestedDocked && (
          <div className="group/sep flex items-center gap-0 px-3 py-1">
            <div className="flex-1 h-px bg-border" />
            <button
              className="btn-icon btn-icon-xs opacity-0 group-hover/sep:opacity-100 transition-opacity flex-shrink-0 mx-1"
              onClick={() => setNestedDocked(true)}
              title="Dock nested repos"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                <path d="M2.5 4L5 7l2.5-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <div className="flex-1 h-px bg-border" />
          </div>
        )}

        {/* Nested repos as the spatial tree (flat fallback without a basePath) —
            hidden when docked */}
        {!(hasRoot && nestedDocked) &&
          (treeRows
            ? treeRows.map((row, i) => renderTreeRow(row, i))
            : flatRows.map(({ repo, worktree, last }, i) => (
                <MultiRepoSection
                  key={repo.path}
                  name={repo.name}
                  repoPath={repo.path}
                  status={repo.status}
                  refresh={refresh}
                  isSelected={selectedRepoPaths.has(repo.path)}
                  onSelect={handleRepoSelect}
                  selectedRepoPaths={selectedRepoPaths}
                  rule={i > 0}
                  worktree={worktree ? { last } : undefined}
                  hasWorktrees={!worktree && flatRows[i + 1]?.worktree === true}
                />
              )))}
        <ScrollGutter />
      </div>

      {/* The state of the panel's own refreshing, at the foot of it. It used to
          be a strip across the TOP of the list: a standing warning over the
          thing you came to read, in a folder where nothing is wrong — a big
          tree is a fact about the folder, not a problem. Down here it is a
          footnote, folded, and it carries the way out rather than only the
          news. */}
      {(truncated || !live) && (
        <GitPanelFootnote
          repoCount={repos.length}
          truncated={truncated}
          refreshing={refreshing}
          lastUpdated={lastUpdated}
          refresh={refresh}
        />
      )}

      {/* Bottom dock tab for nested repos */}
      {nestedDocked && nestedRepos.length > 0 && (
        <div className="flex-shrink-0 border-t border-border px-2 py-1.5 bg-surface-100/50">
          <button
            className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-medium rounded bg-surface-100 hover:bg-surface-200 text-text-secondary hover:text-text-primary transition-colors w-full"
            onClick={() => setNestedDocked(false)}
            title="Restore nested repos"
          >
            <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className="flex-shrink-0">
              <path d="M2 5.5L4 3l2 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>{nestedRepos.length} nested repo{nestedRepos.length !== 1 ? 's' : ''}</span>
            {nestedChangeCount > 0 && (
              <span className="badge bg-surface-200 text-text-tertiary min-w-[16px] text-center">
                {nestedChangeCount}
              </span>
            )}
          </button>
        </div>
      )}
    </div>
  )
}
