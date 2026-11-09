import type { UsageWindow } from '../../../preload/index.d'
import { scopeFamily, type LimitReport } from '../../../shared/limit-report'
import { capOutLabel, formatResetIn } from '../store/usage-store'

/**
 * How a cap that is out is named on the proposal badge, in the first wave's
 * words (PRDCT-4254, `capOutLabel`): "Fable out · back in 2d 5h". The poll's
 * read of the session's own view names the cap when it shows one out; before
 * that read lands, the CLI's report does (PRDCT-4302): the family it named
 * and the return it gave, or the credits, or the bare word.
 */
export function limitOutLabel(
  report: LimitReport | null | undefined,
  stopping: UsageWindow | null,
  now: number = Date.now()
): string {
  if (stopping) return capOutLabel(stopping, { now })
  if (!report) return 'Out'
  const back = report.resetsAt ? formatResetIn(report.resetsAt, now) : null
  const family = scopeFamily(report.scope)
  if (family) return back ? `${family} out · back ${back}` : `${family} out`
  // The credits, the shared caps or an unnamed refusal: the account is out;
  // "out of usage credits" is retired (ADR 0002).
  return back ? `Out · back ${back}` : 'Out'
}
