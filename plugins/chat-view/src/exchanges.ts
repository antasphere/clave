import { createContext, useContext } from 'react'
import { parseDelivery } from '../../../src/shared/exchange-provenance'
import {
  clipDigestMessages,
  type DigestLaunch,
  type DigestMessage
} from '../../../src/shared/exchange-digest'
import type { Entry } from './reducer'
import type { DeliveryEntry, DeliveryGroup } from './tools'

/** One side of an exchange this session wrote: what it sent to the other tab
 *  through clave_send_to_session, and when. */
export interface ExchangeSide {
  text: string
  at: number
}

/** A message another tab sent, with the two things around it this session
 *  wrote: what it had sent that tab before (the request the message answers)
 *  and what it sent that tab after (its reply). */
export interface Exchange {
  request?: ExchangeSide
  reply?: ExchangeSide
}

export type ExchangeIndex = Map<DeliveryEntry, Exchange>

/** The tool name, bare or as an MCP server exposes it (`mcp__clave__…`). */
const SEND = /(^|__)clave_send_to_session$/

/** What a call to clave_send_to_session sent, and to whom; null for any other
 *  entry, and for a call whose input is not that shape. */
export function sentMessage(entry: Entry): { to: string; side: ExchangeSide } | null {
  if (entry.kind !== 'tool' || !entry.name || !SEND.test(entry.name)) return null
  const input = entry.input as { sessionId?: unknown; message?: unknown } | undefined
  if (typeof input?.sessionId !== 'string' || typeof input.message !== 'string') return null
  return { to: input.sessionId, side: { text: input.message, at: entry.at } }
}

/**
 * Pairs every message from another tab with what this session sent that same
 * tab around it, by the tab's id alone: the id the delivery's header carries
 * and the `sessionId` the send names. Never by the words — on 5 November 2026
 * a reading of who the agent's words were for hid a question meant for the
 * reader. In order:
 *
 *  - a send to a tab that has a message waiting for an answer is that
 *    message's reply;
 *  - any other send is a request, and the next message from that tab is the
 *    one answering it.
 *
 * A send that answered a message is not also the request of the next one:
 * each piece of writing appears in one exchange.
 */
export function indexExchanges(entries: readonly Entry[]): ExchangeIndex {
  const index: ExchangeIndex = new Map()
  const requests = new Map<string, ExchangeSide>()
  const waiting = new Map<string, Exchange>()
  for (const entry of entries) {
    const sent = sentMessage(entry)
    if (sent) {
      const open = waiting.get(sent.to)
      if (open) {
        open.reply = sent.side
        waiting.delete(sent.to)
      } else requests.set(sent.to, sent.side)
      continue
    }
    if (entry.kind !== 'user') continue
    const delivery = parseDelivery(entry.text)
    if (!delivery) continue
    const exchange: Exchange = {}
    const from = delivery.sender?.id
    if (from) {
      exchange.request = requests.get(from)
      requests.delete(from)
      waiting.set(from, exchange)
    }
    index.set(entry, exchange)
  }
  return index
}

/** What the exchange timelines of a view share: the pairs, and how to ask
 *  for a digest the way the session runs its agent. */
export interface Exchanges {
  /** The tab the view shows: its digests are filed under it. */
  sessionId: string
  index: ExchangeIndex
  launch: DigestLaunch
  /** The timelines whose digest is read on its own: the conversation's latest
   *  few (RECENT_DIGESTS). An older one shows a digest only if one was read. */
  recent: ReadonlySet<string>
}

export const ExchangeContext = createContext<Exchanges>({
  sessionId: '',
  index: new Map(),
  launch: {},
  recent: new Set()
})

/** How many of a conversation's latest timelines are read without asking. */
export const RECENT_DIGESTS = 3

/** The keys of the latest RECENT_DIGESTS timelines among a view's rows. */
export function recentTimelines(
  rows: readonly { key: string; block: { kind: string } }[]
): Set<string> {
  const keys = rows.filter((row) => row.block.kind === 'delivery-group').map((row) => row.key)
  return new Set(keys.slice(-RECENT_DIGESTS))
}

export function useExchange(entry: DeliveryEntry): Exchange {
  return useContext(ExchangeContext).index.get(entry) ?? {}
}

export function useExchanges(): Exchanges {
  return useContext(ExchangeContext)
}

/** A message's first line worth reading, for the card's closed face: the
 *  first non-empty line, without a heading's or a list's markup. */
export function gist(body: string): string {
  for (const line of body.split('\n')) {
    const text = line.replace(/^\s*(#{1,6}\s+|[-*+]\s+|>\s*)/, '').trim()
    if (text) return text
  }
  return ''
}

/** What a timeline's digest reads: each message, its sender, and what this
 *  session asked before it and answered after it (`indexExchanges`), clipped
 *  as the host clips it (`clipDigestMessages`, PRDCT-4327): the latest
 *  messages, each text clipped, so a pasted log of any length is read. The
 *  view and the timeline compute it alike, so they agree on its key; the
 *  messages left out in front are `group.messages.length - result.length`. */
export function digestMessages(group: DeliveryGroup, index: ExchangeIndex): DigestMessage[] {
  return clipDigestMessages(allMessages(group, index)).messages
}

function allMessages(group: DeliveryGroup, index: ExchangeIndex): DigestMessage[] {
  return group.messages.map((message) => {
    const delivery = parseDelivery(message.text)
    const exchange = index.get(message) ?? {}
    return {
      from: delivery?.sender?.name ?? 'Another agent',
      text: (delivery?.body ?? message.text).trim(),
      ...(exchange.request && { request: exchange.request.text }),
      ...(exchange.reply && { reply: exchange.reply.text })
    }
  })
}
