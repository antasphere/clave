import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import type { ClaudeAccount, CodexAccount } from '../../../preload/index.d'
import { ownerOf } from './fleet-identity'
import {
  useClaudeProfileStore,
  DEFAULT_CLAUDE_PROFILE_ID,
  describeClaudeProfileAuth,
  claudeProfileUsable,
  resolveClaudeProfile
} from '../store/claude-profile-store'
import {
  useCodexAccountStore,
  DEFAULT_CODEX_ACCOUNT_ID,
  describeCodexAccountAuth,
  codexAccountUsable,
  resolveCodexAccount
} from '../store/codex-account-store'
import {
  useClaudeAccountsUsage,
  useCodexAccountsUsage,
  type AccountUsageSummary
} from '../store/usage-store'
import { useServerSettingsStore, type ServerSettings } from '../store/server-settings-state'
import type { PoolAccount } from './account-pool'

/**
 * The accounts OF A SESSION (PRDCT-4328): a tab runs on this Mac or on
 * another Clave server, and its account id is an id of its OWNER's list.
 * Account ids are random per machine, so a server tab's id never exists in
 * this Mac's stores; resolving it there read "removed account" over a usage
 * that never loaded. Every reader of a session's account, its usage and the
 * pool it may move in goes through this module: this Mac's stores for a
 * local tab, that server's settings entry (`server-settings-store.ts`) for a
 * server tab. `session-accounts-guard.test.ts` keeps the readers here.
 */

export type AccountProvider = 'claude' | 'codex'
export type OwnedAccount = ClaudeAccount | CodexAccount

/** The account list and the usage of one owner, for one provider. */
export interface AccountOwnerView {
  /** `LOCAL_SERVER_ID`, or the id of the server the tab runs on. */
  owner: string
  remote: boolean
  provider: AccountProvider
  /** False while a server's list has not been read yet: an id missing from
   *  the list then says nothing about the account. */
  known: boolean
  accounts: OwnedAccount[]
  usage: Record<string, AccountUsageSummary | undefined>
}

/** Everything the views are made of, as one snapshot: what the hooks
 *  subscribe to and what the pure readers take. */
export interface AccountSources {
  claude: ClaudeAccount[]
  codex: CodexAccount[]
  claudeUsage: Record<string, AccountUsageSummary | undefined>
  codexUsage: Record<string, AccountUsageSummary | undefined>
  servers: Record<string, ServerSettings>
}

/** A server's account list of a provider is known once a load answered it or
 *  the server pushed it; the launch profiles say nothing of it. */
export function serverListKnown(
  entry: ServerSettings | undefined,
  provider: AccountProvider
): boolean {
  return entry?.listed?.[provider] === true
}

/** The pure core: one owner's accounts and usage out of the sources. */
export function ownerViewFrom(
  sources: AccountSources,
  owner: string,
  provider: AccountProvider
): AccountOwnerView {
  if (owner === LOCAL_SERVER_ID) {
    return {
      owner,
      remote: false,
      provider,
      known: true,
      accounts: provider === 'codex' ? sources.codex : sources.claude,
      usage: provider === 'codex' ? sources.codexUsage : sources.claudeUsage
    }
  }
  const entry = sources.servers[owner]
  return {
    owner,
    remote: true,
    provider,
    known: serverListKnown(entry, provider),
    accounts: entry ? (provider === 'codex' ? entry.codex : entry.claude) : [],
    usage: entry ? entry.usage[provider] : {}
  }
}

/** The sources as the stores hold them now. */
export function currentAccountSources(): AccountSources {
  return {
    claude: useClaudeProfileStore.getState().profiles,
    codex: useCodexAccountStore.getState().accounts,
    claudeUsage: useClaudeAccountsUsage.getState().byAccount,
    codexUsage: useCodexAccountsUsage.getState().byAccount,
    servers: useServerSettingsStore.getState().byServer
  }
}

/** The owner of a session, by its key: this Mac or a server. */
export function sessionOwner(session: { id: string }): string {
  return ownerOf(session.id)
}

/** One owner's view now (outside React). */
export function ownerAccountView(owner: string, provider: AccountProvider): AccountOwnerView {
  return ownerViewFrom(currentAccountSources(), owner, provider)
}

/** A session's owner's view now (outside React). */
export function sessionAccountView(
  session: { id: string },
  provider: AccountProvider
): AccountOwnerView {
  return ownerAccountView(sessionOwner(session), provider)
}

type SessionAccountFields = {
  id: string
  claudeProfileId?: string
  claudeProfileLabel?: string
  codexAccountId?: string
  codexAccountLabel?: string
}

