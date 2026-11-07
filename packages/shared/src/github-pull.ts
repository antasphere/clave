import { z } from 'zod'

/**
 * The GitHub pull request panel's contract, shared by the main process (which
 * runs `gh`), the preload boundary and the bundled `clave.github` plugin.
 *
 * Everything here is pure: URL recognition, the view model the panel draws,
 * the mapping from `gh pr view --json` output onto it, and the argument lists
 * `gh` is run with. Main owns the process; the renderer owns the pixels; this
 * file owns the meaning, so it can be unit-tested without either.
 */

/** GitHub's own rules: a login is alphanumerics and single hyphens, never
 *  leading or trailing; a repository name may also carry dots and underscores.
 *  Both are checked again in main before they reach `gh`, so a link an agent
 *  printed can name a repository but never smuggle a flag. */
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/

export const PullRefSchema = z.object({
  owner: z.string().regex(OWNER_RE),
  repo: z.string().regex(REPO_RE),
  number: z.number().int().positive().max(1_000_000_000)
})
export type PullRef = z.infer<typeof PullRefSchema>

export const pullRefKey = (ref: PullRef): string => `${ref.owner}/${ref.repo}#${ref.number}`
export const pullRefUrl = (ref: PullRef): string =>
  `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`

/** A link to a pull request on github.com, as agents print them: the canonical
 *  URL, optionally on a tab (`/files`, `/commits`, `/checks`), with a query or
 *  a fragment (`#discussion_r…`). Anything else — an issue, a repository, a
 *  GitHub Enterprise host, the API — is not a pull request and returns null. */
export function parsePullRequestUrl(href: string): PullRef | null {
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const host = url.hostname.toLowerCase()
  if (host !== 'github.com' && host !== 'www.github.com') return null
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d{1,10})(?:\/(?:files|commits|checks)?)?$/.exec(
    url.pathname
  )
  if (!match) return null
  const candidate = { owner: match[1], repo: match[2], number: Number(match[3]) }
  const parsed = PullRefSchema.safeParse(candidate)
  return parsed.success ? parsed.data : null
}

export type PullState = 'open' | 'draft' | 'merged' | 'closed'
export type ReviewDecision = 'approved' | 'changes_requested' | 'review_required' | null
export type Mergeable = 'mergeable' | 'conflicting' | 'unknown'
export type CheckStatus = 'success' | 'failure' | 'pending' | 'skipped' | 'neutral' | 'cancelled'
export type ReviewState = 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending'
export type FileChange = 'added' | 'deleted' | 'renamed' | 'modified' | 'copied' | 'changed'

export interface PullCheck {
  name: string
  workflow: string | null
  status: CheckStatus
  url: string | null
}
export interface PullFile {
  path: string
  additions: number
  deletions: number
  change: FileChange
}
export interface PullLabel {
  name: string
  color: string | null
}
/** One entry of the conversation: an issue comment or a review, in the order
 *  they were posted. A review's `state` says what it decided. */
export interface PullTimelineItem {
  kind: 'comment' | 'review'
  id: string
  author: string
  body: string
  at: string
  url: string | null
  state?: ReviewState
}

export interface PullRequestView {
  ref: PullRef
  url: string
  number: number
  title: string
  body: string
  state: PullState
  author: string
  authorIsBot: boolean
  createdAt: string
  updatedAt: string
  mergedAt: string | null
  base: string
  head: string
  /** The fork's owner when the head lives in another repository, else null. */
  headOwner: string | null
  additions: number
  deletions: number
  changedFiles: number
  commits: number
  labels: PullLabel[]
  reviewers: string[]
  reviewDecision: ReviewDecision
  mergeable: Mergeable
  /** GitHub's `mergeStateStatus`, lowercased: clean, blocked, behind, dirty, unstable… */
  mergeState: string
  checks: PullCheck[]
  files: PullFile[]
  timeline: PullTimelineItem[]
}

/** The `--json` fields `gh pr view` is asked for. One list, so the mapper
 *  below and the process in main can never disagree about what was fetched. */
export const GH_PULL_FIELDS = [
  'number',
  'title',
  'body',
  'state',
  'isDraft',
  'url',
  'author',
  'createdAt',
  'updatedAt',
  'mergedAt',
  'baseRefName',
  'headRefName',
  'headRepositoryOwner',
  'isCrossRepository',
  'additions',
  'deletions',
  'changedFiles',
  'commits',
  'labels',
  'reviewRequests',
  'reviewDecision',
  'mergeable',
  'mergeStateStatus',
  'statusCheckRollup',
  'files',
  'comments',
  'reviews'
] as const

