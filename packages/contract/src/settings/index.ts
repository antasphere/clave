/**
 * The settings domains of the wire contract: accounts (Claude and Codex, the
 * login jobs, the usage reads), launch profiles, preferences and workspaces.
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

export * from './accounts'
export * from './antasphere'
export * from './failures'
export * from './launch-profiles'
export * from './preferences'
export * from './workspaces'
export { settingsGroup } from './api'

/** Every event the settings domains push, as members for `ServerEvent`. */
export const SettingsEvent = Schema.Union(
  ClaudeAccountsChanged,
  CodexAccountsChanged,
  AccountLoginProgressed,
  ClaudeUsageRead,
  CodexUsageRead,
  WorkspaceStateChanged,
  AntasphereAccountChanged
)
export type SettingsEvent = typeof SettingsEvent.Type
