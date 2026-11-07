/**
 * The pool's rule for a launch, as the served `clave_open_session` applies
 * it and as a routine run applies it too (ADR 0004: "reuse that resolution,
 * don't fork"): a named account is honoured by id or by label; `any` or
 * nothing follows the launch setting (the recommendation, or the selected
 * account while it has headroom, else the next one along); an unknown name
 * errors with the names that exist. Over the facts a process can state
 * (`AccountFacts`): the shell's MCP facts object in Electron main, the
 * standalone entry's settings source otherwise.
 */
import type { AccountOverride } from '@clave/contract/sessions'
import { pickAccount, type PoolAccount } from '../../../shared/src/account-pool'
import { usageSummaryForModel } from '../../../shared/src/usage-summary'
import type { AccountProvider, ServedPoolAccount } from './served-core'

export interface AccountFacts {
  /** The accounts of a provider's pool, in the Accounts page's order. */
  accounts(provider: AccountProvider): ServedPoolAccount[]
  /** The account selected in settings for that provider, undefined when none is. */
  selectedAccountId(provider: AccountProvider): string | undefined
  /** Opt in to the menu recommendation for implicit new-session accounts. */
  useRecommendedAccount?(): boolean
}

export const poolOf = (accounts: ServedPoolAccount[]): PoolAccount[] =>
  accounts.map((a) => ({ id: a.id, usable: a.usable, ...(a.fallback ? { fallback: true } : {}) }))

export const usageOf = (
  accounts: ServedPoolAccount[],
  context?: { model?: string }
): Record<string, ServedPoolAccount['usage']> =>
  Object.fromEntries(
    accounts.map((a) => [a.id, context ? usageSummaryForModel(a.usage, context.model) : a.usage])
  )

/** The renderer's `accountForLaunch`: a named account is honoured; with none
 *  named, follow the launch setting: the recommendation, or the selected
 *  one while it has headroom, else the next along. */
export function accountForLaunch(
  facts: AccountFacts,
  provider: AccountProvider
): ServedPoolAccount {
  const accounts = facts.accounts(provider)
  const selected = facts.selectedAccountId(provider) ?? 'default'
  const id = pickAccount({
    accounts: poolOf(accounts),
    usage: usageOf(accounts),
    preferredId: selected,
    preferRecommended: facts.useRecommendedAccount?.() === true
  })
  return accounts.find((a) => a.id === id) ?? accounts[0] ?? { id, label: id, usable: true }
}

/** The renderer's `resolveAccountRef`: an id, a label, or "any" for the
 *  pool's pick; an unknown name errors with the names that exist. */
export function resolveAccountRef(
  facts: AccountFacts,
  provider: AccountProvider,
  ref: string | undefined
): ServedPoolAccount {
  if (!ref || ref === 'any') return accountForLaunch(facts, provider)
  const accounts = facts.accounts(provider)
  const byId = accounts.find((a) => a.id === ref)
  if (byId) return byId
  const exact = accounts.filter((a) => a.label === ref)
  if (exact.length === 1) return exact[0]
  const loose = accounts.filter((a) => a.label.toLowerCase() === ref.toLowerCase())
  if (loose.length === 1) return loose[0]
  const names = accounts.map((a) => `"${a.label}" (${a.id})`).join(', ')
  throw new Error(
    `Unknown ${provider === 'codex' ? 'Codex' : 'Claude'} account "${ref}". Available: ${names}`
  )
}

export const spawnFieldsOf = (
  provider: AccountProvider,
  account: { id: string; label: string }
): AccountOverride =>
  provider === 'codex'
    ? { codexAccountId: account.id, codexAccountLabel: account.label }
    : { claudeProfileId: account.id, claudeProfileLabel: account.label }
