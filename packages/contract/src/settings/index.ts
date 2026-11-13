/**
 * The settings domains of the wire contract: accounts (Claude and Codex, the
 * login jobs, the usage reads), launch profiles, the helpers, the integrations,
 * preferences and workspaces.
 * Lane C's folder; the root exports it as `Settings` once it is on dev, and
 * spreads `SettingsEvent.members` into the server's event union.
 */
import { Schema } from 'effect'
import {
  AccountLoginProgressed,
  ClaudeAccountsChanged,
  ClaudeUsageRead,
  CodexAccountsChanged,
  CodexUsageRead
} from './accounts'
import { WorkspaceStateChanged } from './workspaces'
import { AntasphereAccountChanged } from './antasphere'
// ── Lane B (harness wave): provider connections ──
import { ProviderConnectionsChanged } from './connections'

export * from './accounts'
export * from './antasphere'
export * from './failures'
export * from './helpers'
export * from './integrations'
export * from './launch-profiles'
export * from './preferences'
export * from './workspaces'
// ── Lane B (harness wave): provider connections ──
export * from './connections'
export { settingsGroup } from './api'

/** Every event the settings domains push, as members for `ServerEvent`. */
export const SettingsEvent = Schema.Union(
  ClaudeAccountsChanged,
  CodexAccountsChanged,
  AccountLoginProgressed,
  ClaudeUsageRead,
  CodexUsageRead,
  WorkspaceStateChanged,
  AntasphereAccountChanged,
  // ── Lane B (harness wave): provider connections ──
  ProviderConnectionsChanged
)
export type SettingsEvent = typeof SettingsEvent.Type