/** What `gh pr view --json` hands back. Every field is optional on purpose: the
 *  mapper must survive an older `gh` that lacks one rather than refuse the
 *  whole pull request. */
export interface GhPullRaw {
  number?: number
  title?: string
  body?: string
  state?: string
  isDraft?: boolean
  url?: string
  author?: { login?: string; is_bot?: boolean } | null
  createdAt?: string
  updatedAt?: string
  mergedAt?: string | null
  baseRefName?: string
  headRefName?: string
  headRepositoryOwner?: { login?: string } | null
  isCrossRepository?: boolean
  additions?: number
  deletions?: number
  changedFiles?: number
  commits?: unknown[]
  labels?: { name?: string; color?: string }[]
  reviewRequests?: { login?: string; name?: string; slug?: string }[]
  reviewDecision?: string
  mergeable?: string
  mergeStateStatus?: string
  statusCheckRollup?: GhCheckRaw[]
  files?: { path?: string; additions?: number; deletions?: number; changeType?: string }[]
  comments?: GhCommentRaw[]
  reviews?: GhReviewRaw[]
}
interface GhCheckRaw {
  __typename?: string
  name?: string
  context?: string
  workflowName?: string
  status?: string
  conclusion?: string
  state?: string
  detailsUrl?: string
  targetUrl?: string
}
interface GhCommentRaw {
  id?: string
  author?: { login?: string } | null
  body?: string
  createdAt?: string
  url?: string
}
interface GhReviewRaw {
  id?: string
  author?: { login?: string } | null
  body?: string
  submittedAt?: string
  state?: string
}

function pullState(raw: GhPullRaw): PullState {
  const state = (raw.state ?? '').toUpperCase()
  if (state === 'MERGED') return 'merged'
  if (state === 'CLOSED') return 'closed'
  return raw.isDraft ? 'draft' : 'open'
}
function reviewDecision(value: string | undefined): ReviewDecision {
  switch ((value ?? '').toUpperCase()) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changes_requested'
    case 'REVIEW_REQUIRED':
      return 'review_required'
    default:
      return null
  }
}
function mergeable(value: string | undefined): Mergeable {
  switch ((value ?? '').toUpperCase()) {
    case 'MERGEABLE':
      return 'mergeable'
    case 'CONFLICTING':
      return 'conflicting'
    default:
      return 'unknown'
  }
}
/** A rollup item is a GitHub Actions check run (`status` + `conclusion`) or a
 *  commit status from another service (`state` alone); both land on one scale. */
function checkStatus(raw: GhCheckRaw): CheckStatus {
  const state = (raw.state ?? '').toUpperCase()
  if (state) {
    if (state === 'SUCCESS') return 'success'
    if (state === 'FAILURE' || state === 'ERROR') return 'failure'
    if (state === 'PENDING' || state === 'EXPECTED') return 'pending'
    return 'neutral'
  }
  if ((raw.status ?? '').toUpperCase() !== 'COMPLETED') return 'pending'
  switch ((raw.conclusion ?? '').toUpperCase()) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'TIMED_OUT':
    case 'ACTION_REQUIRED':
    case 'STARTUP_FAILURE':
      return 'failure'
    case 'SKIPPED':
      return 'skipped'
    case 'CANCELLED':
      return 'cancelled'
    default:
      return 'neutral'
  }
}
function reviewState(value: string | undefined): ReviewState {
  switch ((value ?? '').toUpperCase()) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changes_requested'
    case 'DISMISSED':
      return 'dismissed'
    case 'PENDING':
      return 'pending'
    default:
      return 'commented'
  }
}
function fileChange(value: string | undefined): FileChange {
  switch ((value ?? '').toUpperCase()) {
    case 'ADDED':
      return 'added'
    case 'DELETED':
    case 'REMOVED':
      return 'deleted'
    case 'RENAMED':
      return 'renamed'
    case 'COPIED':
      return 'copied'
    case 'CHANGED':
      return 'changed'
    default:
      return 'modified'
  }
}
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

/** `gh pr view --json` output onto the view the panel draws. `ref` is what was
 *  asked for, not what came back: the panel is keyed on the link the user
 *  clicked, and `gh` answers for exactly that pull request. */
