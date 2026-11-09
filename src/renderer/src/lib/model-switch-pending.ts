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
  /** The model a window closed on without the store showing it: the CLI
   *  refused it (or never answered), so the policy does not offer it again
   *  while the report stays open; the account rung takes over. */
  private refused = new Map<string, string>()

  begin(sessionId: string, model: string, now: number = Date.now()): void {
    this.pending.set(sessionId, { model, until: now + MODEL_SWITCH_WINDOW_MS })
  }

  /** Whether a switch is still in flight: the store does not show the model
   *  yet and the window is open. Settles itself when either changes; a
   *  window that closes without the model is remembered as refused. */
  inFlight(sessionId: string, currentModel: string | undefined, now: number = Date.now()): boolean {
    const p = this.pending.get(sessionId)
    if (!p) return false
    if (currentModel === p.model) {
      this.pending.delete(sessionId)
      this.refused.delete(sessionId)
      return false
    }
    if (now > p.until) {
      this.pending.delete(sessionId)
      this.refused.set(sessionId, p.model)
      return false
    }
    return true
  }

  /** The model the last window closed on without confirmation, or null. */
  refusedModel(sessionId: string): string | null {
    return this.refused.get(sessionId) ?? null
  }

  forget(sessionId: string): void {
    this.pending.delete(sessionId)
    this.refused.delete(sessionId)
  }
}
