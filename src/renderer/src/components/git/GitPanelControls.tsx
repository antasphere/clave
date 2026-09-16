import { useCallback } from 'react'
import { useSessionStore } from '../../store/session-store'
import {
  ListBulletIcon,
  Bars3BottomLeftIcon,
  ArrowPathIcon,
  ArrowDownIcon,
  PencilSquareIcon,
  PlusIcon,
  ChevronDoubleUpIcon,
  ClockIcon,
  QueueListIcon
} from '@heroicons/react/24/outline'
import { IconButton } from '../ui/tooltip'
import { useGitBatch } from './git-batch-context'

// ---------------------------------------------------------------------------
// Sync badges — the ↓ / ↑ / + counters that toggle a repo's sections open
// ---------------------------------------------------------------------------

export type GitSyncTone = 'incoming' | 'outgoing' | 'changes' | 'worktree'

/** One text color per tone — the badge derives its border and fill from it.
 *  A worktree's own commits take the purple of the modified tone (PRDCT-2356),
 *  the same family as a file you changed since both are your work in
 *  progress, on a token of its own restated per theme so the light grounds
 *  get a violet that still reads at 10px. */
const TONE_TEXT_CLASS: Record<GitSyncTone, string> = {
  incoming: 'text-git-incoming',
  outgoing: 'text-green-400',
  changes: 'text-text-secondary',
  worktree: 'text-git-worktree'
}

/**
 * A counter that opens and closes the matching section of a repo's content.
 * Rendered as a span with a button role because a repo row is itself a
 * <button> and buttons cannot nest.
 */
export function GitSyncBadge({
  tone,
  count,
  active,
  onToggle,
  title,
  muted = false
}: {
  tone: GitSyncTone
  count: number
  active: boolean
  onToggle: (e: React.MouseEvent) => void
  title: string
  /** Still true, no longer news: a worktree's count once its work is merged (PRDCT-2356). */
  muted?: boolean
}): React.JSX.Element {
  return (
    <span
      role="button"
      tabIndex={0}
      title={title}
      aria-pressed={active}
      onClick={onToggle}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onToggle(e as unknown as React.MouseEvent)
        }
      }}
      className={`git-sync-badge ${TONE_TEXT_CLASS[tone]} ${active ? 'git-sync-badge-on' : ''} ${
        muted ? 'git-sync-badge-muted' : ''
      }`}
      data-git-sync-tone={tone}
      data-git-sync-muted={muted ? 'true' : undefined}
    >
      {tone === 'changes' || tone === 'worktree' ? (
        <PlusIcon className="w-2.5 h-2.5" strokeWidth={2.5} />
      ) : (
        <span aria-hidden>{tone === 'incoming' ? '↓' : '↑'}</span>
      )}
      {count}
    </span>
  )
}

/**
 * The base badge of a worktree row (PRDCT-2356): the branch the worktree was
 * cut from, and how far that branch has moved since as `−N`. With a drift it
 * is a toggle like the counters, opening the list of what the base gained;
 * with none it is a label, there being nothing to open.
 */
export function GitBaseBadge({
  label,
  behind,
  active,
  onToggle,
  title
}: {
  label: string
  behind: number
  active: boolean
  onToggle: (e: React.MouseEvent) => void
  title: string
}): React.JSX.Element {
  if (behind <= 0) {
    // A label, not a button: the click must not reach the row beneath, which
    // would unfold it for nothing (verifier round 1, finding 3).
    return (
      <span
        className={`git-sync-badge git-sync-badge-static ${TONE_TEXT_CLASS.worktree}`}
        title={title}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        data-git-base-badge="label"
      >
        <span className="git-base-badge-name">{label}</span>
      </span>
    )
  }
  // The base's name folds away in a narrow row (the container query in the
  // stylesheet) and the drift stays; the title and the accessible name keep
  // the base for the reader who asks.
  return (
    <span
      role="button"
      tabIndex={0}
      title={title}
      aria-label={`${label} −${behind}`}
      aria-pressed={active}
      onClick={onToggle}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onToggle(e as unknown as React.MouseEvent)
        }
      }}
      className={`git-sync-badge ${TONE_TEXT_CLASS.worktree} ${active ? 'git-sync-badge-on' : ''}`}
      data-git-base-badge="drift"
    >
      <span className="git-base-badge-name">{label}</span>
      <span aria-hidden>−{behind}</span>
    </span>
  )
}

/**
 * The Pull / Push button that sits at the right of an Incoming / Outgoing
 * header. Spelled out rather than an arrow: this one syncs, and a click that
 * syncs must say so.
 */
