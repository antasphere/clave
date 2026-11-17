/** One thing said or done in a conversation, as the agent tools hand it on. */
interface Said<E> {
  readonly event: E
  readonly at?: number
}

type Answer<T> = T | Promise<T>

/**
 * A chat's recent conversation as an agent reads it (`clave_read_session`):
 * the session's timeline, where its views read it, which holds the past the
 * chat was resumed with and everything said since, in order.
 *
 * The legacy past (`history`) is only what was said BEFORE this process. Read
 * alone, a chat that had been resumed answered what it said before its resume
 * and nothing since, and a refusal said at start answered nothing at all
 * (PRDCT-4664). A host with no timeline (a server older than it) answers
 * null, and one whose timeline cannot be read throws: both keep the past.
 */
export async function recentConversation<E>(
  timeline: () => Answer<{ readonly items: readonly Said<E>[] } | null | undefined>,
  history: () => Answer<{ readonly items: readonly Said<E>[] }>
): Promise<Said<E>[]> {
  let page: { readonly items: readonly Said<E>[] } | null | undefined
  try {
    page = await timeline()
  } catch {
    page = null
  }
  // The position is the reader's business, not the agent's.
  return (page ?? (await history())).items.map(({ event, at }) => ({
    event,
    ...(at !== undefined && { at })
  }))
}
