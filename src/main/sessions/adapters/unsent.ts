import { parseDelivery } from '../../../shared/exchange-provenance'

/**
 * Messages that leave a chat unsent (PRDCT-4566): withdrawn, refused, or still
 * waiting when the turn is stopped or the session ends. The person's own go
 * back to the composer. A message another tab sent never does, its words not
 * being the person's: it is dropped, and the conversation says so in one plain
 * line naming its tab, so that nothing disappears silently. Shared by the
 * OpenCode and the Pi chats.
 */
export function splitUnsent<T>(
  messages: readonly T[],
  textOf: (message: T) => string
): { own: T[]; notices: string[] } {
  const own: T[] = []
  const notices: string[] = []
  for (const message of messages) {
    const delivery = parseDelivery(textOf(message))
    if (delivery) notices.push(unsentDelivery(delivery.sender?.name ?? null))
    else own.push(message)
  }
  return { own, notices }
}

/** The line a dropped message from another tab leaves in the conversation,
 *  naming the tab as its card does ("another agent" when it has no name). */
export const unsentDelivery = (tab: string | null): string =>
  `A message from ${tab ?? 'another agent'} was not sent.`
