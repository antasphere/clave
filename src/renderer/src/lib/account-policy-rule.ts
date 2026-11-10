import type { AccountSwitchMode, FamilyLimitRule } from '../store/account-policy-store'

/**
 * The rule of the switching policy (ADR 0002, amended by PRDCT-4302), pure:
 * what a tab does when its account is at its limit, and WHICH way on it
 * takes. Kept apart from the watcher in `account-policy.ts` so the test
 * reaches it without a window.
 *
 * Three rungs, in order. A FAMILY's cap (the Fable week spent while the
 * account's shared caps are open) offers the model rung first: the newest
 * model of the next family down on the same account, set on the live
 * session without a restart. A SHARED cap or the org's CREDITS offer the
 * account rung: the tab moves to another account. The PROVIDER rung
 * (continue on another agent CLI) comes last, only when the host exposes
 * that road, and is only ever offered: it reconstructs the conversation.
 */
export type ResolvedScope = 'shared' | 'credits' | { family: string }

export type Rung =
  | { kind: 'model'; model: string }
  | { kind: 'account'; accountId: string }
  | { kind: 'provider'; adapterId: string }

export type AccountAction =
  | { kind: 'none' }
  /** The rungs to offer, in order; the first is what automatic mode would take. */
  | { kind: 'propose'; rungs: Rung[] }
  | { kind: 'switch-account'; accountId: string }
  | { kind: 'switch-model'; model: string }

export interface DecideInput {
  alive: boolean
  /** Pinned to its account: the account rung is never offered. */
  accountPinned: boolean
  /** Pinned to its model: the model rung is never offered. */
  modelPinned: boolean
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
  /** What automatic mode does on a family's cap. */
  onFamilyLimit: FamilyLimitRule
  /** Which cap stopped the tab, resolved (`limit-scope.ts`). */
  scope: ResolvedScope
  /** The model rung's target: the newest model of the next family down whose
   *  cap is open on this account, or null when none is. */
  nextModel: string | null
  /** The pool's next account, or null when nowhere has headroom. */
  nextAccountId: string | null
  /** The provider rung's target, when the host exposes the road. */
  nextAdapterId: string | null
  /** What is already proposed, and what the user dismissed, by ladder key. */
  proposedKey: string | null
  dismissedKey: string | null
}

export function rungKey(rung: Rung): string {
  switch (rung.kind) {
    case 'model':
      return `model:${rung.model}`
    case 'account':
      return `account:${rung.accountId}`
    case 'provider':
      return `provider:${rung.adapterId}`
  }
}

export function ladderKey(rungs: ReadonlyArray<Rung>): string {
  return rungs.map(rungKey).join('|')
}

/** The rungs a tab at its limit is offered, in order, from what is open. */
export function ladderOf(input: DecideInput): Rung[] {
  const rungs: Rung[] = []
  const family = typeof input.scope === 'object'
  // The model rung: a family's cap, on a live tab (a dead process takes no
  // set_model), not pinned to its model.
  if (family && input.alive && !input.modelPinned && input.nextModel) {
    rungs.push({ kind: 'model', model: input.nextModel })
  }
  if (!input.accountPinned && input.nextAccountId) {
    rungs.push({ kind: 'account', accountId: input.nextAccountId })
  }
  if (input.nextAdapterId) rungs.push({ kind: 'provider', adapterId: input.nextAdapterId })
  return rungs
}

export function decideAccountAction(input: DecideInput): AccountAction {
  if (!input.alive && !input.reported) return { kind: 'none' }
  if (input.restarting || !input.atLimit) return { kind: 'none' }
  const rungs = ladderOf(input)
  if (rungs.length === 0) return { kind: 'none' }
  if (input.mode === 'automatic' && !input.working) {
    const model = rungs.find((r) => r.kind === 'model')
    const account = rungs.find((r) => r.kind === 'account')
    // On a family's cap the setting decides which rung is taken; a tab that
    // cannot take the preferred one takes the other. The provider rung is
    // never taken on its own: it reconstructs the conversation.
    const preferModel = input.onFamilyLimit === 'switch-model'
    if (preferModel && model?.kind === 'model') return { kind: 'switch-model', model: model.model }
    if (account?.kind === 'account') return { kind: 'switch-account', accountId: account.accountId }
    if (model?.kind === 'model') return { kind: 'switch-model', model: model.model }
  }
  // Proposing: once per ladder, and not again after a dismissal of it.
  const key = ladderKey(rungs)
  if (input.proposedKey === key) return { kind: 'none' }
  if (input.dismissedKey === key) return { kind: 'none' }
  return { kind: 'propose', rungs }
}
