/**
 * The batch-op context: state shape, the context object, and the hook that
 * reads it. Split from `GitBatchProgress.tsx` because a module that exports
 * React components may not also export plain functions — the components live
 * there, the plumbing lives here.
 */
import { createContext, useContext } from 'react'
import type { GitBatchOp, GitBatchPhase } from '../../../../shared/git-batch'
import type { BatchFailure, BatchSummary } from '../../lib/pull-summary'

export interface BatchState {
  running: boolean
  op: GitBatchOp | null
  phase: GitBatchPhase | null
  /** Repos finished. */
  done: number
  /** Repos in the batch. 0 until the first progress event lands. */
  total: number
  repoName: string | null
  /** The summary held for a few seconds after the batch ends. */
  resultMessage: string | null
  /** The repos the batch could not do, with why. Non-empty, the summary is
   *  held until dismissed instead of for a few seconds. */
  failures: BatchFailure[]
}

export const IDLE: BatchState = {
  running: false,
  op: null,
  phase: null,
  done: 0,
  total: 0,
  repoName: null,
  resultMessage: null,
  failures: []
}

/** How long the finished summary stays on screen. */
export const RESULT_HOLD_MS = 4000

export interface GitBatchContextValue {
  state: BatchState
  /** Run one batch op. `task` returns the summary line to hold afterwards,
   *  or the line with the repos that failed. */
  run: (op: GitBatchOp, task: () => Promise<string | BatchSummary>) => Promise<void>
  /** Put away a held summary (the failures' one is held until this). */
  dismiss: () => void
}

export const GitBatchContext = createContext<GitBatchContextValue | null>(null)

export function useGitBatch(): GitBatchContextValue {
  const ctx = useContext(GitBatchContext)
  if (!ctx) throw new Error('useGitBatch must be used inside a GitBatchProvider')
  return ctx
}
