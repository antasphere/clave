/**
 * One restart, applied once. A restart the window asks for itself
 * (`restartSessionProcess`: the Switch account menu, the automatic switch at
 * a limit, the Play button) comes back to the store twice on the server
 * road: as the answer of the call, and as the server's `session.restarted`
 * push, which every window hears (`served-events.ts`), this one included.
 * Each application bumps the pane's restart epoch and remounts it, so two
 * would remount the same pane twice on one process. The window marks the
 * restart it starts; the first of the two to arrive applies, the second
 * finds the mark applied and steps aside. A restart the window did not ask
 * for (an agent's `clave_switch_account`, another window's move) has no
 * mark and is applied by the push as before.
 *
 * The marks are short-lived: on the one road where no push follows (IPC,
 * before the shell has named its server) the mark would otherwise linger
 * and swallow a later restart of the same tab by an agent. The server
 * publishes the push before it answers, so a mark older than the TTL has
 * no second arrival left to wait for.
 */
export const OWN_RESTART_TTL_MS = 5_000

interface Mark {
  at: number
  applied: boolean
}

const marks = new Map<string, Mark>()

/** The window is about to ask for this tab's restart. */
export function beginOwnRestart(id: string, now: number = Date.now()): void {
  marks.set(id, { at: now, applied: false })
}

/** The call failed before anything restarted: a push that still comes (the
 *  server did the move and only the answer was lost) applies as a stranger's. */
export function abandonOwnRestart(id: string): void {
  marks.delete(id)
}

/** Whether the ANSWER of the window's own call should apply the restart:
 *  not when the push already did. The mark stays, applied, for a push that
 *  arrives after the answer; it is forgotten when that push consumes it or
 *  when it is older than the TTL. */
export function ownAnswerApplies(id: string, now: number = Date.now()): boolean {
  const mark = marks.get(id)
  if (!mark) return true
  if (mark.applied) {
    marks.delete(id)
    return false
  }
  mark.applied = true
  mark.at = now
  return true
}

/** Whether a `session.restarted` PUSH should apply the restart: always for
 *  a tab this window did not restart itself, and for its own restart only
 *  when the answer has not applied it already. */
export function servedRestartApplies(id: string, now: number = Date.now()): boolean {
  const mark = marks.get(id)
  if (!mark) return true
  if (now - mark.at > OWN_RESTART_TTL_MS) {
    marks.delete(id)
    return true
  }
  if (mark.applied) {
    marks.delete(id)
    return false
  }
  mark.applied = true
  mark.at = now
  return true
}

/** Test seam. */
export function resetOwnRestarts(): void {
  marks.clear()
}
