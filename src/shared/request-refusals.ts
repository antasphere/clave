/** The words a host or an adapter refuses an answer with when it no longer
 *  holds the request the answer names. The server's write refusal carries the
 *  message and not the code, and the IPC road wraps the message in its own,
 *  so a view tells a gone request from a failure of any other kind by these
 *  words: thrown from here and read from here, never retyped. */
export const REQUEST_GONE = Object.freeze({
  /** The server's request store has no record of the request: cancelled and
   *  pruned after its retention, or never seen (`not_found`). */
  notFound: 'No such provider request.',
  /** The store's record was settled already: answered by another client, or
   *  cancelled when the provider withdrew it or the turn ended (`closed`). */
  settled: 'The request was already settled.',
  /** Claude's adapter no longer holds the request; the request id follows. */
  claude: 'Unknown Claude permission request',
  /** Codex's adapter no longer holds the approval. */
  codex: 'Unknown or expired Codex approval option'
})

/** Whether a failed permission response says the request is gone, as against
 *  a failure the reader may retry: an option the provider refused, an answer
 *  it found incomplete, a server down. */
export function requestGone(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return Object.values(REQUEST_GONE).some((words) => message.includes(words))
}
