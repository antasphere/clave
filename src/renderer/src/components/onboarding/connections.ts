import { DEFAULT_CLAUDE_PROFILE_ID, useClaudeProfileStore } from '../../store/claude-profile-store'
import { DEFAULT_CODEX_ACCOUNT_ID, useCodexAccountStore } from '../../store/codex-account-store'
import { useClaudeAccountsUsage } from '../../store/usage-store'

/** The account a provider's sessions will run on once connected, or null. */
export interface Connections {
  claude: string | null
  codex: string | null
}

/**
 * Which accounts already work: a Claude account with a token that works, or
 * the Mac's own Claude login when its usage reads; any Codex account with a
 * credential, the Mac's own included.
 */
export function useConnections(): Connections {
  const profiles = useClaudeProfileStore((s) => s.profiles)
  const accounts = useCodexAccountStore((s) => s.accounts)
  const machine = useClaudeAccountsUsage((s) => s.byAccount[DEFAULT_CLAUDE_PROFILE_ID])
  const token = profiles.find(
    (p) => p.id !== DEFAULT_CLAUDE_PROFILE_ID && p.hasToken && !p.tokenInvalid
  )
  const codex =
    accounts.find((a) => a.id === DEFAULT_CODEX_ACCOUNT_ID && a.hasCredential) ??
    accounts.find((a) => a.hasCredential)
  return {
    claude: token?.id ?? (machine?.status === 'ready' ? DEFAULT_CLAUDE_PROFILE_ID : null),
    codex: codex?.id ?? null
  }
}
