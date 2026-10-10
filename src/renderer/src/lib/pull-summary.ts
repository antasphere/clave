/**
 * What Pull all says when it is over (PRDCT-3372).
 *
 * The count alone ("2 failed") is what made the old failures invisible: the
 * user saw the arrows stay and had no way to learn which repo, or why. So a
 * failed repo is named in the line itself, and its reason travels with it for
 * the tooltip; the bar keeps the line until it is dismissed (see
 * `GitBatchProvider`).
 */

export interface PullOutcome {
  repoPath: string
  pulled: boolean
  error: string | null
}

export interface BatchFailure {
  /** The repo's folder name, as the panel's rows show it. */
  name: string
  /** The first line of git's own message that says something. */
  reason: string
}

export interface BatchSummary {
  message: string
  failures: BatchFailure[]
}

/** How many failed repos the line names before it says "+N more". */
const NAMED_IN_LINE = 3

export function repoName(repoPath: string): string {
  return repoPath.split(/[\\/]/).filter(Boolean).pop() ?? repoPath
}

/**
 * Git's messages bury the reason: a fast-forward refusal is ten `hint:` lines
 * before its `fatal:`, and a rebase conflict opens with "Auto-merging <file>"
 * (measured on git 2.50). So the line shown is the first that says what went
 * wrong — a `CONFLICT` line, else an `error:`/`fatal:` one, level word dropped
 * — and only failing those the first line that is not a hint.
 */
export function shortReason(error: string): string {
  const lines = error
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^hint:/i.test(l))
  const pick =
    lines.find((l) => /^CONFLICT\b/.test(l)) ??
    lines.find((l) => /^(error|fatal):/i.test(l)) ??
    lines[0] ??
    error.trim()
  return pick.replace(/^(error|fatal):\s*/i, '') || 'Unknown error'
}

export function summarizePull(results: PullOutcome[]): BatchSummary {
  const pulled = results.filter((r) => r.pulled && !r.error).length
  const upToDate = results.filter((r) => !r.pulled && !r.error).length
  const failures: BatchFailure[] = results
    .filter((r): r is PullOutcome & { error: string } => !!r.error)
    .map((r) => ({ name: repoName(r.repoPath), reason: shortReason(r.error) }))

  const parts: string[] = []
  if (pulled > 0) parts.push(`${pulled} pulled`)
  if (upToDate > 0) parts.push(`${upToDate} up to date`)
  if (failures.length > 0) {
    const named = failures.slice(0, NAMED_IN_LINE).map((f) => f.name)
    const more = failures.length - named.length
    parts.push(`${failures.length} failed: ${named.join(', ')}${more > 0 ? ` +${more} more` : ''}`)
  }
  return { message: parts.join(', '), failures }
}
