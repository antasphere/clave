/**
 * The one place the renderer reaches the server's nesting (PRDCT-4997): nest
 * a tab under another, take it out, and hear every nesting the server
 * accepted, whoever asked (this window, another window, an agent's tool).
 * The store and the events go through here, so a test stands in for the
 * server by mocking this one module.
 */

import { NestRefused, nestRefusalIn } from '../../../shared/nest-tools'

/** A nesting the server accepted, as it tells every window. */
export interface NestedEvent {
  id: string
  under: string | null
}

/** What a call across the bridge threw, as this realm throws it: the server's
 *  no as a `NestRefused` carrying its sentence, anything else (a call that
 *  was never answered) as a plain Error with the words that came. What
 *  crosses the bridge is not always an Error of this realm: the message is
 *  kept, the rest is dropped. */
export function nestErrorOf(err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err)
  const refusal = nestRefusalIn(message)
  return refusal === null ? new Error(message) : new NestRefused(refusal)
}

export const nestApi = {
  /** Nest `id` under `under`, or take it out with null. Throws a
   *  `NestRefused` carrying the server's sentence when the server said no,
   *  and a plain Error when it could not be asked (or the bridge is missing). */
  async nest(id: string, under: string | null): Promise<void> {
    const api = window.electronAPI
    if (!api?.sessionsNest)
      throw new Error('This window cannot nest tabs: its bridge has no nesting')
    try {
      await api.sessionsNest(id, under)
    } catch (err) {
      throw nestErrorOf(err)
    }
  },
  /** Hear every nesting the server accepted. A window whose bridge has no
   *  such channel hears nothing, and its unsubscribe does nothing. */
  onNested(cb: (event: NestedEvent) => void): () => void {
    return window.electronAPI?.onSessionNested?.(cb) ?? (() => {})
  }
}