export function GitSyncActionButton({
  tone,
  label,
  title,
  disabled,
  onClick
}: {
  tone: 'incoming' | 'outgoing'
  label: string
  title: string
  disabled?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      className={`git-sync-action ${TONE_TEXT_CLASS[tone]}`}
      title={title}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      <span aria-hidden>{tone === 'incoming' ? '↓' : '↑'}</span>
      {label}
    </button>
  )
}

export function SectionHeader({
  label,
  count,
  action,
  onAction,
  discardAction,
  onDiscardAction,
  trailing,
  disabled,
  indentPx
}: {
  label: string
  count: number
  action?: string
  onAction?: () => void
  discardAction?: string
  onDiscardAction?: () => void
  /** Rightmost slot — the sync sections put their Pull / Push button here. */
  trailing?: React.ReactNode
  disabled?: boolean
  /** Left offset in px — lets the header sit at its tree depth (default 12 = px-3). */
  indentPx?: number
}) {
  return (
    <div className="git-section-header flex items-center pr-3" style={{ paddingLeft: indentPx ?? 12 }}>
      <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
        {label} ({count})
      </span>
      <span className="ml-auto flex items-center gap-2">
        {discardAction && onDiscardAction && (
          <button
            className="text-[10px] text-text-tertiary hover:text-red-400 transition-colors disabled:opacity-50"
            onClick={onDiscardAction}
            disabled={disabled}
          >
            {discardAction}
          </button>
        )}
        {action && onAction && (
          <button
            className="text-[10px] text-text-tertiary hover:text-text-secondary transition-colors disabled:opacity-50"
            onClick={onAction}
            disabled={disabled}
          >
            {action}
          </button>
        )}
        {trailing}
      </span>
    </div>
  )
}

/**
 * Collapse everything the side panel currently lists. It lives in the panel's
 * tab bar rather than in either tab, because `collapseAllTrigger` is a store
 * counter both trees watch — the file tree folds its directories, the git tree
 * folds its repos and their parent folders — and one button that does both is
 * the honest shape of that.
 */
export function CollapseAllButton() {
  const triggerCollapseAll = useSessionStore((s) => s.triggerCollapseAll)
  return (
    <IconButton
      onClick={triggerCollapseAll}
      className="panel-icon-btn"
      aria-label="Collapse all"
      tooltip="Collapse all"
    >
      <ChevronDoubleUpIcon className="w-3.5 h-3.5" />
    </IconButton>
  )
}

export function ViewModeToggle() {
  const gitViewMode = useSessionStore((s) => s.gitViewMode)
  const setGitViewMode = useSessionStore((s) => s.setGitViewMode)
  const isTree = gitViewMode === 'tree'
  return (
    <IconButton
      onClick={() => setGitViewMode(isTree ? 'list' : 'tree')}
      className="panel-icon-btn"
      aria-label={isTree ? 'List view' : 'Tree view'}
      tooltip={isTree ? 'List view' : 'Tree view'}
    >
      {isTree ? (
        <ListBulletIcon className="w-3.5 h-3.5" />
      ) : (
        <Bars3BottomLeftIcon className="w-3.5 h-3.5" />
      )}
    </IconButton>
  )
}

export function CommitBarToggle(): React.JSX.Element {
  const gitShowCommitBar = useSessionStore((s) => s.gitShowCommitBar)
  const setGitShowCommitBar = useSessionStore((s) => s.setGitShowCommitBar)
  return (
    <IconButton
      onClick={() => setGitShowCommitBar(!gitShowCommitBar)}
      className="panel-icon-btn"
      data-active={gitShowCommitBar ? 'true' : undefined}
      aria-label={gitShowCommitBar ? 'Hide commit bar' : 'Show commit bar'}
      tooltip={gitShowCommitBar ? 'Hide commit bar' : 'Show commit bar'}
    >
      <PencilSquareIcon className="w-3.5 h-3.5" />
    </IconButton>
  )
}

export function PanelModeToggle() {
  const gitPanelMode = useSessionStore((s) => s.gitPanelMode)
  const setGitPanelMode = useSessionStore((s) => s.setGitPanelMode)
  const isLog = gitPanelMode === 'log'
  return (
    <IconButton
      onClick={() => setGitPanelMode(isLog ? 'changes' : 'log')}
      className="panel-icon-btn"
      aria-label={isLog ? 'Changes' : 'Commit log'}
      tooltip={isLog ? 'Changes' : 'Commit log'}
    >
      {isLog ? <QueueListIcon className="w-3.5 h-3.5" /> : <ClockIcon className="w-3.5 h-3.5" />}
    </IconButton>
  )
}

