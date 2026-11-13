/**
 * One definition of a connection, for every harness (PRDCT-4493). The
 * launcher and Settings say "connection" since 12 November 2026 (PRDCT-4424);
 * under the word the code kept two account lists, one for Claude and one for
 * Codex, and typed their two names apart in five places. This module is the
 * one place that says what a connection and a pool are. The Claude and Codex
 * pools are its first two instances, built from what the two account lists
 * already state; the provider pools of PRDCT-4426 (a key stored once, offered
 * to the open harnesses) are the next, and they change nothing here but the
 * two lists below.
 *
 * Three words, as `harness.ts` has them: a HARNESS is a tool on this machine,
 * a CONNECTION is who pays for what it runs, a MODEL is offered when a
 * connection serves it. A POOL is the list a harness's connections come from
 * (ADR 0002): one company bills it, and the pool's rule (`account-pool.ts`)
 * picks which connection a new session starts on and where a session about
 * to hit its limit moves. The harness table names the pools each harness runs
 * on (`Harness.connectionPools`).
 */
import type { AccountUsageSummary, PoolAccount } from './account-pool'
// ── Lane B (harness wave): provider connections ──
import { PROVIDER_COMPANIES, type ProviderCompanyId } from '@clave/contract/settings'

/** The pools Clave holds connections for, typed once. A provider pool of
 *  PRDCT-4426 adds its id here and its row to `CONNECTION_POOLS`; nothing
 *  else names a pool by a string of its own. */
export type ConnectionPoolId =
  | 'claude'
  | 'codex'
  // ── Lane B (harness wave): provider connections ──
  | ProviderCompanyId

/** The company that bills a pool's connections. */
export interface Company {
  /** As Settings → Connections names its card (`anthropic`, `openai`). */
  id: string
  /** The name a person reads: Anthropic, OpenAI. */
  name: string
}

export interface ConnectionPool {
  id: ConnectionPoolId
  company: Company
  /** Whether the pool has a usage read for its connections at all (the
   *  Claude and Codex caps and when they reset). A connection of such a pool
   *  may still report none of its own (a Codex API key, `Connection.reportsUsage`);
   *  a pool paid per use reads none, every connection of it reports none,
   *  and the pool's rule never calls one exhausted. The builders below read
   *  this flag: a connection reports usage only when its pool reads it. */
  reportsUsage: boolean
}

/** Anthropic's pool: the Claude accounts (the machine's own login, then the
 *  tokens pasted in Settings), every one a subscription reporting its caps. */
export const CLAUDE_POOL: ConnectionPool = {
  id: 'claude',
  company: { id: 'anthropic', name: 'Anthropic' },
  reportsUsage: true
}

/** OpenAI's pool: the Codex accounts, a ChatGPT login reporting its caps or
 *  an API key paid per use. */
export const CODEX_POOL: ConnectionPool = {
  id: 'codex',
  company: { id: 'openai', name: 'OpenAI' },
  reportsUsage: true
}

// ── Lane B (harness wave): provider connections ──
/** The pools of the provider connections (PRDCT-4426): one per card of the
 *  catalogue, the company's id as the pool id, none reporting usage. */
export const PROVIDER_POOLS: readonly ConnectionPool[] = PROVIDER_COMPANIES.map((c) => ({
  id: c.id,
  company: { id: c.id, name: c.name },
  reportsUsage: false
}))

/** Every pool, in the order Settings → Connections lists the companies. */
export const CONNECTION_POOLS: readonly ConnectionPool[] = [
  CLAUDE_POOL,
  CODEX_POOL,
  // ── Lane B (harness wave): provider connections ──
  ...PROVIDER_POOLS
]

export const CONNECTION_POOL_BY_ID: Readonly<Record<ConnectionPoolId, ConnectionPool>> =
  Object.fromEntries(CONNECTION_POOLS.map((pool) => [pool.id, pool])) as Record<
    ConnectionPoolId,
    ConnectionPool
  >

const POOL_IDS = new Set<string>(CONNECTION_POOLS.map((pool) => pool.id))

/** A pool id off the wire or out of a file: exactly one of the registered
 *  pools, never a case-folded or trimmed match. */
export function isConnectionPoolId(value: unknown): value is ConnectionPoolId {
  return typeof value === 'string' && POOL_IDS.has(value)
}

/** The one pool the launcher's rows and Settings → Harnesses list a
 *  harness's connections from today: the first of its pools, or null for a
 *  harness Clave holds no connection for. A harness on several pools (Pi and
 *  OpenCode, once PRDCT-4426 stores a provider's keys) is listed per pool by
 *  the lane that builds the menu's lists (PRDCT-4496); nothing here chooses
 *  among them. */
