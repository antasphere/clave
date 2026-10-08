/**
 * Which view requests this window has already started (wave 3). The server
 * sends a waiting request again to every peer welcomed while it waits, and a
 * window whose push socket reconnected is a new peer to it, so the same
 * request can reach one window twice. The window is the one that knows what
 * it ran: a request id seen before is not run again, and only a request
 * this window started is answered through the server. Bounded, oldest ids
 * forgotten first, so a long-lived window keeps a few hundred ids at most.
 * Pure, so it is tested on its own; the preload holds one instance.
 */
export interface ViewRequestTracker {
  /** True the first time an id is seen, false for a repeat. */
  take(requestId: string): boolean
  /** Whether this window started that request (and has not answered it yet). */
  owns(requestId: string): boolean
  /** The request was answered: its id stays known as seen, not as pending. */
  answered(requestId: string): void
  readonly size: number
}

export function createViewRequestTracker(limit = 500): ViewRequestTracker {
  const seen = new Set<string>()
  const pending = new Set<string>()
  return {
    take(requestId) {
      if (seen.has(requestId)) return false
      seen.add(requestId)
      pending.add(requestId)
      if (seen.size > limit) {
        const oldest = seen.values().next().value
        if (oldest !== undefined) {
          seen.delete(oldest)
          pending.delete(oldest)
        }
      }
      return true
    },
    owns: (requestId) => pending.has(requestId),
    answered(requestId) {
      pending.delete(requestId)
    },
    get size() {
      return seen.size
    }
  }
}
