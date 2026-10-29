/**
 * A send and what the phone does when its outcome is not seen (decision 10
 * of the spec and the write-status seam of 29 October 2026): the message
 * goes out under an id the phone minted; when the write's answer is lost (a
 * reset, a timeout, the network gone), the phone asks the server what it
 * knows of that id and applies the table:
 *
 * - `accepted`: the draft is cleared, the message counts as sent.
 * - `pending`: ask again with backoff, for at most 60 s; then `unknown`.
 * - `rejected`: the draft is kept and the reason shown; a resend is a new id.
 * - `absent`: the same send is completed once with the same id, the one
 *   retry the reconciliation permits; a second loss is `unknown`.
 * - `unknown`: nothing is sent by itself; the draft stays, marked delivery
 *   unknown, and the person chooses: send again under a new id (the phone
 *   says it may duplicate) or discard. A server without the status route
 *   (404) cannot tell either: `unknown`.
 *
 * Pure over its ports, so every branch runs under Node.
 */
import { ServerError } from '../api/errors'
import type { WriteStatus, WriteAnswer } from '../contract/types'

export interface SendPorts {
  /** Performs the write under this id; throws a `ServerError` on failure. */
  readonly write: (clientMessageId: string) => Promise<WriteAnswer>
  /** Asks the server what it knows of the id; throws on failure. */
  readonly status: (clientMessageId: string) => Promise<WriteStatus>
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
}

export type SendOutcome =
  /** The message landed: at once, or found `accepted` on reconciliation. */
  | { readonly kind: 'sent'; readonly clientMessageId: string; readonly reconciled: boolean }
  /** The server refused the write or recorded it rejected: the draft stays. */
  | { readonly kind: 'rejected'; readonly clientMessageId: string; readonly reason: string }
  /** Nobody can tell: the draft stays, nothing was sent by itself. */
  | { readonly kind: 'unknown'; readonly clientMessageId: string; readonly reason: string }
  /** Another kind of failure (the token refused, an unreadable answer): the draft stays. */
  | { readonly kind: 'failed'; readonly clientMessageId: string; readonly reason: string }

export interface SendOptions {
  /** How long `pending` is asked again before it counts as `unknown`. */
  readonly pendingBudgetMs?: number
  /** The first wait between two status asks; doubles up to `maxBackoffMs`. */
  readonly backoffMs?: number
  readonly maxBackoffMs?: number
}

const outcomeLost = (error: unknown): boolean =>
  error instanceof ServerError &&
  (error.kind === 'network' || error.kind === 'timeout' || error.kind === 'protocol')

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** One send: the write, then the table when the answer was lost. */
export async function sendMessage(
  clientMessageId: string,
  ports: SendPorts,
  options: SendOptions = {}
): Promise<SendOutcome> {
  try {
    const answer = await ports.write(clientMessageId)
    if (answer.status === 'accepted') return { kind: 'sent', clientMessageId, reconciled: false }
  } catch (error) {
    if (!outcomeLost(error)) return refusal(clientMessageId, error)
  }
  return reconcile(clientMessageId, ports, options, true)
}

/** The server answered the write with a refusal: the message did not land. */
function refusal(clientMessageId: string, error: unknown): SendOutcome {
  if (error instanceof ServerError && error.failure?._tag === 'SessionWriteUnknown')
    return { kind: 'unknown', clientMessageId, reason: error.message }
  if (error instanceof ServerError && error.kind === 'refused')
    return { kind: 'rejected', clientMessageId, reason: error.message }
  return { kind: 'failed', clientMessageId, reason: reasonOf(error) }
}

/**
 * The table, for a send whose outcome was not seen. `mayRetry` is the one
 * same-id retry `absent` permits; it is spent by the first `absent`, so a
 * send lost twice ends `unknown`.
 */
export async function reconcile(
  clientMessageId: string,
  ports: SendPorts,
  options: SendOptions = {},
  mayRetry = true
): Promise<SendOutcome> {
  const budget = options.pendingBudgetMs ?? 60_000
  const maxBackoff = options.maxBackoffMs ?? 8_000
  let backoff = options.backoffMs ?? 1_000
  const started = ports.now()
  for (;;) {
    let status: WriteStatus
    try {
      status = await ports.status(clientMessageId)
    } catch (error) {
      // A server without the route (404), or one we cannot reach: it cannot
      // tell, and neither can the phone.
      return {
        kind: 'unknown',
        clientMessageId,
        reason:
          error instanceof ServerError && error.status === 404
            ? 'This server cannot say whether the message arrived.'
            : `The server could not be asked whether the message arrived (${reasonOf(error)}).`
      }
    }
    switch (status.status) {
      case 'accepted':
        return { kind: 'sent', clientMessageId, reconciled: true }
      case 'rejected':
        return {
          kind: 'rejected',
          clientMessageId,
          reason: status.reason ?? 'The server refused the message.'
        }
      case 'unknown':
        return {
          kind: 'unknown',
          clientMessageId,
          reason: status.reason ?? 'The server cannot say whether the message arrived.'
        }
      case 'absent': {
        if (!mayRetry)
          return {
            kind: 'unknown',
            clientMessageId,
            reason: 'The message was sent again once and its outcome is still not known.'
          }
        try {
          const answer = await ports.write(clientMessageId)
          if (answer.status === 'accepted')
            return { kind: 'sent', clientMessageId, reconciled: true }
          return reconcile(clientMessageId, ports, options, false)
        } catch (error) {
          if (!outcomeLost(error)) return refusal(clientMessageId, error)
          return reconcile(clientMessageId, ports, options, false)
        }
      }
      case 'pending': {
        if (ports.now() - started >= budget)
          return {
            kind: 'unknown',
            clientMessageId,
            reason: 'The server is still working on the message after a minute.'
          }
        await ports.sleep(Math.min(backoff, Math.max(0, budget - (ports.now() - started))))
        backoff = Math.min(maxBackoff, backoff * 2)
      }
    }
  }
}
