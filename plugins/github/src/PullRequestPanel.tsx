import { useCallback, useEffect, useState, type FormEvent } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  ArrowsRightLeftIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  ClockIcon,
  LinkIcon,
  MinusCircleIcon,
  XCircleIcon,
  XMarkIcon
} from '@heroicons/react/24/outline'
import { ConfirmDialog } from '@clave/ui/components'
import {
  parsePullRequestUrl,
  pullRefKey,
  pullRefUrl,
  summarizeChecks,
  type CheckStatus,
  type GithubFailureKind,
  type MergeMethod,
  type PullDiffFile,
  type PullRef,
  type PullRequestView,
  type PullTimelineItem,
  type ReviewEvent
} from '../../../src/shared/github-pull'
import { MarkdownRenderer } from '../../../src/renderer/src/components/files/MarkdownRenderer'
import { DiffLinesView } from '../../../src/renderer/src/components/git/DiffLinesView'
import { parseDiffLines } from '../../../src/renderer/src/lib/diff-utils'
import { openLink } from '../../../src/renderer/src/lib/open-link'
import { useGithubPanelStore } from './store'
import { openPullRequest } from './open'
import { whenLabel } from './when'

const STATE_LABEL: Record<PullRequestView['state'], string> = {
  open: 'Open',
  draft: 'Draft',
  merged: 'Merged',
  closed: 'Closed'
}
const REVIEW_LABEL = {
  approved: 'Approved',
  changes_requested: 'Changes requested',
  review_required: 'Review required'
} as const
const REVIEW_STATE_LABEL: Record<NonNullable<PullTimelineItem['state']>, string> = {
  approved: 'approved',
  changes_requested: 'requested changes',
  commented: 'reviewed',
  dismissed: 'review dismissed',
  pending: 'review pending'
}
const MERGE_METHOD_LABEL: Record<MergeMethod, string> = {
  merge: 'Create a merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge'
}
const FAILURE_HINT: Record<GithubFailureKind, string> = {
  missing: 'Install the GitHub CLI (brew install gh), sign in with gh auth login, then refresh.',
  auth: 'Sign in with gh auth login in a terminal, then refresh.',
  failed: ''
}

function CheckIcon({ status }: { status: CheckStatus }): React.JSX.Element {
  const className = 'pr-check-icon'
  switch (status) {
    case 'success':
      return <CheckCircleIcon className={className} />
    case 'failure':
    case 'cancelled':
      return <XCircleIcon className={className} />
    case 'pending':
      return <ClockIcon className={className} />
    default:
      return <MinusCircleIcon className={className} />
  }
}

/** The panel: one pull request, or the way to one. */
export function PullRequestPanel(): React.JSX.Element {
  const current = useGithubPanelStore((s) => s.current)
  return (
    <div className="pr-panel" data-testid="pr-panel">
      {current ? (
        <PullRequestDetail key={pullRefKey(current)} pullRef={current} />
      ) : (
        <PullRequestEmpty />
      )}
    </div>
  )
}

