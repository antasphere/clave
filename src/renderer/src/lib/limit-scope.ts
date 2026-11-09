import { CLAUDE_MODELS, type ClaudeModel } from '../../../shared/claude-models'
import { isExhausted, type AccountUsageSummary } from '../../../shared/account-pool'
import { scopeFamily, type LimitReport } from '../../../shared/limit-report'
import type { ResolvedScope } from './account-policy-rule'

/**
 * Which cap stopped a tab, and which model it could continue on (ADR 0002,
 * PRDCT-4302). Pure over the shared summary shapes, so the test reaches it
 * without a window.
 *
 * The CLI's report names a family (`seven_day_opus`), the shared caps
 * (`five_hour`, `seven_day`) or nothing; its enum has no Fable value, so a
 * Fable rejection types itself as a plain week. The policy forces a read of
 * the account after every report (`account-policy.ts`), and the SESSION view
 * of that read settles it: the session's own family cap out while the shared
 * caps are open is that family's cap, whatever the CLI typed; a shared cap
 * out is the account's. The org's credits are the account's whatever the
 * read says.
 */
export function resolveLimitScope(
  report: LimitReport | null | undefined,
  view: AccountUsageSummary | undefined
): ResolvedScope {
  if (report?.scope === 'credits') return 'credits'
  const named = report ? scopeFamily(report.scope) : null
  if (named) return { family: named }
  if (view && isExhausted(view)) {
    const family = view.tightest?.scope?.trim()
    return family ? { family } : 'shared'
  }
  // A report typed shared, or one that said nothing, with no cap out in the
  // read yet: the account rung, as before the report carried a scope.
  return 'shared'
}

/** The families from the scarcest down: the model rung DESCENDS, so a cap
 *  out on Opus never spends the Fable week. The names are the service's
 *  scopes lower-cased, the model table's aliases. */
export const FAMILY_DESCENT: ReadonlyArray<ClaudeModel['alias']> = [
  'fable',
  'opus',
  'sonnet',
  'haiku'
]

/** The newest model of a family: the first the table lists under its alias. */
export function newestModelOf(alias: string): string | null {
  return CLAUDE_MODELS.find((model) => model.alias === alias)?.id ?? null
}

/** The model rung's target when `outFamily`'s cap is out on an account: the
 *  newest model of the next family down whose cap the ACCOUNT's read shows
 *  open (a family the read names no cap for draws on the shared caps alone,
 *  which the caller knows to be open). Null for a family outside the
 *  descent (Codex's Spark, an unknown name) or when every family below is
 *  out too. */
export function modelRungFor(
  outFamily: string,
  account: AccountUsageSummary | undefined
): string | null {
  const at = FAMILY_DESCENT.indexOf(outFamily.toLowerCase() as ClaudeModel['alias'])
  if (at < 0) return null
  for (const alias of FAMILY_DESCENT.slice(at + 1)) {
    const cap = account?.scoped?.find((c) => c.family.toLowerCase() === alias)
    if (cap?.exhausted) continue
    const model = newestModelOf(alias)
    if (model) return model
  }
  return null
}
