/**
 * Settings domain: accounts. The Claude and Codex account lists, the login
 * jobs that sign an account in, and the usage reads of both providers and Pi.
 *
 * Mirrors the preload's account, login and usage methods as of this change
 * (`src/preload/index.ts`). The types in `src/preload/index.d.ts`,
 * `src/main/claude-accounts.ts`, `src/main/codex-accounts.ts` and
 * `src/main/pi-usage.ts` are the originals until the renderer reads this
 * contract instead; then this module becomes the original.
 *
 * NO SCHEMA HERE MAY CARRY A SECRET. A token or an API key travels in one
 * direction only, client to server, and only in two payloads:
 * `SetClaudeAccountToken` (the token) and `StartCodexApiKeyLogin` (the key).
 * No event, no query result and no other command success carries either:
 * an account says `hasToken` / `hasCredential`, a login job says its status.
 */
import { Command, Query } from '@structure-ai/cqrs'
import { Schema } from 'effect'
import { RefusedOrUnavailable, SettingsRefused } from './failures'

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export const AccountProvider = Schema.Literal('claude', 'codex')

export const UsageWindowView = Schema.Struct({
  key: Schema.String,
  label: Schema.String,
  /** 'session' | 'weekly_all' | 'weekly_scoped' | whatever the service adds. */
  kind: Schema.String,
  /** What a scoped cap is scoped to ('Fable', 'Opus'), else null. */
  scope: Schema.NullOr(Schema.String),
  usedPercentage: Schema.Number,
  resetsAt: Schema.NullOr(Schema.Number),
  severity: Schema.NullOr(Schema.Literal('normal', 'warning', 'critical'))
})

export const UsageLimitsView = Schema.Struct({
  windows: Schema.Array(UsageWindowView),
  fetchedAt: Schema.Number,
  message: Schema.optional(Schema.String)
})

export const UsageErrorView = Schema.Struct({
  error: Schema.String,
  /** The service refused the credential itself. */
  reason: Schema.optional(Schema.Literal('unauthorized'))
})

export const UsageReadView = Schema.Union(UsageLimitsView, UsageErrorView)

/** Every account's last read, by account id. */
export const UsageSnapshotView = Schema.Record({ key: Schema.String, value: UsageReadView })

/** A usage read's parameters, flat so a GET can carry them: the account
 *  (the machine login when omitted) and whether to read live whatever the
 *  cache says (the Refresh button, a token just pasted). */
export const UsageReadParams = Schema.Struct({
  accountId: Schema.optional(Schema.String),
  force: Schema.optional(Schema.BooleanFromString)
})

/** A Claude account as the client sees it: never the token itself. */
export const ClaudeAccountView = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  hasToken: Schema.Boolean,
  /** When the token was captured, or null without one. */
  tokenSetAt: Schema.NullOr(Schema.Number),
  /** When the token is assumed to stop working (a year), or null. */
  tokenExpiresAt: Schema.NullOr(Schema.Number),
  /** The service refused the token on its last read. */
  tokenInvalid: Schema.Boolean
})

export const CodexAccountKind = Schema.Literal('chatgpt', 'apiKey')

/** A Codex account as the client sees it (ADR 0002): never the credential. */
export const CodexAccountView = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  kind: CodexAccountKind,
  hasCredential: Schema.Boolean
})

/** A login in flight, or just finished: never the credential it captured. */
export const AccountLoginJobView = Schema.Struct({
  id: Schema.String,
  provider: AccountProvider,
  accountId: Schema.String,
  status: Schema.Literal('running', 'done', 'failed', 'cancelled'),
  url: Schema.NullOr(Schema.String),
  awaitingCode: Schema.Boolean,
  message: Schema.NullOr(Schema.String),
  startedAt: Schema.Number
})

export const PiUsageRange = Schema.Literal('today', '7d', '30d', 'all')

