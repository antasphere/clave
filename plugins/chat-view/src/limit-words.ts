import type { Session } from '../../../src/renderer/src/store/session-types'
import {
  accountProviderOf,
  sessionAccountUsage
} from '../../../src/renderer/src/lib/switch-account'
import { useSessionAccountView } from '../../../src/renderer/src/lib/session-accounts'
import { capStatus } from '../../../src/renderer/src/store/usage-store'
import { limitSentence } from './limit-sentence'

/**
 * The sentence the ended notice opens with when the account's limit ended
 * the conversation (ADR 0002, PRDCT-4254): the account, the cap that is out
 * and when it comes back, in the one vocabulary every readout uses:
 * "Work is out on Fable, back in 2d 5h." The cap comes from the poll's read
 * of the session's own view of its account, else from the CLI's own report
 * (PRDCT-4302: the family and the return it named, or the credits); a report
 * that said no more reads as the account out, as its agent reported.
 * Subscribed to the usage mirror, so a read that lands while the notice is
 * up names the cap.
 */
export function useLimitSentence(host: Session | undefined): string {
  const account = host?.claudeProfileLabel ?? host?.codexAccountLabel ?? 'This account'
  // Subscribed to the tab's OWNER's usage: a server tab's reads are the
  // server's (PRDCT-4328).
  useSessionAccountView(host, host ? accountProviderOf(host) : null)
  const stopping = host ? (capStatus(sessionAccountUsage(host))?.stopping ?? null) : null
  return limitSentence(account, stopping, host?.limitReported ?? null)
}
