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
export const SPAWN_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk'] as const
const SPAWN_MODES: ReadonlySet<string> = new Set(SPAWN_PERMISSION_MODES)
/** A level as a provider spells it (`src/shared/effort.ts`). */
export const EFFORT_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/
const EFFORT = EFFORT_PATTERN

export type SpawnPermissionMode = (typeof SPAWN_PERMISSION_MODES)[number]

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

/** The launch fields a History row remembers (PRDCT-4236): the ledger's fold
 *  reads them and a closed row leaves them out. */
export const LAUNCH_KEYS = [
  'dangerous',
  'permissionMode',
  'effort',
  'accountId',
  'accountLabel'
] as const

/** The spawn fields of an open that names a mode and an effort (PRDCT-4236),
 *  shared by the served `clave_open_session` and the window's: a mode short
 *  of bypass for a Claude chat only, and only without bypass, which is the
 *  dangerous flag; bypass kept reachable when asked; the effort for Claude and
 *  Codex. Anything malformed is dropped. */
export function launchModeFields(input: {
  claudeMode: boolean
  codexMode: boolean
  dangerousMode: boolean
  permissionMode: unknown
  effort: unknown
  allowDangerous: unknown
}): { permissionMode?: SpawnPermissionMode; allowDangerous?: true; effort?: string } {
  const permissionMode = spawnPermissionMode(input.permissionMode)
  const effort = spawnEffort(input.effort)
  const out: { permissionMode?: SpawnPermissionMode; allowDangerous?: true; effort?: string } = {}
  if (input.claudeMode && !input.dangerousMode && permissionMode) {
    out.permissionMode = permissionMode
    if (input.allowDangerous === true) out.allowDangerous = true
  }
  if ((input.claudeMode || input.codexMode) && effort) out.effort = effort
  return out
}

/** The conversation a record holds, by its provider id, in the order the
 *  spawn resumes it (`resume-options.ts`): a Codex thread, a Claude session,
 *  a Pi session, an OpenCode session (lane D, PRDCT-4427). */
export function conversationIdOf(record: {
  readonly codexThreadId?: string | null | undefined
  readonly claudeSessionId?: string | null | undefined
  readonly piSessionId?: string | null | undefined
  readonly opencodeSessionId?: string | null | undefined
}): string | undefined {
  return (
    record.codexThreadId ??
    record.claudeSessionId ??
    record.piSessionId ??
    record.opencodeSessionId ??
    undefined
  )
}

/** The account a tab runs on: its Codex account for a Codex tab, its Claude
 *  account otherwise; nothing when it names none (the pool's pick). */
export function accountOf(record: {
  readonly codexMode?: boolean | undefined
  readonly codexAccountId?: string | undefined
  readonly codexAccountLabel?: string | undefined
  readonly claudeProfileId?: string | undefined
  readonly claudeProfileLabel?: string | undefined
}): { accountId?: string; accountLabel?: string } {
  const id = record.codexMode ? record.codexAccountId : record.claudeProfileId
  const label = record.codexMode ? record.codexAccountLabel : record.claudeProfileLabel
  if (!id) return {}
  return { accountId: id, ...(label ? { accountLabel: label } : {}) }
}

/** A launch as the History remembers it (`LedgerLaunch`). */
export interface RememberedLaunch {
  readonly dangerous?: boolean | undefined
  readonly permissionMode?: string | undefined
  readonly effort?: string | undefined
  readonly accountId?: string | undefined
}

export interface ResumeLaunch {
  dangerousMode: boolean
  permissionMode?: SpawnPermissionMode
  allowDangerous?: boolean
  effort?: string
  accountId?: string
}

/**
 * The launch a reopen from the History defaults to (PRDCT-4236), one rule for
 * the dialog (`session-history.ts`) and the agent's `clave_open_session` with
 * `resume` (`conversation-history.ts`): what the ledger remembers, under the
 * Resume's own rule (`runtimeChoices`). Claude takes bypass, the mode, the
 * effort and the account; Codex takes bypass, the effort and the account,
 * never a mode; Pi takes none of them (its provider and thinking are the
 * History entry's). An explicit `dangerous` or `permissionMode` from the
 * caller wins over the remembered mode: bypass is then the caller's, and no
 * remembered mode is filled in. The account is returned as remembered; each
 * caller checks it still exists and maps it to its own fields.
 */
export function resumeLaunch(
  provider: string,
  launch: RememberedLaunch | null | undefined,
  override: { dangerous?: unknown; permissionMode?: unknown } = {}
): ResumeLaunch {
  if (provider !== 'claude' && provider !== 'codex') return { dangerousMode: false }
  const remembered = launch ?? {}
  const callerChose = override.dangerous !== undefined || override.permissionMode !== undefined
  const choices = runtimeChoices({
    dangerousMode: callerChose ? override.dangerous === true : remembered.dangerous === true,
    permissionMode: callerChose ? undefined : remembered.permissionMode,
    effort: remembered.effort
  })
  const out: ResumeLaunch = { dangerousMode: choices.dangerousMode }
  if (provider === 'claude' && choices.permissionMode) {
    out.permissionMode = choices.permissionMode
    if (choices.allowDangerous) out.allowDangerous = true
  }
  if (choices.effort) out.effort = choices.effort
  if (remembered.accountId) out.accountId = remembered.accountId
  return out
}