export const PiUsageTotalsView = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheRead: Schema.Number,
  cacheWrite: Schema.Number,
  totalTokens: Schema.Number,
  cost: Schema.Number,
  sessions: Schema.Number,
  range: PiUsageRange
})

const AccountLabelUpdates = Schema.Struct({ label: Schema.optional(Schema.String) })

// ---------------------------------------------------------------------------
// Claude accounts
// ---------------------------------------------------------------------------

/** `claude-accounts:list` */
export const ListClaudeAccounts = Query.define('ListClaudeAccounts', {
  payload: Schema.Struct({}),
  success: Schema.Array(ClaudeAccountView)
})

/** `claude-accounts:migrated` — accounts whose config-dir shape was dropped at boot. */
export const ListMigratedClaudeAccounts = Query.define('ListMigratedClaudeAccounts', {
  payload: Schema.Struct({}),
  success: Schema.Array(Schema.String)
})

/** `claude-accounts:add` */
export const AddClaudeAccount = Command.define('AddClaudeAccount', {
  payload: Schema.Struct({ label: Schema.String }),
  success: ClaudeAccountView,
  failure: SettingsRefused
})

/** `claude-accounts:update` */
export const RenameClaudeAccount = Command.define('RenameClaudeAccount', {
  payload: Schema.Struct({ id: Schema.String, updates: AccountLabelUpdates }),
  success: Schema.UndefinedOr(ClaudeAccountView),
  failure: SettingsRefused
})

/** `claude-accounts:reorder` */
export const ReorderClaudeAccounts = Command.define('ReorderClaudeAccounts', {
  payload: Schema.Struct({ ids: Schema.Array(Schema.String) }),
  success: Schema.Void,
  failure: SettingsRefused
})

/** `claude-accounts:remove` */
export const RemoveClaudeAccount = Command.define('RemoveClaudeAccount', {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Boolean,
  failure: SettingsRefused
})

/**
 * `claude-accounts:set-token` — the one payload a Claude token travels in.
 * Stores it and reads the account's limits with it in one call.
 */
export const SetClaudeAccountToken = Command.define('SetClaudeAccountToken', {
  payload: Schema.Struct({ id: Schema.String, token: Schema.Redacted(Schema.String) }),
  success: UsageReadView,
  failure: SettingsRefused
})

/** `claude-accounts:clear-token` */
export const ClearClaudeAccountToken = Command.define('ClearClaudeAccountToken', {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Void,
  failure: SettingsRefused
})

// ---------------------------------------------------------------------------
// Codex accounts
// ---------------------------------------------------------------------------

/** `codex-accounts:list` */
export const ListCodexAccounts = Query.define('ListCodexAccounts', {
  payload: Schema.Struct({}),
  success: Schema.Array(CodexAccountView)
})

/** `codex-accounts:add` */
export const AddCodexAccount = Command.define('AddCodexAccount', {
  payload: Schema.Struct({ label: Schema.String, kind: Schema.optional(CodexAccountKind) }),
  success: CodexAccountView,
  failure: SettingsRefused
})

/** `codex-accounts:update` */
export const RenameCodexAccount = Command.define('RenameCodexAccount', {
  payload: Schema.Struct({ id: Schema.String, updates: AccountLabelUpdates }),
  success: Schema.UndefinedOr(CodexAccountView),
  failure: SettingsRefused
})

/** `codex-accounts:reorder` */
export const ReorderCodexAccounts = Command.define('ReorderCodexAccounts', {
  payload: Schema.Struct({ ids: Schema.Array(Schema.String) }),
  success: Schema.Void,
  failure: SettingsRefused
})

/** `codex-accounts:remove` */
export const RemoveCodexAccount = Command.define('RemoveCodexAccount', {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Boolean,
  failure: SettingsRefused
})

/** `codex-accounts:clear-credential` */
export const ClearCodexAccountCredential = Command.define('ClearCodexAccountCredential', {
  payload: Schema.Struct({ id: Schema.String }),
  success: Schema.Void,
  failure: SettingsRefused
})

