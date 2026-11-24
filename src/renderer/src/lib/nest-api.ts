/**
 * The one place the renderer reaches the server's nesting (PRDCT-4997): nest
 * a tab under another, take it out, and hear every nesting the server
 * accepted, whoever asked (this window, another window, an agent's tool).
 * The store and the events go through here, so a test stands in for the
 * server by mocking this one module.
 */

/** A nesting the server accepted, as it tells every window. */
export interface NestedEvent {
  id: string
  under: string | null
}

export const nestApi = {
  /** Nest `id` under `under`, or take it out with null. Throws an Error
   *  carrying the refusal's sentence, or saying the bridge is missing. */
  async nest(id: string, under: string | null): Promise<void> {
    const api = window.electronAPI
    if (!api?.sessionsNest)
      throw new Error('This window cannot nest tabs: its bridge has no nesting')
    try {
      await api.sessionsNest(id, under)
    } catch (err) {
      // What crosses the bridge is not always an Error of this realm: the
      // sentence is kept, the rest is dropped.
      throw new Error(err instanceof Error ? err.message : String(err))
    }
  },
  /** Hear every nesting the server accepted. A window whose bridge has no
   *  such channel hears nothing, and its unsubscribe does nothing. */
  onNested(cb: (event: NestedEvent) => void): () => void {
    return window.electronAPI?.onSessionNested?.(cb) ?? (() => {})
  }
}
