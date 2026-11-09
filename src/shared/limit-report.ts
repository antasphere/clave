/**
 * What a provider's own limit report says about WHICH cap stopped the turn
 * (ADR 0002, PRDCT-4302). The CLI used to reach the window as a bare yes;
 * the policy then knew one lever, the account. A quota is per account and
 * model family, so the report carries its scope and the policy picks its
 * rung from it: a family's cap offers another model of the same account
 * first, a shared cap or the org's credits offer another account.
 *
 * Shared by main (which parses the frame), the preload (which carries the
 * report on both transports) and the renderer (which resolves `unknown` and
 * `shared` against the forced read of the session's own view, since the
 * CLI's enum has no Fable value and types a Fable rejection as a plain week).
 */
export type LimitScope =
  /** A cap every model of the account draws on: the 5-hour block, the week. */
  | 'shared'
  /** One model family's weekly cap (`Fable`, `Opus`, `Sonnet`), as the service names it. */
  | { family: string }
  /** The org's or the seat's usage credits: the account as a whole. */
  | 'credits'
  /** The CLI said it was refused and nothing more. */
  | 'unknown'

export interface LimitReport {
  scope: LimitScope
  /** When the cap comes back, in milliseconds since the epoch, when the report says. */
  resetsAt?: number
}

/** The family a scope names, or null for a shared, credits or unknown one. */
export function scopeFamily(scope: LimitScope): string | null {
  return typeof scope === 'object' ? scope.family : null
}

/** Whether two scopes say the same thing. */
export function sameScope(a: LimitScope, b: LimitScope): boolean {
  if (typeof a === 'object' || typeof b === 'object') {
    return typeof a === 'object' && typeof b === 'object' && a.family === b.family
  }
  return a === b
}

/** The scope as one word, for a key or a log line: `shared`, `credits`,
 *  `unknown`, `family:Fable`. */
export function scopeKey(scope: LimitScope): string {
  return typeof scope === 'object' ? `family:${scope.family}` : scope
}