// ---------------------------------------------------------------------------
// Login jobs
// ---------------------------------------------------------------------------

/** `accounts:login-start` — runs the provider's own login command in a PTY
 *  the server owns; a server without one answers `CapabilityUnavailable`. */
export const StartAccountLogin = Command.define('StartAccountLogin', {
  payload: Schema.Struct({ provider: AccountProvider, accountId: Schema.String }),
  success: AccountLoginJobView,
  failure: RefusedOrUnavailable
})

/** `accounts:login-api-key` — the one payload a Codex API key travels in. */
export const StartCodexApiKeyLogin = Command.define('StartCodexApiKeyLogin', {
  payload: Schema.Struct({ accountId: Schema.String, apiKey: Schema.Redacted(Schema.String) }),
  success: AccountLoginJobView,
  failure: RefusedOrUnavailable
})

/** `accounts:login-input` — what the user types into the login (the code it
 *  asks for); a server with no login running answers `CapabilityUnavailable`. */
export const SendAccountLoginInput = Command.define('SendAccountLoginInput', {
  payload: Schema.Struct({ jobId: Schema.String, text: Schema.String }),
  success: Schema.Void,
  failure: RefusedOrUnavailable
})

/** `accounts:login-cancel` — likewise. */
export const CancelAccountLogin = Command.define('CancelAccountLogin', {
  payload: Schema.Struct({ jobId: Schema.String }),
  success: Schema.Void,
  failure: RefusedOrUnavailable
})

/** `accounts:login-list` */
export const ListAccountLogins = Query.define('ListAccountLogins', {
  payload: Schema.Struct({}),
  success: Schema.Array(AccountLoginJobView)
})

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/** `usage:get-limits` — one Claude account's windows (the machine login when omitted). */
export const ReadClaudeUsage = Query.define('ReadClaudeUsage', {
  payload: UsageReadParams,
  success: UsageReadView
})

/** `usage:claude-snapshot` */
export const ReadClaudeUsageSnapshot = Query.define('ReadClaudeUsageSnapshot', {
  payload: Schema.Struct({}),
  success: UsageSnapshotView
})

/** `usage:get-codex-limits` — one Codex account's windows (the machine home when omitted). */
export const ReadCodexUsage = Query.define('ReadCodexUsage', {
  payload: UsageReadParams,
  success: UsageReadView
})

/** `usage:codex-snapshot` */
export const ReadCodexUsageSnapshot = Query.define('ReadCodexUsageSnapshot', {
  payload: Schema.Struct({}),
  success: UsageSnapshotView
})

/** `usage:get-pi` */
export const ReadPiUsage = Query.define('ReadPiUsage', {
  payload: Schema.Struct({ range: PiUsageRange }),
  success: PiUsageTotalsView
})

// ---------------------------------------------------------------------------
// Events: members of the server's one event union (`../events.ts`), carried
// to every attached client in its envelope over the push channel.
// ---------------------------------------------------------------------------

/** `claude-accounts:changed`: the whole list, never a token. */
export const ClaudeAccountsChanged = Schema.TaggedStruct('accounts.claude_changed', {
  accounts: Schema.Array(ClaudeAccountView)
})

/** `codex-accounts:changed`: the whole list, never a credential. */
export const CodexAccountsChanged = Schema.TaggedStruct('accounts.codex_changed', {
  accounts: Schema.Array(CodexAccountView)
})

/** `accounts:login-progress`: a job's status, link and reason, never what it captured. */
export const AccountLoginProgressed = Schema.TaggedStruct('accounts.login_progressed', {
  job: AccountLoginJobView
})

/** `usage:claude-account`: one account's read, polled or asked for. */
export const ClaudeUsageRead = Schema.TaggedStruct('usage.claude_read', {
  accountId: Schema.String,
  result: UsageReadView
})

/** `usage:codex-account` */
export const CodexUsageRead = Schema.TaggedStruct('usage.codex_read', {
  accountId: Schema.String,
  result: UsageReadView
})
