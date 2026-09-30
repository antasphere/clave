import { ipcMain } from 'electron'
import { z } from 'zod'
import {
  CommentBodySchema,
  MergeMethodSchema,
  PullRefSchema,
  ReviewEventSchema,
  type GithubResult
} from '../../shared/github-pull'
import {
  commentOnPullRequest,
  fetchPullRequest,
  fetchPullRequestDiff,
  mergePullRequest,
  reviewPullRequest
} from '../github-cli'

/** Every argument is re-validated here, whatever the renderer sent: a pull
 *  request reference an agent's link produced becomes `gh` arguments, and the
 *  schema is what keeps it a repository name and a number. A refusal is a
 *  result, not a throw, so the panel shows it as it shows a `gh` failure. */
function refuse(error: unknown): GithubResult<never> {
  return { ok: false, kind: 'failed', message: `Refused: ${String(error)}` }
}

export function registerGithubHandlers(): void {
  ipcMain.handle('github:pull', (_event, ref: unknown) => {
    const parsed = PullRefSchema.safeParse(ref)
    return parsed.success ? fetchPullRequest(parsed.data) : refuse(parsed.error.message)
  })
  ipcMain.handle('github:pull-diff', (_event, ref: unknown) => {
    const parsed = PullRefSchema.safeParse(ref)
    return parsed.success ? fetchPullRequestDiff(parsed.data) : refuse(parsed.error.message)
  })
  ipcMain.handle('github:pull-comment', (_event, ref: unknown, body: unknown) => {
    const parsedRef = PullRefSchema.safeParse(ref)
    const parsedBody = CommentBodySchema.safeParse(body)
    if (!parsedRef.success) return refuse(parsedRef.error.message)
    if (!parsedBody.success) return refuse('a comment needs a body')
    return commentOnPullRequest(parsedRef.data, parsedBody.data)
  })
  ipcMain.handle('github:pull-review', (_event, ref: unknown, event: unknown, body: unknown) => {
    const parsedRef = PullRefSchema.safeParse(ref)
    const parsedEvent = ReviewEventSchema.safeParse(event)
    // An approval needs no words; a request for changes or a comment does,
    // which is GitHub's rule as much as ours.
    const parsedBody = (
      parsedEvent.success && parsedEvent.data === 'approve'
        ? CommentBodySchema.or(z.literal(''))
        : CommentBodySchema
    ).safeParse(body ?? '')
    if (!parsedRef.success) return refuse(parsedRef.error.message)
    if (!parsedEvent.success) return refuse('unknown review event')
    if (!parsedBody.success) return refuse('this review needs a body')
    return reviewPullRequest(parsedRef.data, parsedEvent.data, parsedBody.data)
  })
  ipcMain.handle('github:pull-merge', (_event, ref: unknown, method: unknown) => {
    const parsedRef = PullRefSchema.safeParse(ref)
    const parsedMethod = MergeMethodSchema.safeParse(method)
    if (!parsedRef.success) return refuse(parsedRef.error.message)
    if (!parsedMethod.success) return refuse('unknown merge method')
    return mergePullRequest(parsedRef.data, parsedMethod.data)
  })
}