export function firstPoolOf(harness: {
  connectionPools: readonly ConnectionPoolId[]
}): ConnectionPoolId | null {
  return harness.connectionPools[0] ?? null
}

/** What signs a connection in: a subscription the person logged into (the
 *  CLI's own login, a token captured by it), or a key pasted once. */
export type ConnectionKind = 'subscription' | 'key'

/** The id every pool gives the machine's own login: the account the CLI
 *  itself is signed into, listed first and never removed. The account stores
 *  carry the same value (`DEFAULT_CLAUDE_PROFILE_ID`, `DEFAULT_CODEX_ACCOUNT_ID`). */
export const MACHINE_LOGIN_ID = 'default'

export interface Connection {
  /** The connection's id in its pool's list, `default` for the machine's
   *  own login. Unique within the pool, not across pools: a connection is
   *  always named with its pool. */
  id: string
  /** The name a person gave it, or the one its pool gave it. */
  label: string
  pool: ConnectionPoolId
  /** The id of the company that bills it: its pool's. */
  company: string
  kind: ConnectionKind
  /** Can be started on at all: a token the service has not refused, a home
   *  with a credential. The machine's own login is usable as long as the CLI
   *  is signed in, which the pool cannot see, so it always is here. */
  usable: boolean
  /** Whether this connection reports a quota. A key paid per use reports
   *  none: the pool's rule never calls it exhausted and takes it last. */
  reportsUsage: boolean
  /** Its last usage read as the pool reads it; undefined before a read,
   *  after a failed one (the pool moves nobody on a guess), and for a
   *  connection that reports none. */
  usage: AccountUsageSummary | undefined
}

/** What the pool reads of a Claude account (`ClaudeAccountView`). */
export interface ClaudeAccountFacts {
  id: string
  label: string
  hasToken: boolean
  /** The service refused the token on its last read. */
  tokenInvalid: boolean
}

/** A Claude account as its pool reads it: a subscription signed in, the
 *  machine's own login or a token pasted, every one reporting its caps. A
 *  token account is usable when it has a token the service has not refused. */
export function claudeConnection(
  account: ClaudeAccountFacts,
  usage?: AccountUsageSummary
): Connection {
  return {
    id: account.id,
    label: account.label,
    pool: CLAUDE_POOL.id,
    company: CLAUDE_POOL.company.id,
    kind: 'subscription',
    usable: account.id === MACHINE_LOGIN_ID || (account.hasToken && !account.tokenInvalid),
    reportsUsage: CLAUDE_POOL.reportsUsage,
    usage: CLAUDE_POOL.reportsUsage ? usage : undefined
  }
}

/** What the pool reads of a Codex account (`CodexAccountView`). */
export interface CodexAccountFacts {
  id: string
  label: string
  kind: 'chatgpt' | 'apiKey'
  hasCredential: boolean
}

/** A Codex account as its pool reads it: a ChatGPT login is a subscription
 *  that reports its caps; an API key is a key paid per use, which reports
 *  none, so a read handed in for one is dropped. Either is usable once its
 *  home holds the credential, the machine's own login included. */
export function codexConnection(
  account: CodexAccountFacts,
  usage?: AccountUsageSummary
): Connection {
  const reportsUsage = CODEX_POOL.reportsUsage && account.kind === 'chatgpt'
  return {
    id: account.id,
    label: account.label,
    pool: CODEX_POOL.id,
    company: CODEX_POOL.company.id,
    kind: reportsUsage ? 'subscription' : 'key',
    usable: account.hasCredential,
    reportsUsage,
    usage: reportsUsage ? usage : undefined
  }
}

/** The pool rule's view of a connection (`pickAccount`, `switchTargets` in
 *  `account-pool.ts`): its id and whether it can be started on, and a
 *  connection that reports no quota as the rule's fallback, the last resort
 *  it takes when every subscription is out. */
export function poolAccountOf(connection: Connection): PoolAccount {
  return {
    id: connection.id,
    usable: connection.usable,
    ...(connection.reportsUsage ? {} : { fallback: true })
  }
}

/** The usage map the pool rule takes, by connection id. */
export function usageByConnection(
  connections: readonly Connection[]
): Record<string, AccountUsageSummary | undefined> {
  return Object.fromEntries(connections.map((connection) => [connection.id, connection.usage]))
}