export function pullRequestFromGh(ref: PullRef, raw: GhPullRaw): PullRequestView {
  const comments: PullTimelineItem[] = (raw.comments ?? []).map((comment, index) => ({
    kind: 'comment',
    id: comment.id ?? `comment-${index}`,
    author: comment.author?.login ?? 'ghost',
    body: comment.body ?? '',
    at: comment.createdAt ?? '',
    url: comment.url ?? null
  }))
  const reviews: PullTimelineItem[] = (raw.reviews ?? [])
    // A review with no words and no verdict is GitHub's placeholder for an
    // in-progress review; there is nothing to show for it.
    .filter(
      (review) => (review.body ?? '').trim() !== '' || reviewState(review.state) !== 'pending'
    )
    .map((review, index) => ({
      kind: 'review',
      id: review.id ?? `review-${index}`,
      author: review.author?.login ?? 'ghost',
      body: review.body ?? '',
      at: review.submittedAt ?? '',
      url: null,
      state: reviewState(review.state)
    }))
  const timeline = [...comments, ...reviews].sort((a, b) => a.at.localeCompare(b.at))
  return {
    ref,
    url: raw.url ?? pullRefUrl(ref),
    number: raw.number ?? ref.number,
    title: raw.title ?? `#${ref.number}`,
    body: raw.body ?? '',
    state: pullState(raw),
    author: raw.author?.login ?? 'ghost',
    authorIsBot: raw.author?.is_bot === true,
    createdAt: raw.createdAt ?? '',
    updatedAt: raw.updatedAt ?? '',
    mergedAt: raw.mergedAt ?? null,
    base: raw.baseRefName ?? '',
    head: raw.headRefName ?? '',
    headOwner: raw.isCrossRepository ? (raw.headRepositoryOwner?.login ?? null) : null,
    additions: count(raw.additions),
    deletions: count(raw.deletions),
    changedFiles: count(raw.changedFiles),
    commits: Array.isArray(raw.commits) ? raw.commits.length : 0,
    labels: (raw.labels ?? [])
      .filter((label) => typeof label.name === 'string' && label.name !== '')
      .map((label) => ({ name: label.name!, color: label.color ?? null })),
    reviewers: (raw.reviewRequests ?? [])
      .map((request) => request.login ?? request.slug ?? request.name ?? '')
      .filter((name) => name !== ''),
    reviewDecision: reviewDecision(raw.reviewDecision),
    mergeable: mergeable(raw.mergeable),
    mergeState: (raw.mergeStateStatus ?? '').toLowerCase(),
    checks: (raw.statusCheckRollup ?? []).map((check) => ({
      name: check.name ?? check.context ?? 'check',
      workflow: check.workflowName ?? null,
      status: checkStatus(check),
      url: check.detailsUrl ?? check.targetUrl ?? null
    })),
    files: (raw.files ?? [])
      .filter((file) => typeof file.path === 'string' && file.path !== '')
      .map((file) => ({
        path: file.path!,
        additions: count(file.additions),
        deletions: count(file.deletions),
        change: fileChange(file.changeType)
      })),
    timeline
  }
}

export interface ChecksSummary {
  total: number
  passed: number
  failed: number
  pending: number
  /** The one word for the whole set: a failure anywhere is a failure, else
   *  anything still running is pending, else success — or none when no
   *  check reported at all. */
  verdict: 'success' | 'failure' | 'pending' | 'none'
}
export function summarizeChecks(checks: PullCheck[]): ChecksSummary {
  let passed = 0
  let failed = 0
  let pending = 0
  for (const check of checks) {
    if (check.status === 'success') passed += 1
    else if (check.status === 'failure' || check.status === 'cancelled') failed += 1
    else if (check.status === 'pending') pending += 1
  }
  const verdict =
    checks.length === 0 ? 'none' : failed > 0 ? 'failure' : pending > 0 ? 'pending' : 'success'
  return { total: checks.length, passed, failed, pending, verdict }
}

export interface PullDiffFile {
  path: string
  oldPath: string | null
  change: FileChange
  /** The file's own section of the unified diff, header lines included. */
  patch: string
}

/** Split `gh pr diff` output (a unified diff across files) into one patch per
 *  file, keyed by the new path. The header pair is preferred over the
 *  `diff --git` line because a path with a space is unambiguous there. */
