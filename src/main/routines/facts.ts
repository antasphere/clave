/**
 * The launch facts a routine run resolves against (ADR 0004), built from
 * the managers of whichever process runs the server: the accounts of both
 * providers with their last usage read (the pool's input), the account
 * selected in settings and the recommendation switch, and the launch
 * profile preferences with the chat forms the host lists. The same facts the
 * MCP shell states for `clave_open_session`, read from the same managers.
 */
import type { ServedPoolAccount } from '../mcp/served-core'
import type { AccountProvider } from '../mcp/served-core'
import { usageSummaryOf } from '../../shared/usage-summary'
import type { LaunchProfilePreferences } from '../../shared/agent-launch'
import type { LaunchFacts } from './launch'

export interface FactsManagers {
  readonly claudeAccounts: {
    list(): ReadonlyArray<{ id: string; label: string; hasToken: boolean; tokenInvalid: boolean }>
  }
  readonly codexAccounts: {
    list(): ReadonlyArray<{ id: string; label: string; hasCredential: boolean; kind: string }>
  }
  readonly claudeUsage: { snapshot(): Record<string, unknown> }
  readonly codexUsage: { snapshot(): Record<string, unknown> }
  readonly launchProfiles: { getPreferences(): LaunchProfilePreferences }
  /** A preference by key; absent in a process with no preference store. */
  readonly preference?: (key: string) => unknown
}

const summaryOf = (read: unknown): ServedPoolAccount['usage'] =>
  read && typeof read === 'object' && 'windows' in read
    ? usageSummaryOf(read as Parameters<typeof usageSummaryOf>[0])
    : undefined

export function launchFactsFromManagers(m: FactsManagers): LaunchFacts {
  return {
    preferences: () => m.launchProfiles.getPreferences(),
    accounts: (provider: AccountProvider): ServedPoolAccount[] =>
      provider === 'codex'
        ? m.codexAccounts.list().map((a) => ({
            id: a.id,
            label: a.label,
            usable: a.hasCredential,
            ...(a.kind === 'apiKey' ? { fallback: true } : {}),
            ...(summaryOf(m.codexUsage.snapshot()[a.id])
              ? { usage: summaryOf(m.codexUsage.snapshot()[a.id]) }
              : {})
          }))
        : m.claudeAccounts.list().map((a) => ({
            id: a.id,
            label: a.label,
            usable: a.id === 'default' || (a.hasToken && !a.tokenInvalid),
            ...(summaryOf(m.claudeUsage.snapshot()[a.id])
              ? { usage: summaryOf(m.claudeUsage.snapshot()[a.id]) }
              : {})
          })),
    selectedAccountId: (provider) => {
      const raw = m.preference?.(
        provider === 'codex' ? 'selectedCodexAccountId' : 'selectedClaudeProfileId'
      )
      return typeof raw === 'string' && raw ? raw : undefined
    },
    useRecommendedAccount: () => m.preference?.('useRecommendedAccount') === true
  }
}
