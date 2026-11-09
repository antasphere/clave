import type { UsageWindow } from '../../../src/preload/index.d'
import { scopeFamily, type LimitReport } from '../../../src/shared/limit-report'
import { capName, formatResetIn } from '../../../src/renderer/src/store/usage-store'

/** The ended notice's first sentence, pure (PRDCT-4254, PRDCT-4302): "Work is
 *  out on Fable, back in 2d 5h." when the cap that stopped the conversation
 *  is known from the poll's read; from the CLI's own report before the read
 *  lands, when it named a family ("Work is out on Fable, back in 2d 5h.");
 *  "Work is out, as its agent reported." otherwise, the credits included:
 *  the words "out of usage credits" are retired (ADR 0002). */
export function limitSentence(
  account: string,
  stopping: UsageWindow | null,
  report: LimitReport | null = null,
  now: number = Date.now()
): string {
  if (stopping) {
    const back = formatResetIn(stopping.resetsAt, now)
    return `${account} is out on ${capName(stopping)}${back ? `, back ${back}` : ''}.`
  }
  const family = report ? scopeFamily(report.scope) : null
  if (family) {
    const back = report?.resetsAt ? formatResetIn(report.resetsAt, now) : null
    return `${account} is out on ${family}${back ? `, back ${back}` : ''}.`
  }
  return `${account} is out, as its agent reported.`
}
