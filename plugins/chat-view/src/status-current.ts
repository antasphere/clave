import { createContext } from 'react'
import { hasContent, type Entry } from './reducer'

/* Which status card is current (PRDCT-5166), in a module of its own so the
   component file exports components alone. A status the person answered is
   history: drawn quieter, still whole. Only the conversation's last answer
   can be current, and only while no message of the person follows it. */

/** The answer whose card is current: the conversation's last answer with
 *  anything to draw, when it carries a card and the person has not written
 *  since; null otherwise. Read from the end, so it stops at the last answer
 *  and costs nothing on a long conversation. */
export function currentCard(entries: readonly Entry[]): Entry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]
    if (entry.kind === 'user' && !entry.withdrawn) return null
    if (entry.kind === 'assistant' && hasContent(entry)) return entry.card ? entry : null
  }
  return null
}

/** The current card's answer, as a view tells its rows; `undefined` where no
 *  view says (a sub-agent's window), and every card there reads as current. */
export const CurrentCardContext = createContext<Entry | null | undefined>(undefined)