export function splitUnifiedDiff(raw: string): PullDiffFile[] {
  const files: PullDiffFile[] = []
  const sections = raw
    .split(/^(?=diff --git )/m)
    .filter((section) => section.startsWith('diff --git '))
  for (const section of sections) {
    const lines = section.split('\n')
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(lines[0])
    let oldPath = header?.[1] ?? null
    let path = header?.[2] ?? oldPath ?? ''
    let change: FileChange = 'modified'
    for (const line of lines.slice(1)) {
      if (line.startsWith('@@')) break
      if (line.startsWith('new file mode')) change = 'added'
      else if (line.startsWith('deleted file mode')) change = 'deleted'
      else if (line.startsWith('rename from ')) {
        change = 'renamed'
        oldPath = line.slice('rename from '.length)
      } else if (line.startsWith('rename to ')) path = line.slice('rename to '.length)
      else if (line.startsWith('copy to ')) {
        change = 'copied'
        path = line.slice('copy to '.length)
      } else if (line.startsWith('--- a/')) oldPath = line.slice('--- a/'.length)
      else if (line.startsWith('+++ b/')) path = line.slice('+++ b/'.length)
    }
    if (change === 'added') oldPath = null
    if (path === '' && oldPath) path = oldPath
    if (path === '') continue
    files.push({ path, oldPath: change === 'modified' ? null : oldPath, change, patch: section })
  }
  return files
}

export type ReviewEvent = 'approve' | 'request_changes' | 'comment'
export type MergeMethod = 'merge' | 'squash' | 'rebase'
export const ReviewEventSchema = z.enum(['approve', 'request_changes', 'comment'])
export const MergeMethodSchema = z.enum(['merge', 'squash', 'rebase'])
/** GitHub's own limit on a comment body. */
export const MAX_COMMENT_LENGTH = 65_536
export const CommentBodySchema = z.string().min(1).max(MAX_COMMENT_LENGTH)

const repoArg = (ref: PullRef): string => `${ref.owner}/${ref.repo}`

/** The argument lists `gh` runs with. The number and the repository are
 *  always positional-then-flag in this order, and a body always travels on
 *  stdin (`--body-file -`): a comment starting with a dash is then a comment,
 *  never a flag, and its length is never the command line's problem. */
export const ghArgs = {
  view: (ref: PullRef): string[] => [
    'pr',
    'view',
    String(ref.number),
    '--repo',
    repoArg(ref),
    '--json',
    GH_PULL_FIELDS.join(',')
  ],
  diff: (ref: PullRef): string[] => ['pr', 'diff', String(ref.number), '--repo', repoArg(ref)],
  comment: (ref: PullRef): string[] => [
    'pr',
    'comment',
    String(ref.number),
    '--repo',
    repoArg(ref),
    '--body-file',
    '-'
  ],
  review: (ref: PullRef, event: ReviewEvent): string[] => [
    'pr',
    'review',
    String(ref.number),
    '--repo',
    repoArg(ref),
    event === 'approve'
      ? '--approve'
      : event === 'request_changes'
        ? '--request-changes'
        : '--comment',
    '--body-file',
    '-'
  ],
  merge: (ref: PullRef, method: MergeMethod): string[] => [
    'pr',
    'merge',
    String(ref.number),
    '--repo',
    repoArg(ref),
    `--${method}`
  ]
}

/** The environment variables `gh` reads a token from, in the order it
 *  prefers them — and it prefers either over the login it stored itself. */
export const GH_TOKEN_VARIABLES = ['GH_TOKEN', 'GITHUB_TOKEN'] as const

export interface GhSpawnEnv {
  /** The environment `gh` runs in first: the login shell's, with every token
   *  variable removed, so the stored login (`gh auth login`) is the account. */
  env: Record<string, string>
  /** The login shell's environment as it came, when it carried a token: the
   *  one retry when `gh` has no stored login, for the user whose only
   *  sign-in is that variable. Absent when there was no token to fall back on. */
  withToken?: Record<string, string>
}

/** `gh` honours `GH_TOKEN` and `GITHUB_TOKEN` over the account it stored at
 *  `gh auth login`, and a login shell often exports one of them for something
 *  else — a fine-grained PAT for one repository, a CI token, a leftover — which
 *  cannot see the repositories the stored login can. The panel promised the
 *  user's own sign-in, so that is what runs: the stored login first, the
 *  environment's token only when there is no stored login to use. */
export function ghSpawnEnv(loginEnv: Record<string, string>): GhSpawnEnv {
  const env = { ...loginEnv }
  let carried = false
  for (const name of GH_TOKEN_VARIABLES) {
    if (env[name] !== undefined) {
      carried = true
      delete env[name]
    }
  }
  return carried ? { env, withToken: { ...loginEnv } } : { env }
}

/** How a `gh` run failed, for the panel to say the right thing: no `gh` on the
 *  machine, an account that is not signed in, or the command's own words. */
export type GithubFailureKind = 'missing' | 'auth' | 'failed'
export type GithubResult<T> =
  | { ok: true; value: T }
  | { ok: false; kind: GithubFailureKind; message: string }
