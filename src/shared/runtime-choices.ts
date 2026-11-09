/**
 * What a chat was RUNNING on when it stopped, read off its record for the
 * spawn that brings it back (PRDCT-4191). The record's `model`, `dangerousMode`
 * and `permissionMode`/`effort` are written at the start and again whenever
 * the provider acknowledges a change (`pty-manager.ts`, the write-back on
 * `session_meta`, `permission_mode` and `effort`); this turns them into the
 * spawn options a Resume or an account switch passes, so the tab comes back
 * in the mode and at the effort the person left it, not the ones it was
 * launched with. One rule for the daemon's Resume (`server-owned-host.ts`),
 * the shell's restart (`pty-manager.ts` `restartSpawn`), the boot restore
 * (`adopt-record.ts` `spawnFromRecord`) and a reopen from the History
 * (PRDCT-4236, the launch the ledger remembers). Pure, shared by main and
 * the renderer.
 */

/** The `--permission-mode` values a spawn may name short of bypass, which is
 *  `dangerousMode` (`@clave/contract/sessions` `SpawnOptions.permissionMode`). */
const SPAWN_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk'])
/** A level as a provider spells it (`src/shared/effort.ts`). */
const EFFORT = /^[a-z][a-z0-9_-]{0,31}$/

export type SpawnPermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'dontAsk'

/** A permission mode a spawn may name, or undefined: bypass is the dangerous
 *  flag, never a mode passed as such. */
export function spawnPermissionMode(value: unknown): SpawnPermissionMode | undefined {
  return typeof value === 'string' && SPAWN_MODES.has(value)
    ? (value as SpawnPermissionMode)
    : undefined
}

/** An effort level as a provider spells it, or undefined. */
export function spawnEffort(value: unknown): string | undefined {
  return typeof value === 'string' && EFFORT.test(value) ? value : undefined
}

export interface RuntimeRecord {
  readonly model?: string | undefined
  readonly dangerousMode?: boolean | undefined
  readonly permissionMode?: string | undefined
  readonly effort?: string | undefined
}

export interface RuntimeChoices {
  model?: string
  dangerousMode: boolean
  permissionMode?: SpawnPermissionMode
  /** Bypass kept reachable to a chat resumed in another mode, because its
   *  launch had it: the CLI accepts the switch back only when told so. */
  allowDangerous?: boolean
  effort?: string
}

/** The spawn options that bring a record's chat back as it was running. A
 *  record with no reported mode keeps its launch flag; a reported bypass is
 *  the dangerous flag; any other reported mode is passed as the mode and
 *  turns the dangerous flag off, since the person left bypass for it. */
export function runtimeChoices(record: RuntimeRecord): RuntimeChoices {
  const mode = record.permissionMode
  const out: RuntimeChoices = { dangerousMode: record.dangerousMode === true }
  if (record.model) out.model = record.model
  if (mode === 'bypassPermissions') out.dangerousMode = true
  else if (mode && SPAWN_MODES.has(mode)) {
    out.dangerousMode = false
    out.permissionMode = mode as RuntimeChoices['permissionMode']
    // The person left bypass for this mode: the way back stays open.
    if (record.dangerousMode === true) out.allowDangerous = true
  }
  if (record.effort && EFFORT.test(record.effort)) out.effort = record.effort
  return out
}
