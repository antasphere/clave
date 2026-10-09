/**
 * The review relay of a window's preload (wave 3, lane A): the `.clave`
 * review as a round trip between the server and the shell's dialog.
 *
 * A read the preload sends through the server carries a `requestId` this
 * module minted. When the server meets an elevated file nobody trusted it
 * publishes `workspace_files.review_needed` with that id and holds the read;
 * the relay recognises its own id, asks the shell to show the Electron
 * dialog (`showDialog`, an IPC call in the preload), and answers the server
 * (`answer`, the client's command). A review carrying another window's id,
 * or none, is somebody else's and is left alone. The dialog stays the
 * shell's; the trust decision stays the server's; this module only carries
 * the question and the answer. An answer the server refuses (the review
 * timed out meanwhile) is logged and dropped: the read has answered already.
 *
 * Pure, and beside the preload rather than in the client package: it needs
 * nothing of the client at runtime, and the preload may import only the
 * client's router statically (`src/main/server/lazy-load.test.ts`).
 */
import type { ServerEvent, ServerEventEnvelope } from '@clave/contract/events'

type ReviewNeeded = Extract<ServerEvent, { _tag: 'workspace_files.review_needed' }>

export interface ReviewAnswer {
  readonly response: 0 | 1 | 2
  readonly checkboxChecked: boolean
}

export interface ReviewRelayOptions {
  /** Show the shell's dialog for a review; answers the person's word. */
  readonly showDialog: (review: ReviewNeeded) => Promise<ReviewAnswer>
  /** The client's answer command. */
  readonly answer: (reviewId: string, answer: ReviewAnswer) => Promise<void>
  /** Mints a request id; random by default. */
  readonly mintId?: () => string
  readonly log?: (message: string, error: unknown) => void
}

export interface ReviewRelay {
  /** Mark a read as this window's: the id to send with it. `done` once the
   *  read has answered, so a late event for it is nobody's. */
  readonly begin: () => { requestId: string; done: () => void }
  /** Hand every server event here; one about this window's read is handled. */
  readonly onEvent: (envelope: ServerEventEnvelope) => void
  /** How many reads are waiting for an answer (tests). */
  readonly pending: () => number
}

export function createReviewRelay(options: ReviewRelayOptions): ReviewRelay {
  const mintId = options.mintId ?? (() => crypto.randomUUID())
  const log = options.log ?? ((message, error) => console.error(message, error))
  const pending = new Set<string>()
  return {
    begin: () => {
      const requestId = mintId()
      pending.add(requestId)
      return {
        requestId,
        done: () => {
          pending.delete(requestId)
        }
      }
    },
    onEvent: (envelope) => {
      const event = envelope.event
      if (event._tag !== 'workspace_files.review_needed') return
      if (event.requestId === null || !pending.has(event.requestId)) return
      const requestId = event.requestId
      void options
        .showDialog(event)
        .then((answer) => {
          // The read answered meanwhile (a deadline, the server gone): the
          // person's word is for a read nobody waits on, and sending it
          // would trust content for nothing. Dropped, said in the log.
          if (!pending.has(requestId)) {
            log('[clave] workspace file review answered after its read ended; dropped', null)
            return
          }
          return options.answer(event.reviewId, answer)
        })
        .catch((error) => log('[clave] workspace file review not answered', error))
    },
    pending: () => pending.size
  }
}

/**
 * The watches a window holds, and the transport each is held on. A watch
 * taken over IPC before the server was named is RE-TAKEN on the server once
 * it is, and released on IPC, so a change never lands on a transport the
 * window stopped hearing (the shape of wave 2's lost subscriptions: a
 * subscription taken on one transport and released on another). The same
 * path watched twice is one watch; a release goes to the transport that
 * holds it.
 */
export interface WatchTransports {
  readonly ipc: { watch: (path: string) => Promise<void>; unwatch: (path: string) => Promise<void> }
  readonly server: {
    watch: (path: string) => Promise<void>
    unwatch: (path: string) => Promise<void>
  }
}

export interface WatchLedger {
  /** Take a watch on the transport given. */
  readonly watch: (path: string, via: 'ipc' | 'server') => Promise<void>
  /** Release the watch wherever it is held. */
  readonly unwatch: (path: string) => Promise<void>
  /** The server is here: every IPC watch moves to it. */
  readonly moveToServer: () => Promise<void>
  /** Where a path's watch is held (tests). */
  readonly heldOn: (path: string) => 'ipc' | 'server' | null
}

export function createWatchLedger(
  transports: WatchTransports,
  log: (message: string, error: unknown) => void = (message, error) => console.error(message, error)
): WatchLedger {
  const held = new Map<string, 'ipc' | 'server'>()
  let serverKnown = false
  const take = async (path: string, via: 'ipc' | 'server'): Promise<void> => {
    held.set(path, via)
    await transports[via].watch(path)
    // The server came while the IPC watch was in flight: it moves at once.
    if (via === 'ipc' && serverKnown && held.get(path) === 'ipc') await move(path)
  }
  const moving = new Set<string>()
  const move = async (path: string): Promise<void> => {
    if (held.get(path) !== 'ipc' || moving.has(path)) return
    moving.add(path)
    try {
      // The server takes the watch FIRST; the ledger marks it the server's
      // only then, so a server watch that fails leaves the watch where it
      // is, on IPC, where a release can still reach it (round 2's verifier
      // found the IPC holder stranded for good when this order was reversed).
      await transports.server.watch(path)
      if (held.get(path) !== 'ipc') {
        // Released meanwhile: give the server's watch back.
        await transports.server.unwatch(path)
        return
      }
      held.set(path, 'server')
      await transports.ipc.unwatch(path)
    } catch (error) {
      log('[clave] workspace file watch not moved to the server', error)
    } finally {
      moving.delete(path)
    }
  }
  return {
    watch: (path, via) => take(path, serverKnown ? 'server' : via),
    unwatch: async (path) => {
      const via = held.get(path)
      if (!via) return
      held.delete(path)
      await transports[via].unwatch(path)
    },
    moveToServer: async () => {
      serverKnown = true
      await Promise.all([...held.keys()].map(move))
    },
    heldOn: (path) => held.get(path) ?? null
  }
}
