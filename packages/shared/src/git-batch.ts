/**
 * The progress contract for the git bar's batch operations — Pull all, Magic
 * sync, and the refresh sweep.
 *
 * It lives in `shared/` because all three processes need the same shape and
 * none of them may import another's: the main process emits it, the preload
 * types the channel with it, and the renderer draws the progress row from it.
 * A copy per process is how a field goes missing in exactly one of them, with
 * no error anywhere — the counter simply stops moving.
 */

/**
 * The batch operations the git bar runs across the repos it lists.
 *
 * `fetch` is the DISCOVERY one and the only one that talks to every remote:
 * it is what makes the panel's ↓ badges true. `pull` and `sync` act on what the
 * badges already say, which is why they are fast and why they are honest — a
 * button that promises to pull three repos pulls those three.
 */
export type GitBatchOp = 'pull' | 'sync' | 'fetch'

/** Where one repo currently is inside its batch pipeline. */
export type GitBatchPhase =
  | 'checking'
  | 'fetching'
  | 'pulling'
  | 'staging'
  | 'generating'
  | 'committing'
  | 'pushing'

/**
 * One progress event, shared by both ops — which is what lets a single progress
 * row serve Pull all AND Magic sync. `done` counts repos whose pipeline has
 * ENDED (pulled, skipped, or failed), so `done/total` is a fraction the UI can
 * draw without knowing anything about phases.
 */
export interface GitBatchProgress {
  op: GitBatchOp
  phase: GitBatchPhase
  repoPath: string
  repoName: string
  done: number
  total: number
}

export type GitBatchProgressFn = (progress: GitBatchProgress) => void

/** What each phase is called in the UI. One table, so the two ops cannot drift
 *  into describing the same step with two different words. */
export const GIT_BATCH_PHASE_LABELS: Record<GitBatchPhase, string> = {
  checking: 'Checking',
  fetching: 'Fetching',
  pulling: 'Pulling',
  staging: 'Staging',
  generating: 'Writing message',
  committing: 'Committing',
  pushing: 'Pushing'
}
