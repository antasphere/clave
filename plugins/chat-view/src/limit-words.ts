import type { Session } from '../../../src/renderer/src/store/session-types'
import { sessionAccountUsage } from '../../../src/renderer/src/lib/switch-account'
import {
  capName,
  capStatus,
  formatResetIn,
  useClaudeAccountsUsage,
  useCodexAccountsUsage
} from '../../../src/renderer/src/store/usage-store'

/**
 * The sentence the ended notice opens with when the account's limit ended
 * the conversation (ADR 0002, PRDCT-4254): the account, the cap that is out
 * and when it comes back, in the one vocabulary every readout uses:
 * "Work is out on Fable, back in 2d 5h." The cap comes from the poll's read
 * of the session's own view of its account; the CLI's report reaches the
 * window as a bare flag, so a report the read does not show yet says only
 * that the account is out, as its agent reported. Subscribed to the usage
 * mirror, so a read that lands while the notice is up names the cap.
 */
export function useLimitSentence(host: Session | undefined): string {
  const account = host?.claudeProfileLabel ?? host?.codexAccountLabel ?? 'This account'
  const accountId = host?.claudeProfileId ?? host?.codexAccountId ?? 'default'
  useClaudeAccountsUsage((s) => s.byAccount[accountId])
  useCodexAccountsUsage((s) => s.byAccount[accountId])
  const stopping = host ? (capStatus(sessionAccountUsage(host))?.stopping ?? null) : null
  if (!stopping) return `${account} is out, as its agent reported.`
  const back = formatResetIn(stopping.resetsAt)
  return `${account} is out on ${capName(stopping)}${back ? `, back ${back}` : ''}.`
}
