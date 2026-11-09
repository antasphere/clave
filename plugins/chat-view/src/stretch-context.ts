import { createContext } from 'react'
import type { DigestLaunch } from '../../../src/shared/exchange-digest'

/* What the cards of the agent's working notes share in a view
   (`WorkStretch.tsx`, PRDCT-4212), in a module of its own so the component
   file exports components alone. */

/** What every card of a view shares: whose tab it is, which cards get a
 *  digest read (the conversation's latest, `recentStretches`), and how the
 *  session runs its agent. */
export interface Stretches {
  sessionId: string
  recent: ReadonlySet<string>
  launch: DigestLaunch
}
export const StretchContext = createContext<Stretches>({
  sessionId: '',
  recent: new Set(),
  launch: {}
})

/** How many of a conversation's latest stretches are titled without asking. */
export const RECENT_STRETCHES = 4

/** The keys of the latest RECENT_STRETCHES stretches among a view's rows. */
export function recentStretches(
  rows: readonly { key: string; block: { kind: string } }[]
): Set<string> {
  const keys = rows.filter((row) => row.block.kind === 'work-stretch').map((row) => row.key)
  return new Set(keys.slice(-RECENT_STRETCHES))
}
