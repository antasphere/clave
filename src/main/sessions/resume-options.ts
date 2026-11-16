/**
 * What a stopped session's Resume relaunches with (PRDCT-4191, PRDCT-4236):
 * the allowlist a Clave server's own Resume uses, and the one the in-process
 * host uses for a tab it never spawned but keeps the record of. Pure, with
 * type-only imports: the in-process host's lifecycle reaches it at boot, and
 * main's boot must reach no Effect module (`server/lazy-load.test.ts`).
 */
import type { SessionRecord, SpawnOptions } from '@clave/contract/sessions'
import { conversationIdOf, runtimeChoices } from '../../shared/runtime-choices'

/** An allowlist deliberately excludes initial commands, prompts and tmux adoption. */
export function resumeOptions(record: SessionRecord): SpawnOptions {
  // The mode, the model and the effort the chat was RUNNING on, not the ones
  // it was launched with (PRDCT-4191): "Lane · Company AI keys" came back in
  // Manual on opus after running with permissions skipped on another model.
  const runtime = runtimeChoices(record)
  return {
    adoptSessionId: record.id,
    // A Pi session resumes through `--session <id>` (the launch's
    // `resumeSessionId`); `piSessionId` alone would start a fresh one under
    // that id (round 2, N-F3).
    resumeSessionId: conversationIdOf(record),
    claudeSessionId: record.claudeSessionId,
    piSessionId: record.piSessionId,
    claudeMode: record.claudeMode,
    codexMode: record.codexMode,
    antigravityMode: record.antigravityMode,
    piMode: record.piMode,
    opencodeMode: record.opencodeMode,
    claudeAgentsMode: record.claudeAgentsMode,
    dangerousMode: runtime.dangerousMode,
    model: runtime.model,
    ...(runtime.permissionMode !== undefined ? { permissionMode: runtime.permissionMode } : {}),
    ...(runtime.allowDangerous ? { allowDangerous: true } : {}),
    ...(runtime.effort !== undefined ? { effort: runtime.effort } : {}),
    launchProfileId: record.launchProfileId,
    launchProfile: record.launchProfile,
    piProvider: record.piProvider,
    piThinking: record.piThinking,
    configDir: record.configDir,
    claudeProfileId: record.claudeProfileId,
    claudeProfileLabel: record.claudeProfileLabel,
    codexAccountId: record.codexAccountId,
    codexAccountLabel: record.codexAccountLabel,
    workspaceId: record.workspaceId,
    link: record.link,
    spawnedBy: record.spawnedBy,
    openedBy: record.openedBy,
    // Lane C of the harness wave (PRDCT-4496): the stored connection a Pi or OpenCode tab runs on; never its value.
    connectionId: record.connectionId,
    connectionLabel: record.connectionLabel
  }
}
