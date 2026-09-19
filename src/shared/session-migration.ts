import type { ConversationSnapshot } from './agent-session'

export type MigratableProvider = 'claude' | 'codex' | 'pi'

export interface LegacyAgentModes {
  claudeMode?: boolean
  codexMode?: boolean
  piMode?: boolean
  antigravityMode?: boolean
  claudeAgentsMode?: boolean
  link?: unknown
}

/** Plain/hidden terminals and unsupported TUIs must never be guessed into agents. */
export function legacyAgentProvider(record: LegacyAgentModes): MigratableProvider | null {
  if (record.link || record.antigravityMode || record.claudeAgentsMode) return null
  if (record.piMode) return 'pi'
  if (record.codexMode) return 'codex'
  return record.claudeMode === true ? 'claude' : null
}

export interface AttachedSessionView {
  url: string
  title?: string
  command?: string
  cwd?: string
}

export interface LegacyImportState {
  sourceId: string
  recordKey: string
  tmuxName?: string
  complete: boolean
}

export interface LegacyAgentCandidate {
  id: string
  provider: MigratableProvider
  cwd: string
  title: string
  live: boolean
  resumeSessionId?: string
  launchProfileId?: string
  workspaceId?: string
  claudeProfileLabel?: string
  model?: string
  targetId?: string
  complete?: boolean
  warning?: string
}

export interface LegacyMigrationResult {
  legacyId: string
  snapshot: ConversationSnapshot
}

export interface SessionMigrationAPI {
  inspect(legacyId: string): Promise<LegacyAgentCandidate>
  migrate(legacyId: string, launchProfileId?: string): Promise<LegacyMigrationResult | null>
  /** Includes prepared imports, so a crash never duplicates a tab or loses its group. */
  mappings(): Promise<Record<string, string>>
  /** Explicit native confirmation; never called automatically during startup. */
  restartService(): Promise<boolean>
}