function PullRequestEmpty(): React.JSX.Element {
  const recent = useGithubPanelStore((s) => s.recent)
  const [draft, setDraft] = useState('')
  const [refused, setRefused] = useState(false)
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const ref = parsePullRequestUrl(draft.trim())
    if (!ref) {
      setRefused(true)
      return
    }
    setRefused(false)
    setDraft('')
    openPullRequest(ref)
  }
  return (
    <div className="pr-empty" data-testid="pr-empty">
      <ArrowsRightLeftIcon className="pr-empty-glyph" />
      <p className="pr-empty-title">No pull request open</p>
      <p className="pr-empty-text">
        Click a pull request link in a chat, or paste one here. Hold ⌘ on a link to open it in the
        browser instead.
      </p>
      <form className="pr-empty-form" onSubmit={submit}>
        <input
          className="input-compact"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value)
            setRefused(false)
          }}
          placeholder="https://github.com/owner/repo/pull/123"
          aria-label="Pull request URL"
          aria-invalid={refused || undefined}
          spellCheck={false}
        />
      </form>
      {refused && (
        <p className="pr-empty-refused">That is not a link to a pull request on github.com.</p>
      )}
      {recent.length > 0 && (
        <div className="pr-recent">
          <p className="menu-label">Recent</p>
          {recent.map((entry) => (
            <button
              key={pullRefKey(entry)}
              type="button"
              className="menu-item"
              data-pr-recent={pullRefKey(entry)}
              onClick={() => openPullRequest(entry)}
            >
              <span className="pr-recent-ref">
                {entry.owner}/{entry.repo} #{entry.number}
              </span>
              {entry.title && <span className="pr-recent-title truncate">{entry.title}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface Failure {
  kind: GithubFailureKind
  message: string
}

function PullRequestDetail({ pullRef }: { pullRef: PullRef }): React.JSX.Element {
  const remember = useGithubPanelStore((s) => s.remember)
  const close = useGithubPanelStore((s) => s.close)
  const [view, setView] = useState<PullRequestView | null>(null)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [diff, setDiff] = useState<PullDiffFile[] | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffFailure, setDiffFailure] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [actionFailure, setActionFailure] = useState<string | null>(null)
  const [mergeMethod, setMergeMethod] = useState<MergeMethod | null>(null)

  /** What a read of the record does to the panel, first load and refresh alike. */
  const apply = useCallback(
    (result: Awaited<ReturnType<typeof window.electronAPI.githubPull>>): void => {
      if (result.ok) {
        setView(result.value)
        setFailure(null)
        remember(pullRef, result.value.title)
      } else setFailure({ kind: result.kind, message: result.message })
      setLoading(false)
    },
    [pullRef, remember]
  )
  useEffect(() => {
    let live = true
    void window.electronAPI.githubPull(pullRef).then((result) => {
      if (live) apply(result)
    })
    return () => {
      live = false
    }
  }, [pullRef, apply])
  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    apply(await window.electronAPI.githubPull(pullRef))
  }, [pullRef, apply])

  const loadDiff = useCallback(async (): Promise<void> => {
    if (diff || diffLoading) return
    setDiffLoading(true)
    setDiffFailure(null)
    const result = await window.electronAPI.githubPullDiff(pullRef)
    if (result.ok) setDiff(result.value)
    else setDiffFailure(result.message)
    setDiffLoading(false)
  }, [pullRef, diff, diffLoading])

  /** One writer for every action: the panel is busy while it runs, a refusal
   *  is shown under the composer, and a success reloads the record and clears
   *  the draft — GitHub's word on what happened, not the panel's guess. */
  const act = async (
    name: string,
    run: () => Promise<{ ok: true; value: void } | { ok: false; message: string }>
  ): Promise<void> => {
    setBusy(name)
    setActionFailure(null)
    const result = await run()
    if (result.ok) {
      setDraft('')
      setDiff(null)
      await load()
    } else setActionFailure(result.message)
    setBusy(null)
  }
  const body = draft.trim()
  const review = (event: ReviewEvent): Promise<void> =>
    act(event, () => window.electronAPI.githubPullReview(pullRef, event, body))
  const url = view?.url ?? pullRefUrl(pullRef)
  const canAct = view?.state === 'open' || view?.state === 'draft'
  const canMerge = view?.state === 'open' && view.mergeable !== 'conflicting'
  const checks = view ? summarizeChecks(view.checks) : null

  return (
    <>
      <div className="panel-bar panel-bar--nowrap" data-panel-bar="pull-request">
        <span className="pr-ref truncate" title={url}>
          {pullRef.owner}/{pullRef.repo}
          <span className="pr-ref-number"> #{pullRef.number}</span>
        </span>
        <span className="flex-1" />
        <button
          type="button"
          className="panel-icon-btn"
          aria-label="Refresh"
          title="Refresh"
          data-testid="pr-refresh"
          disabled={loading}
          onClick={() => void load()}
        >
          <ArrowPathIcon className={`w-4 h-4${loading ? ' animate-spin' : ''}`} />
        </button>
        <button
          type="button"
          className="panel-icon-btn"
          aria-label="Copy link"
          title="Copy link"
          onClick={() => void navigator.clipboard.writeText(url)}
        >
          <LinkIcon className="w-4 h-4" />
        </button>
        <button
          type="button"
          className="panel-icon-btn"
          aria-label="Open on GitHub"
          title="Open on GitHub"
          onClick={() => void openLink(url, { external: true })}
        >
          <ArrowTopRightOnSquareIcon className="w-4 h-4" />
        </button>
        <button
          type="button"
          className="panel-icon-btn"
          aria-label="Close pull request"
          title="Close"
          onClick={close}
        >
          <XMarkIcon className="w-4 h-4" />
        </button>
      </div>

      {failure && !view && (
        <div className="pr-failure" data-testid="pr-error" data-kind={failure.kind}>
          <p className="pr-failure-message">{failure.message}</p>
          {FAILURE_HINT[failure.kind] && (
            <p className="pr-failure-hint">{FAILURE_HINT[failure.kind]}</p>
          )}
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void openLink(url, { external: true })}
          >
            Open on GitHub
          </button>
        </div>
      )}
      {!failure && !view && loading && (
        <div className="pr-loading">
          <span className="text-xs text-text-tertiary">Loading pull request…</span>
        </div>
      )}

      {view && (
        <div className="pr-scroll">
          {failure && (
            <p className="pr-stale" data-testid="pr-error" data-kind={failure.kind}>
              Could not refresh: {failure.message}
            </p>
          )}
          <header className="pr-head">
            <h2 className="pr-title" data-testid="pr-title">
              {view.title}
            </h2>
            <div className="pr-meta">
              <span className="badge pr-state" data-state={view.state} data-testid="pr-state">
                {STATE_LABEL[view.state]}
              </span>
              <span className="pr-meta-text">
                <strong>{view.author}</strong>
                {view.authorIsBot && <span className="badge badge-muted">bot</span>}{' '}
                {view.state === 'merged' ? 'merged' : 'wants to merge'}{' '}
                <code className="pr-branch">
                  {view.headOwner ? `${view.headOwner}:` : ''}
                  {view.head}
                </code>{' '}
                into <code className="pr-branch">{view.base}</code>
                {view.createdAt && <> · {whenLabel(view.createdAt)}</>}
              </span>
            </div>
            <div className="pr-stats">
              <span className="pr-stat-add">+{view.additions}</span>
              <span className="pr-stat-del">−{view.deletions}</span>
              <span className="pr-stat">
                {view.changedFiles} {view.changedFiles === 1 ? 'file' : 'files'}
              </span>
              <span className="pr-stat">
                {view.commits} {view.commits === 1 ? 'commit' : 'commits'}
              </span>
              {view.labels.map((label) => (
                <span key={label.name} className="badge badge-muted">
                  {label.name}
                </span>
              ))}
            </div>
            <ul className="pr-signals">
              {checks && checks.verdict !== 'none' && (
                <li className="pr-signal" data-tone={checks.verdict}>
                  <CheckIcon
                    status={
                      checks.verdict === 'success'
                        ? 'success'
                        : checks.verdict === 'failure'
                          ? 'failure'
                          : 'pending'
                    }
                  />
                  {checks.verdict === 'success'
                    ? `All ${checks.total} checks passed`
                    : checks.verdict === 'failure'
                      ? `${checks.failed} of ${checks.total} checks failed`
                      : `${checks.pending} of ${checks.total} checks running`}
                </li>
              )}
              {view.reviewDecision && (
                <li
                  className="pr-signal"
                  data-tone={
                    view.reviewDecision === 'approved'
                      ? 'success'
                      : view.reviewDecision === 'changes_requested'
                        ? 'failure'
                        : 'pending'
                  }
                >
                  <CheckIcon
                    status={
                      view.reviewDecision === 'approved'
                        ? 'success'
                        : view.reviewDecision === 'changes_requested'
                          ? 'failure'
                          : 'pending'
                    }
                  />
                  {REVIEW_LABEL[view.reviewDecision]}
                  {view.reviewers.length > 0 && ` · awaiting ${view.reviewers.join(', ')}`}
                </li>
              )}
              {view.state === 'open' && view.mergeable !== 'unknown' && (
                <li
                  className="pr-signal"
                  data-tone={view.mergeable === 'mergeable' ? 'success' : 'failure'}
                >
                  <CheckIcon status={view.mergeable === 'mergeable' ? 'success' : 'failure'} />
                  {view.mergeable === 'mergeable'
                    ? 'No conflicts with the base branch'
                    : 'Conflicts with the base branch'}
                  {view.mergeState === 'blocked' && ' · merging is blocked'}
                  {view.mergeState === 'behind' && ' · behind the base branch'}
                </li>
              )}
            </ul>
          </header>

          <details className="pr-section" open>
            <summary className="pr-section-head">Description</summary>
            <div className="pr-section-body pr-markdown">
              {view.body.trim() ? (
                <MarkdownRenderer content={view.body} />
              ) : (
                <p className="pr-none">No description.</p>
              )}
            </div>
          </details>

          <details className="pr-section" data-testid="pr-checks">
            <summary className="pr-section-head">
              Checks <span className="pr-section-count">{view.checks.length}</span>
            </summary>
            <div className="pr-section-body">
              {view.checks.length === 0 && <p className="pr-none">No checks reported.</p>}
              {view.checks.map((check, index) => (
                <div key={`${check.name}:${index}`} className="pr-check" data-status={check.status}>
                  <CheckIcon status={check.status} />
                  <span className="pr-check-name truncate">
                    {check.name}
                    {check.workflow && (
                      <span className="pr-check-workflow"> · {check.workflow}</span>
                    )}
                  </span>
                  {check.url && (
                    <button
                      type="button"
                      className="panel-icon-btn"
                      aria-label={`Open ${check.name}`}
                      title="Open the run"
                      onClick={() => void openLink(check.url!, { external: true })}
                    >
                      <ArrowTopRightOnSquareIcon className="w-4 h-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </details>

          <details
            className="pr-section"
            data-testid="pr-files"
            onToggle={(event) => {
              if ((event.currentTarget as HTMLDetailsElement).open) void loadDiff()
            }}
          >
            <summary className="pr-section-head">
              Files <span className="pr-section-count">{view.files.length}</span>
            </summary>
            <div className="pr-section-body">
              {diffLoading && !diff && <p className="pr-none">Loading diff…</p>}
              {diffFailure && <p className="pr-failure-message">{diffFailure}</p>}
              {view.files.map((file) => {
                const patch = diff?.find((entry) => entry.path === file.path)
                return (
                  <details key={file.path} className="pr-file" data-change={file.change}>
                    <summary className="pr-file-head">
                      <span className="pr-file-path truncate" title={file.path}>
                        {file.path}
                      </span>
                      <span className="pr-file-stats">
                        <span className="pr-stat-add">+{file.additions}</span>
                        <span className="pr-stat-del">−{file.deletions}</span>
                      </span>
                    </summary>
                    {patch ? (
                      <DiffLinesView
                        lines={parseDiffLines(patch.patch)}
                        loading={false}
                        error={null}
                        className="pr-file-diff"
                      />
                    ) : (
                      <p className="pr-none">{diff ? 'No text diff for this file.' : 'Loading…'}</p>
                    )}
                  </details>
                )
              })}
            </div>
          </details>

          <details className="pr-section" data-testid="pr-conversation" open>
            <summary className="pr-section-head">
              Conversation <span className="pr-section-count">{view.timeline.length}</span>
            </summary>
            <div className="pr-section-body">
              {view.timeline.length === 0 && <p className="pr-none">No comments yet.</p>}
              {view.timeline.map((item) => (
                <article
                  key={`${item.kind}:${item.id}`}
                  className="pr-comment"
                  data-kind={item.kind}
                >
                  <header className="pr-comment-head">
                    <strong>{item.author}</strong>
                    {item.kind === 'review' && item.state && (
                      <span className="badge pr-review-state" data-state={item.state}>
                        {REVIEW_STATE_LABEL[item.state]}
                      </span>
                    )}
                    <span className="pr-comment-when">{whenLabel(item.at)}</span>
                  </header>
                  {item.body.trim() && (
                    <div className="pr-markdown">
                      <MarkdownRenderer content={item.body} />
                    </div>
                  )}
                </article>
              ))}
            </div>
          </details>
        </div>
      )}

      {view && (
        <form
          className="pr-composer"
          onSubmit={(event) => {
            event.preventDefault()
            if (body) void act('comment', () => window.electronAPI.githubPullComment(pullRef, body))
          }}
        >
          <textarea
            className="textarea-field pr-composer-input"
            data-testid="pr-composer"
            aria-label="Comment"
            placeholder={canAct ? 'Leave a comment' : 'Comment on this pull request'}
            value={draft}
            disabled={busy !== null}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                if (body)
                  void act('comment', () => window.electronAPI.githubPullComment(pullRef, body))
              }
            }}
            rows={2}
          />
          {actionFailure && (
            <p className="pr-failure-message" data-testid="pr-action-error">
              {actionFailure}
            </p>
          )}
          <div className="pr-composer-actions">
            <button
              type="submit"
              className="btn-secondary"
              data-testid="pr-action-comment"
              disabled={!body || busy !== null}
            >
              {busy === 'comment' ? 'Posting…' : 'Comment'}
            </button>
            {canAct && (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid="pr-action-request-changes"
                  disabled={!body || busy !== null}
                  onClick={() => void review('request_changes')}
                >
                  Request changes
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid="pr-action-approve"
                  disabled={busy !== null}
                  onClick={() => void review('approve')}
                >
                  {busy === 'approve' ? 'Approving…' : 'Approve'}
                </button>
              </>
            )}
            {view.state === 'open' && (
              <DropdownMenu.Root modal={false}>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    className="btn-primary"
                    data-testid="pr-merge"
                    disabled={!canMerge || busy !== null}
                    title={canMerge ? 'Merge this pull request' : 'Resolve the conflicts first'}
                  >
                    {busy === 'merge' ? 'Merging…' : 'Merge'}
                    <ChevronDownIcon className="w-3.5 h-3.5" />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    side="top"
                    align="end"
                    sideOffset={6}
                    className="menu-surface menu-pop z-50 min-w-[200px] p-1"
                    aria-label="Merge method"
                  >
                    {(Object.keys(MERGE_METHOD_LABEL) as MergeMethod[]).map((method) => (
                      <DropdownMenu.Item
                        key={method}
                        className="menu-item"
                        data-pr-merge-method={method}
                        onSelect={() => setMergeMethod(method)}
                      >
                        {MERGE_METHOD_LABEL[method]}
                      </DropdownMenu.Item>
                    ))}
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            )}
          </div>
        </form>
      )}
      <ConfirmDialog
        isOpen={mergeMethod !== null}
        title={`Merge #${pullRef.number}?`}
        message={`${MERGE_METHOD_LABEL[mergeMethod ?? 'merge']} for ${pullRef.owner}/${pullRef.repo} #${pullRef.number}${view ? ` — ${view.title}` : ''}. This cannot be undone from Clave.`}
        confirmLabel="Merge"
        onConfirm={() => {
          const method = mergeMethod
          setMergeMethod(null)
          if (method) void act('merge', () => window.electronAPI.githubPullMerge(pullRef, method))
        }}
        onCancel={() => setMergeMethod(null)}
      />
    </>
  )
}
