import type { AccountSwitchMode } from '../store/account-policy-store'

/**
 * The rule of the switching policy (ADR 0002), pure: what a tab does when
 * its account is at its limit. Kept apart from the watcher in
 * `account-policy.ts` so the test reaches it without a window.
 */
export type AccountAction =
  | { kind: 'none' }
  | { kind: 'propose'; accountId: string }
  | { kind: 'switch'; accountId: string }

export interface DecideInput {
  alive: boolean
  pinned: boolean
  restarting: boolean
  /** The account is exhausted per the poll, or the CLI reported it. */
  atLimit: boolean
  /** The CLI's own word: its account rejected a turn. The one reason a tab
   *  whose process has ended is brought back — the CLI in `-p` mode ends
   *  right after its "out of credits" reply — where the poll's reading of an
   *  account never revives a tab that died for a reason of its own. */
  reported: boolean
  /** The agent is mid-turn: never moved now. */
  working: boolean
  mode: AccountSwitchMode
  /** The pool's next account, or null when nowhere has headroom. */
  nextAccountId: string | null
  /** What is already proposed, and what the user dismissed. */
  proposedId: string | null
  dismissedId: string | null
}

export function decideAccountAction(input: DecideInput): AccountAction {
  if (!input.alive && !input.reported) return { kind: 'none' }
  if (input.pinned || input.restarting || !input.atLimit) return { kind: 'none' }
  if (!input.nextAccountId) return { kind: 'none' }
  if (input.mode === 'automatic' && !input.working) {
    return { kind: 'switch', accountId: input.nextAccountId }
  }
  // Proposing: once per target, and not again after a dismissal of it.
  if (input.proposedId === input.nextAccountId) return { kind: 'none' }
  if (input.dismissedId === input.nextAccountId) return { kind: 'none' }
  return { kind: 'propose', accountId: input.nextAccountId }
}