/**
 * The two batch buttons. Neither owns its own progress text any more: they set
 * a batch running and the bar's progress row (`GitBatchProgressBar`) draws it,
 * because a row under the whole bar cannot be rendered from inside a button.
 * What stays on the button is the state you read at a glance — the icon moves
 * while its own op runs, and both are disabled while either one does, since the
 * two would fight over the same working copies.
 */
export function MagicSyncButton({
  repoPaths,
  onDone
}: {
  repoPaths: string[]
  onDone?: () => void
}) {
  const { state, run } = useGitBatch()
  const mine = state.running && state.op === 'sync'

  const handleSync = useCallback(() => {
    void run('sync', async () => {
      try {
        const results = await window.electronAPI.gitMagicSync(repoPaths)
        const synced = results.filter((r) => r.actions.length > 0 && !r.error)
        const errors = results.filter((r) => r.error)
        const skipped = results.filter((r) => r.actions.length === 0 && !r.error)

        const parts: string[] = []
        if (synced.length > 0) parts.push(`${synced.length} synced`)
        if (skipped.length > 0) parts.push(`${skipped.length} clean`)
        if (errors.length > 0) parts.push(`${errors.length} failed`)
        return parts.join(', ')
      } finally {
        // Refresh even when the batch threw: a partial run still moved repos.
        onDone?.()
      }
    })
  }, [run, repoPaths, onDone])

  return (
    <IconButton
      onClick={handleSync}
      disabled={state.running || repoPaths.length === 0}
      className="panel-icon-btn"
      aria-label="Magic sync"
      tooltip={mine ? 'Syncing...' : 'Magic sync'}
    >
      <ArrowPathIcon className={`w-3.5 h-3.5 ${mine ? 'animate-spin' : ''}`} />
    </IconButton>
  )
}

/**
 * Pull all: it pulls the repos the panel shows as behind, and nothing else.
 *
 * `repoPaths` is therefore the BADGED repos, not every repo in the tree. That
 * is the promise — what you can see is what it does — and it is why the button
 * disables itself when there is nothing to pull rather than going to ninety
 * remotes to find out. Going to look is the refresh's job.
 */
export function MagicPullButton({
  repoPaths,
  onDone
}: {
  repoPaths: string[]
  onDone?: () => void
}) {
  const { state, run } = useGitBatch()
  const mine = state.running && state.op === 'pull'
  const count = repoPaths.length

  const handlePull = useCallback(() => {
    void run('pull', async () => {
      try {
        const results = await window.electronAPI.gitMagicPull(repoPaths)
        const pulled = results.filter((r) => r.pulled && !r.error)
        const upToDate = results.filter((r) => !r.pulled && !r.error)
        const errors = results.filter((r) => r.error)

        const parts: string[] = []
        if (pulled.length > 0) parts.push(`${pulled.length} pulled`)
        if (upToDate.length > 0) parts.push(`${upToDate.length} up to date`)
        if (errors.length > 0) parts.push(`${errors.length} failed`)
        return parts.join(', ')
      } finally {
        // Refresh even when the batch threw: a partial run still moved repos.
        onDone?.()
      }
    })
  }, [run, repoPaths, onDone])

  return (
    <IconButton
      onClick={handlePull}
      disabled={state.running || repoPaths.length === 0}
      className="panel-icon-btn"
      aria-label="Pull all"
      tooltip={
        mine
          ? 'Pulling...'
          : count === 0
            ? 'Nothing to pull — refresh to check the remotes'
            : `Pull ${count} repo${count === 1 ? '' : 's'}`
      }
    >
      <ArrowDownIcon className={`w-3.5 h-3.5 ${mine ? 'animate-bounce' : ''}`} />
    </IconButton>
  )
}

export function JourneyButton({ cwd, repoName }: { cwd: string; repoName: string }) {
  const openJourneyPanel = useSessionStore((s) => s.openJourneyPanel)
  return (
    <IconButton
      onClick={() => openJourneyPanel(cwd, repoName)}
      className="panel-icon-btn"
      aria-label="Journey"
      tooltip="Journey"
    >
      {/* Timeline/route icon */}
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <circle cx="3" cy="2.5" r="1.3" stroke="currentColor" strokeWidth="1.1" />
        <circle cx="9" cy="6" r="1.3" stroke="currentColor" strokeWidth="1.1" />
        <circle cx="3" cy="9.5" r="1.3" stroke="currentColor" strokeWidth="1.1" />
        <path d="M3 3.8v4.4M4.3 2.8l3.4 2.5M7.7 6.7l-3.4 2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
      </svg>
    </IconButton>
  )
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="px-3 py-1.5 bg-red-500/10 text-red-400 text-xs flex-shrink-0">{message}</div>
  )
}
