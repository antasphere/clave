/**
 * A model switch the policy made, until the provider confirms it
 * (PRDCT-4302). `set_model` is written at once but the session's model in
 * the sidebar store changes only when the provider's own word comes back
 * (the model push, PRDCT-4256); between the two the session's view is still
 * judged by the model the cap stopped, so the policy would offer the ladder
 * again, and in automatic mode write a second `set_model`. A pending switch
 * holds the policy off that session, as a restart does, until the store
 * shows the model, or until the window closes (the CLI refused the switch
 * and the chip reverted; nothing says so here) and the policy may act again.
 */
export const MODEL_SWITCH_WINDOW_MS = 15_000

export class PendingModelSwitches {
  private pending = new Map<string, { model: string; until: number }>()

  begin(sessionId: string, model: string, now: number = Date.now()): void {
    this.pending.set(sessionId, { model, until: now + MODEL_SWITCH_WINDOW_MS })
  }

  /** Whether a switch is still in flight: the store does not show the model
   *  yet and the window is open. Settles itself when either changes. */
  inFlight(sessionId: string, currentModel: string | undefined, now: number = Date.now()): boolean {
    const p = this.pending.get(sessionId)
    if (!p) return false
    if (currentModel === p.model || now > p.until) {
      this.pending.delete(sessionId)
      return false
    }
    return true
  }

  forget(sessionId: string): void {
    this.pending.delete(sessionId)
  }
}
