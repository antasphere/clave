/**
 * The reviews the server is waiting on. A read that meets an elevated file
 * nobody trusted cannot show a dialog here: the server may have no window.
 * It publishes `workspace_files.review_needed` with what the dialog must
 * disclose and HOLDS the read until a client answers with
 * `AnswerWorkspaceFileReview`, or until the review times out, which reads
 * as Cancel: silence is not trust. One desk per server; a review is answered
 * once, and an answer to a review the desk does not hold is refused.
 */
import { randomUUID } from 'node:crypto'
import { Context, Effect, Layer } from 'effect'
import type { ReviewAnswer } from '@clave/contract/workspace-files'
import type { ReviewRequest } from './files'

/** Five minutes: long enough to read a dialog, short enough that a window
 *  that went away does not hold a read forever. */
export const REVIEW_TIMEOUT_MS = 5 * 60 * 1000

export interface ReviewDeskService {
  /** Hold a review: `announce` is given the id to publish, the promise
   *  answers with the client's word or null at the timeout. */
  readonly ask: (
    request: ReviewRequest,
    announce: (reviewId: string) => void | Promise<void>
  ) => Promise<ReviewAnswer | null>
  /** The client's word; false when no review carries the id. */
  readonly answer: (reviewId: string, answer: ReviewAnswer) => boolean
  /** How many reviews are waiting (tests). */
  readonly pending: () => number
  /** The server is stopping: every waiting review reads as Cancel at once,
   *  so a held read answers and the stop does not wait on a dialog. */
  readonly close: () => void
}

export class ReviewDesk extends Context.Tag('@clave/server/ReviewDesk')<
  ReviewDesk,
  ReviewDeskService
>() {
  /** Scoped: the desk closes with the server, settling what it still holds.
   *  Round 2 of the lane's verifier watched a standalone outlive its SIGTERM
   *  by five minutes on one open review, and the app's quit awaits the same
   *  stop. */
  static layer(options: { timeoutMs?: number } = {}): Layer.Layer<ReviewDesk> {
    return Layer.scoped(
      ReviewDesk,
      Effect.acquireRelease(
        Effect.sync(() => makeReviewDesk(options)),
        (desk) => Effect.sync(() => desk.close())
      )
    )
  }
}

export function makeReviewDesk(options: { timeoutMs?: number } = {}): ReviewDeskService {
  const timeoutMs = options.timeoutMs ?? REVIEW_TIMEOUT_MS
  const waiting = new Map<string, (answer: ReviewAnswer | null) => void>()
  // Once closed the desk stays closed: a read that reaches it after the
  // server began stopping (parsed and described while the finalizer ran)
  // is Cancel at once, never held for the timeout (round 3's verifier).
  let closed = false
  return {
    ask: (_request, announce) =>
      new Promise<ReviewAnswer | null>((resolve) => {
        if (closed) {
          resolve(null)
          return
        }
        const reviewId = randomUUID()
        const timer = setTimeout(() => settle(null), timeoutMs)
        timer.unref?.()
        const settle = (answer: ReviewAnswer | null): void => {
          if (!waiting.has(reviewId)) return
          waiting.delete(reviewId)
          clearTimeout(timer)
          resolve(answer)
        }
        waiting.set(reviewId, settle)
        // A publish that fails leaves nobody able to answer: cancel at once
        // rather than hold the read for the whole timeout.
        Promise.resolve()
          .then(() => announce(reviewId))
          .catch((error) => {
            console.error('[clave-server] review not announced', error)
            settle(null)
          })
      }),
    answer: (reviewId, answer) => {
      const settle = waiting.get(reviewId)
      if (!settle) return false
      settle(answer)
      return true
    },
    pending: () => waiting.size,
    close: () => {
      closed = true
      for (const settle of [...waiting.values()]) settle(null)
    }
  }
}
