/**
 * The acknowledgement a target window sends once it adopted the sessions
 * handed to it (`session:rehome` → `window:rehomed`), for a caller that must
 * act on a moved tab in its new window (an MCP move into a group there).
 *
 * Pure, so vitest pins the rule that matters: a waiter is registered BEFORE
 * the move is dispatched and resolves on the ack; an ack nobody waits for
 * is DROPPED — never remembered. The first version latched unsolicited acks
 * (every sidebar move, every window close leaves one), so the next wait for
 * the same id resolved instantly and the caller acted before the adoption
 * ran. A wait that sees no ack resolves at its timeout, never rejects: the
 * follow-up command then fails on its own terms ("no such session") rather
 * than hanging.
 */
export class RehomeAck {
  private readonly waiters = new Map<string, Set<() => void>>()

  /** Resolves when every id was acknowledged, or at the timeout. */
  wait(sessionIds: string[], timeoutMs = 10_000): Promise<void> {
    return Promise.all(
      sessionIds.map(
        (id) =>
          new Promise<void>((resolve) => {
            const done = (): void => {
              clearTimeout(timer)
              this.waiters.get(id)?.delete(done)
              if (this.waiters.get(id)?.size === 0) this.waiters.delete(id)
              resolve()
            }
            const timer = setTimeout(done, timeoutMs)
            const set = this.waiters.get(id) ?? new Set<() => void>()
            set.add(done)
            this.waiters.set(id, set)
          })
      )
    ).then(() => undefined)
  }

  /** The renderer's acknowledgement: wakes the waiters of these ids, if any. */
  ack(sessionIds: string[]): void {
    for (const id of sessionIds) {
      const set = this.waiters.get(id)
      if (!set) continue
      for (const done of [...set]) done()
    }
  }

  /** Ids currently awaited (for tests). */
  pending(): string[] {
    return [...this.waiters.keys()]
  }
}

export const rehomeAck = new RehomeAck()
