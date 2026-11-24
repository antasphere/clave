/**
 * The one place the renderer reaches the server's nesting (PRDCT-4997): nest
 * a tab under another, take it out, and hear every nesting the server
 * accepted, whoever asked (this window, another window, an agent's tool).
 *
 * The two preload members are declared here through a local interface and a
 * cast, because the preload that exposes them is built beside this file and
 * its declaration has not met this one yet. When it has, the cast goes and
 * the members are read from `window.electronAPI` as declared.
 */

/** A nesting the server accepted, as it tells every window. */
export interface NestedEvent {
  id: string
  under: string | null
}

interface NestBridge {
  sessionsNest?: (
    id: string,
    under: string | null
  ) => Promise<{ id: string; under: string | null; changed: boolean }>
  onSessionNested?: (cb: (p: NestedEvent) => void) => () => void
}

const bridge = (): NestBridge | undefined =>
  (globalThis as unknown as { window?: { electronAPI?: NestBridge } }).window?.electronAPI

export const nestApi = {
  /** Nest `id` under `under`, or take it out with null. Throws an Error
   *  carrying the refusal's sentence, or saying the bridge is missing. */
  async nest(id: string, under: string | null): Promise<void> {
    const api = bridge()
    if (!api?.sessionsNest)
      throw new Error('This window cannot nest tabs: its bridge has no nesting')
    try {
      await api.sessionsNest(id, under)
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err))
    }
  },
  /** Hear every nesting the server accepted. A window whose bridge has no
   *  such channel hears nothing, and its unsubscribe does nothing. */
  onNested(cb: (p: NestedEvent) => void): () => void {
    const api = bridge()
    if (!api?.onSessionNested) return () => {}
    return api.onSessionNested(cb)
  }
}
