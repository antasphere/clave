import type { ConversationOptions, ConversationSnapshot } from '../../shared/agent-session'
import {
  legacyAgentProvider,
  type LegacyAgentCandidate,
  type LegacyImportState,
  type LegacyMigrationResult
} from '../../shared/session-migration'
import type { SessionRecord } from '../pty-manager'
import type { AdapterLaunch } from './adapter'
import type { ConversationClient } from './client'

export type LegacyMigrationRecord = SessionRecord & { recordKey: string; codexSessionId?: string }
export interface LegacyMigrationDependencies {
  read(id: string): LegacyMigrationRecord | undefined
  client(): Promise<
    Pick<
      ConversationClient,
      'legacyImportMappings' | 'snapshot' | 'prepareLegacyImport' | 'completeLegacyImport'
    >
  >
  prepare(
    record: LegacyMigrationRecord,
    profileId?: string
  ): Promise<{ options: ConversationOptions; launch: AdapterLaunch }>
  /** Must verify the exact process stopped before forgetting its record. Also
   * accepts a durable import identity when a crash already removed the record. */
  stopAndForget(identity: LegacyImportState): Promise<void>
  /** Idempotent layout and linked-record remapping. */
  finalize(sourceId: string, targetId: string): Promise<void>
}

export function legacyResumeId(record: LegacyMigrationRecord): string | undefined {
  const provider = legacyAgentProvider(record)
  const id =
    provider === 'claude'
      ? record.claudeSessionId
      : provider === 'pi'
        ? record.piSessionId
        : record.codexSessionId
  // Never infer a native conversation from cwd or terminal contents.
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : undefined
}

/** Inspection is read-only. Only migrate, called after host confirmation, stops work. */
export class LegacyMigrationCoordinator {
  private pending = new Map<string, Promise<LegacyMigrationResult>>()
  constructor(private deps: LegacyMigrationDependencies) {}

  async mappings(): Promise<Record<string, string>> {
    return (await this.deps.client()).legacyImportMappings()
  }

  async inspect(id: string): Promise<LegacyAgentCandidate & { warning?: string }> {
    const client = await this.deps.client()
    const targetId = (await client.legacyImportMappings())[id]
    const imported = targetId ? (await client.snapshot(targetId)).session : undefined
    const record = this.deps.read(id)
    const provider = record ? legacyAgentProvider(record) : imported?.provider
    if (!provider || !['claude', 'codex', 'pi'].includes(provider) || (!record && !imported))
      throw new Error('This session cannot be migrated')
    const resumeSessionId = record ? legacyResumeId(record) : imported?.resumeSessionId
    return {
      id,
      provider: provider as LegacyAgentCandidate['provider'],
      cwd: record?.cwd ?? imported!.cwd,
      title: record?.displayName ?? record?.folderName ?? imported?.title ?? 'Conversation',
      live: !!record?.live,
      resumeSessionId,
      launchProfileId: record?.launchProfileId ?? imported?.launchProfileId,
      workspaceId: record?.workspaceId ?? imported?.workspaceId,
      claudeProfileLabel: record?.claudeProfileLabel,
      model: record?.model ?? imported?.model,
      targetId: imported?.id,
      complete: imported?.legacyImport?.complete,
      warning: resumeSessionId
        ? undefined
        : 'No native resume ID was recorded. This will start a fresh conversation; previous terminal history will not be replayed.'
    }
  }

  migrate(id: string, profileId?: string): Promise<LegacyMigrationResult> {
    const existing = this.pending.get(id)
    if (existing) return existing
    const operation = this.run(id, profileId).finally(() => this.pending.delete(id))
    this.pending.set(id, operation)
    return operation
  }

  private async run(id: string, profileId?: string): Promise<LegacyMigrationResult> {
    const client = await this.deps.client()
    const targetId = (await client.legacyImportMappings())[id]
    const imported = targetId ? (await client.snapshot(targetId)).session : undefined
    let snapshot: ConversationSnapshot
    if (imported) {
      snapshot = await client.snapshot(imported.id)
    } else {
      const record = this.deps.read(id)
      if (!record || !legacyAgentProvider(record))
        throw new Error('This session cannot be migrated')
      // Resolution and validation must succeed before any destructive operation.
      const prepared = await this.deps.prepare(record, profileId)
      snapshot = await client.prepareLegacyImport(
        { ...prepared.options, resumeSessionId: legacyResumeId(record) },
        prepared.launch,
        { sourceId: id, recordKey: record.recordKey, tmuxName: record.tmuxName, complete: false },
        record.view
      )
    }
    if (!snapshot.session.legacyImport?.complete) {
      await this.deps.stopAndForget(snapshot.session.legacyImport!)
      await this.deps.finalize(id, snapshot.session.id)
      snapshot = await client.completeLegacyImport(snapshot.session.id)
    }
    return { legacyId: id, snapshot }
  }
}