/** The id of the account a session runs on, in its owner's list. */
export function sessionAccountIdOf(
  session: SessionAccountFields,
  provider: AccountProvider
): string {
  return provider === 'codex'
    ? (session.codexAccountId ?? DEFAULT_CODEX_ACCOUNT_ID)
    : (session.claudeProfileId ?? DEFAULT_CLAUDE_PROFILE_ID)
}

/** What a session says about its own account. */
export interface SessionOwnAccount {
  id: string
  label: string
  /** The account is gone from its owner's list (the process keeps running
   *  on it; the readouts must not say Default). */
  removed: boolean
  /** The owner's list is not read yet: the label is the one the session was
   *  started with, and nothing is known of its sign-in. */
  pending: boolean
  /** How the account signs in ("Token", "Machine login"), null when unknown. */
  auth: string | null
  account: OwnedAccount | null
}

export function describeAccountAuth(provider: AccountProvider, account: OwnedAccount): string {
  return provider === 'codex'
    ? describeCodexAccountAuth(account as CodexAccount)
    : describeClaudeProfileAuth(account as ClaudeAccount)
}

/** The session's account as its owner knows it. */
export function ownAccountFrom(
  view: AccountOwnerView,
  session: SessionAccountFields
): SessionOwnAccount {
  const id = sessionAccountIdOf(session, view.provider)
  const carried = view.provider === 'codex' ? session.codexAccountLabel : session.claudeProfileLabel
  const live = view.accounts.find((a) => a.id === id)
  if (live)
    return {
      id,
      label: live.label,
      removed: false,
      pending: false,
      auth: describeAccountAuth(view.provider, live),
      account: live
    }
  if (!view.known)
    return {
      id,
      label: carried ?? (id === 'default' ? 'Default' : 'Account'),
      removed: false,
      pending: true,
      auth: null,
      account: null
    }
  return {
    id,
    label: carried ?? 'Removed account',
    removed: true,
    pending: false,
    auth: null,
    account: null
  }
}

/** The session's account now (outside React). */
export function sessionOwnAccount(
  session: SessionAccountFields,
  provider: AccountProvider
): SessionOwnAccount {
  return ownAccountFrom(sessionAccountView(session, provider), session)
}

/** The pool's view of an owner's accounts. */
export function poolOf(view: AccountOwnerView): PoolAccount[] {
  return view.accounts.map((a) =>
    view.provider === 'codex'
      ? {
          id: a.id,
          usable: codexAccountUsable(a as CodexAccount),
          fallback: (a as CodexAccount).kind === 'apiKey'
        }
      : { id: a.id, usable: claudeProfileUsable(a as ClaudeAccount) }
  )
}

/** An account of an owner's list by id, label exact, then label loose. */
export function resolveOwnedAccount(view: AccountOwnerView, ref: string): OwnedAccount | undefined {
  return view.provider === 'codex'
    ? resolveCodexAccount(view.accounts as CodexAccount[], ref)
    : resolveClaudeProfile(view.accounts as ClaudeAccount[], ref)
}

/** A usage read older than this is read again when a popover opens on it. */
export const SERVER_USAGE_STALE_MS = 5 * 60_000

/**
 * Make sure a session's owner can answer: for a server tab, its settings
 * read when this Mac has none (or the last read failed), and the session's
 * account's usage read again when it is missing or stale. Nothing for a
 * local tab: main polls every account of this Mac. Safe to call on every
 * popover open; the loads of one server are shared.
 */
export function ensureSessionAccounts(
  session: SessionAccountFields,
  provider: AccountProvider,
  now: number = Date.now()
): void {
  const owner = sessionOwner(session)
  if (owner === LOCAL_SERVER_ID) return
  const entry = useServerSettingsStore.getState().byServer[owner]
  if (!entry || entry.status === 'idle' || entry.status === 'error') {
    void serverReads().then((reads) => reads.loadServerSettings(owner))
    return
  }
  if (entry.status !== 'ready') return
  const id = sessionAccountIdOf(session, provider)
  const summary = entry.usage[provider][id]
  if (summary?.refreshing) return
  const fetchedAt = summary?.fetchedAt ?? null
  if (fetchedAt === null || now - fetchedAt > SERVER_USAGE_STALE_MS)
    void serverReads().then((reads) => reads.readServerUsage(owner, provider, id, false))
}

/** Read a session's account's usage again now, forced, on its owner: the
 *  CLI reported a limit the poll may not have seen yet. */
