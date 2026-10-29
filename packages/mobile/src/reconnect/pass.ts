/**
 * The reconnection pass (decision 10 of the spec, the write-status seam of
 * 29 October 2026): when the machine is reachable again, the phone asks the
 * server about every send whose outcome it does not know and applies the
 * table, then refreshes the pending requests and the history of the open
 * conversations. Nothing is sent merely because the connection came back:
 *
 * - `accepted`: the send leaves the ledger, the draft is cleared when it is
 *   still the text sent, the mark is cleared.
 * - `pending`: asked again with backoff for at most a minute (lane C's
 *   `reconcile`), then `unknown`.
 * - `rejected`: the send leaves the ledger, the draft stays with the reason
 *   as its mark; a resend mints a new id.
 * - `absent`: the same send is completed with the same id and the same
 *   bytes, once, by lane C's `reconcile`; a second loss is `unknown`.
 * - `unknown`: nothing is sent; the send stays in the ledger and the draft
 *   stays, marked delivery unknown, with the person's choice.
 *
 * Pure over lane C's interfaces (`chat/send.ts`, `chat/drafts.ts`), so every
 * branch runs under Node, and the proof that `unknown` sends nothing is a
 * write port that counts.
 */
import type { Drafts } from '../chat/drafts'
import { reconcile, type SendOptions, type SendOutcome } from '../chat/send'
import type { WriteStatus } from '../contract/types'
import type { DeliveryMarks, UnknownSend, UnknownSends } from './ledger'

export interface ReconnectPorts {
  readonly sends: UnknownSends
  readonly marks: DeliveryMarks
  readonly drafts: Pick<Drafts, 'get' | 'clear'>
  /** `GET /sessions/writes` for this send; throws on failure. */
  readonly status: (send: UnknownSend) => Promise<WriteStatus>
  /** The same message under the same id; throws a `ServerError` on failure. */
  readonly write: (send: UnknownSend) => Promise<void>
  readonly sleep: (ms: number) => Promise<void>
  readonly now: () => number
  readonly refreshRequests: (machineId: string) => Promise<void>
  readonly refreshHistory: (machineId: string, sessionId: string) => Promise<void>
}

export interface ReconnectInput {
  readonly machineId: string
  /** The conversations open on the phone, whose history is refreshed. */
  readonly openConversations: readonly { readonly sessionId: string }[]
}

export interface ReconnectReport {
  readonly outcomes: readonly { readonly send: UnknownSend; readonly outcome: SendOutcome }[]
  readonly requestsRefreshed: boolean
  readonly historyRefreshed: readonly string[]
  readonly refreshFailures: readonly string[]
}

export async function reconnectPass(
  input: ReconnectInput,
  ports: ReconnectPorts,
  options: SendOptions = {}
): Promise<ReconnectReport> {
  const outcomes: { send: UnknownSend; outcome: SendOutcome }[] = []
  for (const send of await ports.sends.forMachine(input.machineId)) {
    const outcome = await reconcile(
      send.clientMessageId,
      {
        write: () => ports.write(send),
        status: () => ports.status(send),
        sleep: ports.sleep,
        now: ports.now
      },
      options,
      true
    )
    outcomes.push({ send, outcome })
    await settle(send, outcome, ports)
  }
  const refreshFailures: string[] = []
  let requestsRefreshed = false
  try {
    await ports.refreshRequests(input.machineId)
    requestsRefreshed = true
  } catch (error) {
    refreshFailures.push(`requests: ${error instanceof Error ? error.message : String(error)}`)
  }
  const historyRefreshed: string[] = []
  for (const { sessionId } of input.openConversations) {
    try {
      await ports.refreshHistory(input.machineId, sessionId)
      historyRefreshed.push(sessionId)
    } catch (error) {
      refreshFailures.push(
        `history ${sessionId}: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }
  return { outcomes, requestsRefreshed, historyRefreshed, refreshFailures }
}

/** The ledger, the draft and the mark after one send's outcome. */
async function settle(
  send: UnknownSend,
  outcome: SendOutcome,
  ports: ReconnectPorts
): Promise<void> {
  switch (outcome.kind) {
    case 'sent': {
      await ports.sends.remove(send.clientMessageId)
      if ((await ports.drafts.get(send.machineId, send.sessionId)) === send.text)
        await ports.drafts.clear(send.machineId, send.sessionId)
      await ports.marks.clear(send.machineId, send.sessionId)
      return
    }
    case 'rejected':
      await ports.sends.remove(send.clientMessageId)
      await ports.marks.set(send.machineId, send.sessionId, {
        kind: 'rejected',
        clientMessageId: send.clientMessageId,
        reason: outcome.reason,
        at: ports.now()
      })
      return
    case 'unknown':
      await ports.marks.set(send.machineId, send.sessionId, {
        kind: 'unknown',
        clientMessageId: send.clientMessageId,
        reason: outcome.reason,
        at: ports.now()
      })
      return
    case 'failed':
      // The machine is not reachable after all: the send waits for the next pass.
      return
  }
}

/** What the composer records when a send's outcome was not seen: the
 *  ledger entry and the mark, so a restart finds both. */
export async function recordUnknownSend(
  send: UnknownSend,
  reason: string,
  ports: Pick<ReconnectPorts, 'sends' | 'marks'>
): Promise<void> {
  await ports.sends.add(send)
  await ports.marks.set(send.machineId, send.sessionId, {
    kind: 'unknown',
    clientMessageId: send.clientMessageId,
    reason,
    at: send.at
  })
}

/** The person chose to discard a send of unknown outcome: it leaves the ledger and the mark. */
export async function discardUnknownSend(
  send: Pick<UnknownSend, 'machineId' | 'sessionId' | 'clientMessageId'>,
  ports: Pick<ReconnectPorts, 'sends' | 'marks'>
): Promise<void> {
  await ports.sends.remove(send.clientMessageId)
  await ports.marks.clear(send.machineId, send.sessionId)
}
