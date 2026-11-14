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
import {
  claudeConnection,
  codexConnection,
  poolAccountOf,
  type Connection
} from '../../shared/connection'
import type { LaunchProfilePreferences } from '../../shared/agent-launch'
import type { LaunchFacts } from './launch'
import type { ProviderConnectionView } from '@clave/contract/settings/connections'

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
  /** The model a launch naming none will run (`rememberedSpawnModel`). */
  readonly launchModel?: LaunchFacts['launchModel']
  /** The stored provider connections (`providerConnectionsManager`, PRDCT-4496);
   *  absent, an account on Pi or OpenCode finds none. */
  readonly providerConnections?: {
    forHarness(harnessId: string): readonly ProviderConnectionView[]
  }
}

const summaryOf = (read: unknown): ServedPoolAccount['usage'] =>
  read && typeof read === 'object' && 'windows' in read
    ? usageSummaryOf(read as Parameters<typeof usageSummaryOf>[0])
    : undefined

/** A connection as a pool row: the Connection itself (pool, company, kind,
 *  reportsUsage, usage) with the pool rule's view spread over it (usable,
 *  fallback for a key). */
export const asPoolRow = (connection: Connection): Connection & ServedPoolAccount => ({
  ...connection,
  ...poolAccountOf(connection)
})

export function launchFactsFromManagers(m: FactsManagers): LaunchFacts {
  return {
    preferences: () => m.launchProfiles.getPreferences(),
    ...(m.launchModel ? { launchModel: m.launchModel } : {}),
    ...(m.providerConnections
      ? { providerConnectionsFor: (harness) => m.providerConnections!.forHarness(harness) }
      : {}),
    // Each row is a Connection (pool, company, kind, reportsUsage, usage as
    // the pool states them) and the pool rule's view of it (usable, fallback
    // for a key), so the listing's rows carry both shapes unchanged.
    accounts: (provider: AccountProvider): ServedPoolAccount[] =>
      provider === 'codex'
        ? m.codexAccounts.list().map((a) =>
            asPoolRow(
              codexConnection(
                {
                  id: a.id,
                  label: a.label,
                  kind: a.kind === 'apiKey' ? 'apiKey' : 'chatgpt',
                  hasCredential: a.hasCredential
                },
                summaryOf(m.codexUsage.snapshot()[a.id])
              )
            )
          )
        : m.claudeAccounts
            .list()
            .map((a) =>
              asPoolRow(
                claudeConnection(
                  { id: a.id, label: a.label, hasToken: a.hasToken, tokenInvalid: a.tokenInvalid },
                  summaryOf(m.claudeUsage.snapshot()[a.id])
                )
              )
            ),
    selectedAccountId: (provider) => {
      const raw = m.preference?.(
        provider === 'codex' ? 'selectedCodexAccountId' : 'selectedClaudeProfileId'
      )
      return typeof raw === 'string' && raw ? raw : undefined
    },
    useRecommendedAccount: () => m.preference?.('useRecommendedAccount') === true
  }
}