export function refreshSessionAccountUsage(
  session: SessionAccountFields,
  provider: AccountProvider
): void {
  const owner = sessionOwner(session)
  const id = sessionAccountIdOf(session, provider)
  if (owner !== LOCAL_SERVER_ID) {
    void serverReads().then((reads) => reads.readServerUsage(owner, provider, id, true))
    return
  }
  if (provider === 'codex') void window.electronAPI.getCodexUsageLimits(id, { force: true })
  else void window.electronAPI.getUsageLimits(id, { force: true })
}

/** The server reads, loaded on first use: `server-settings-store.ts` pulls
 *  the fleet store in, which nothing that only reads a session's account
 *  (the agent tools, their tests) should load with it. */
function serverReads(): Promise<typeof import('../store/server-settings-store')> {
  return import('../store/server-settings-store')
}

/** How long a kick of one session's account is held off after the last
 *  (a row re-renders often; a server that failed is not hammered). */
export const ACCOUNT_KICK_GAP_MS = 30_000
const kicks = new Map<string, number>()

/** For the tests: forget every kick. */
export function resetAccountKicks(): void {
  kicks.clear()
}

/**
 * The read a reader of a session's account asks for as it draws: for a tab
 * on a server, its settings when this Mac has none and its account's usage
 * when stale (`ensureSessionAccounts`). Asked from the hooks below, so every
 * chip, menu header and row that draws a server tab's account loads it
 * itself, whatever else did or did not (the launcher reads only the servers
 * it shows). Idempotent and held off per account for `ACCOUNT_KICK_GAP_MS`;
 * run after the render, never inside it.
 */
export function kickSessionAccounts(
  session: SessionAccountFields,
  provider: AccountProvider,
  now: number = Date.now()
): void {
  const owner = sessionOwner(session)
  if (owner === LOCAL_SERVER_ID) return
  const key = `${owner}\u0000${provider}\u0000${sessionAccountIdOf(session, provider)}`
  const last = kicks.get(key)
  if (last !== undefined && now - last < ACCOUNT_KICK_GAP_MS) return
  kicks.set(key, now)
  queueMicrotask(() => ensureSessionAccounts(session, provider))
}

/** A session's owner's view, subscribed, its account loaded as it draws. */
export function useSessionAccounts(
  session: SessionAccountFields,
  provider: AccountProvider
): AccountOwnerView {
  const view = useOwnerAccountView(sessionOwner(session), provider)
  kickSessionAccounts(session, provider)
  return view
}

/** The same, null without a session or a provider (the hooks still run, in
 *  the same order). */
export function useSessionAccountView(
  session: SessionAccountFields | null | undefined,
  provider: AccountProvider | null
): AccountOwnerView | null {
  const view = useOwnerAccountView(session ? sessionOwner(session) : LOCAL_SERVER_ID, provider)
  if (session && provider) kickSessionAccounts(session, provider)
  return session && provider ? view : null
}

/**
 * The one usage summary of a session's account, subscribed to that entry
 * alone (a row's badge): a read of another account, on this Mac or on any
 * server, does not redraw it. Loads the account as it draws, as above.
 */
export function useSessionAccountSummary(
  session: SessionAccountFields,
  provider: AccountProvider | null
): AccountUsageSummary | undefined {
  const owner = sessionOwner(session)
  const id = provider ? sessionAccountIdOf(session, provider) : ''
  const local = owner === LOCAL_SERVER_ID
  const claude = useClaudeAccountsUsage((s) =>
    local && provider === 'claude' ? s.byAccount[id] : undefined
  )
  const codex = useCodexAccountsUsage((s) =>
    local && provider === 'codex' ? s.byAccount[id] : undefined
  )
  const server = useServerSettingsStore((s) =>
    !local && provider ? s.byServer[owner]?.usage[provider][id] : undefined
  )
  if (provider) kickSessionAccounts(session, provider)
  if (!provider) return undefined
  return local ? (provider === 'codex' ? codex : claude) : server
}

/** One owner's view, subscribed. */
export function useOwnerAccountView(
  owner: string,
  provider: AccountProvider | null
): AccountOwnerView {
  const claude = useClaudeProfileStore((s) => s.profiles)
  const codex = useCodexAccountStore((s) => s.accounts)
  const claudeUsage = useClaudeAccountsUsage((s) => s.byAccount)
  const codexUsage = useCodexAccountsUsage((s) => s.byAccount)
  const server = useServerSettingsStore((s) => s.byServer[owner])
  return ownerViewFrom(
    { claude, codex, claudeUsage, codexUsage, servers: server ? { [owner]: server } : {} },
    owner,
    provider ?? 'claude'
  )
}
