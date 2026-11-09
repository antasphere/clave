import type { Session, SessionGroup } from '../store/session-types'
import { sessionMode, groupOfSession } from './exchange-capture'
import type { HistoryLedgerRow, HistoryListEntry } from '../../../preload/index.d'
import { runtimeChoices, type RuntimeChoices } from '../../../shared/runtime-choices'
import { entryInGroup, type GroupRef } from '../../../shared/history-group-match'
import { encodeProjectDir } from '../../../shared/project-dir'

/**
 * The session ledger's diff (PRDCT-1738), store-free so the unit tests pin it.
 *
 * Every tab has a PLACEMENT IDENTITY — which group it sits in (and that
 * group's name), its own name, its transcript id, its workspace. Whenever a
 * tab's identity differs from the last one stamped, one `placed` row is sent;
 * when a tab leaves the state, one `closed` row with its last identity.
 * Diffing the state rather than hooking actions is the point: a drag into a
 * group, Cmd+G, an ungroup, a group deletion, an agent's clave_move_session,
 * a re-adoption after a restart all change the tuple and all land here
 * without being named — and they land AT THE MOVE, which the exchange-capture
 * stream (stamping the group as of the NEXT hook word) could not promise.
 *
 * Only TABS are stamped: the hidden halves (a group's quick-launch terminal,
 * a view's serving process) are in the store but in no group and not in the
 * display order, and they are nobody's history.
 */

export interface LayoutState {
  sessions: Session[]
  groups: SessionGroup[]
  displayOrder: string[]
}

interface Stamped {
  key: string
  row: HistoryLedgerRow
}

export class SessionHistoryDiff {
  private readonly stamped = new Map<string, Stamped>()

  constructor(
    private readonly send: (row: HistoryLedgerRow) => void,
    private readonly now: () => string = () => new Date().toISOString()
  ) {}

  /** One pass over a state: stamp what changed since the last pass. */
  apply(state: LayoutState): void {
    const seen = new Set<string>()
    for (const s of tabSessions(state)) {
      seen.add(s.id)
      const row = identityRow(s, groupOfSession(state.groups, s.id), this.now())
      const key = keyOf(row)
      const prev = this.stamped.get(s.id)
      if (prev && prev.key === key) continue
      this.stamped.set(s.id, { key, row })
      this.send(row)
    }
    for (const [id, prev] of this.stamped) {
      if (seen.has(id)) continue
      this.stamped.delete(id)
      // The closed row is the placement's last word, not the launch's: the
      // launch the renderer knows is the flag the tab started with, and a
      // row stamped from the record at the close (`historyRestamp`) knows
      // the mode it moved to; a copy of the launch flag here would write
      // over it (PRDCT-4236, round 6). Main still adds the record's mode
      // where the record is there.
      const {
        dangerous: _d,
        permissionMode: _m,
        effort: _e,
        accountId: _a,
        accountLabel: _l,
        ...placement
      } = prev.row
      void _d
      void _m
      void _e
      void _a
      void _l
      this.send({ ...placement, kind: 'closed', ts: this.now() })
    }
  }

  reset(): void {
    this.stamped.clear()
  }
}

/** The tabs: local sessions in a group or at the top level of the sidebar.
 *  An empty `displayOrder` is the legacy "everything is a tab" state. */
export function tabSessions(state: LayoutState): Session[] {
  const top = new Set(state.displayOrder)
  const grouped = new Set(state.groups.flatMap((g) => g.sessionIds))
  return state.sessions.filter(
    (s) =>
      s.sessionType === 'local' &&
      (grouped.has(s.id) || top.has(s.id) || state.displayOrder.length === 0)
  )
}

function identityRow(s: Session, group: SessionGroup | undefined, ts: string): HistoryLedgerRow {
  return {
    v: 1,
    kind: 'placed',
    ts,
    sessionId: s.id,
    claudeSessionId: s.claudeSessionId ?? s.piSessionId ?? null,
    name: s.name,
    cwd: s.cwd,
    mode: sessionMode(s),
    model: s.model ?? null,
    workspaceId: s.workspaceId ?? null,
    groupId: group?.id ?? null,
    groupName: group?.name ?? null,
    // What it was launched on (PRDCT-4236), so a reopen from the History
    // comes back the same way; main adds the mode and the effort.
    dangerous: s.dangerousMode === true,
    ...accountOf(s)
  }
}

/** The account a tab runs on: its Codex account for a Codex tab, its Claude
 *  account otherwise; nothing when it names none (the pool's pick). */
function accountOf(s: Session): { accountId?: string; accountLabel?: string } {
  const id = s.codexMode ? s.codexAccountId : s.claudeProfileId
  const label = s.codexMode ? s.codexAccountLabel : s.claudeProfileLabel
  if (!id) return {}
  return { accountId: id, ...(label ? { accountLabel: label } : {}) }
}

/** The placement identity as one string. NUL-separated (as an escape, never
 *  a raw byte — that made this file binary to git once): a space would let
 *  {group "a b", name "c"} and {group "a", name "b c"} collide. */
function keyOf(r: HistoryLedgerRow): string {
  return [
    r.groupId ?? '',
    r.groupName ?? '',
    r.name,
    r.claudeSessionId ?? '',
    r.workspaceId ?? '',
    // A switch of account or of bypass is a new launch to remember.
    r.dangerous ? '1' : '0',
    r.accountId ?? ''
  ].join('\u0000')
}

/** The spawn fields of a reopen from the History (PRDCT-4236): the launch the
 *  ledger remembers, under the Resume's own rule (`runtimeChoices`). The
 *  person's explicit "skip permissions" wins over a launch without bypass,
 *  and then no mode short of bypass is passed. The account is named only
 *  when it still exists (`accountExists` answers with its current label);
 *  an unknown one falls back to the pool. Claude only: the History resumes
 *  nothing else that takes these flags. */
export function historyResumeLaunch(
  entry: Pick<HistoryListEntry, 'provider' | 'model' | 'launch'>,
  dangerousMode: boolean,
  accountLabel: (provider: 'claude' | 'codex', id: string) => string | null
): Pick<RuntimeChoices, 'dangerousMode' | 'permissionMode' | 'allowDangerous' | 'effort'> & {
  claudeProfileId?: string
  claudeProfileLabel?: string
  codexAccountId?: string
  codexAccountLabel?: string
} {
  if (entry.provider !== 'claude' && entry.provider !== 'codex') return { dangerousMode: false }
  const launch = entry.launch ?? {}
  // Asked for bypass: the remembered mode short of it is not passed.
  const choices: RuntimeChoices = runtimeChoices({
    dangerousMode: dangerousMode || launch.dangerous === true,
    permissionMode: dangerousMode ? undefined : launch.permissionMode,
    effort: launch.effort
  })
  const out: ReturnType<typeof historyResumeLaunch> = {
    dangerousMode: entry.provider === 'claude' && choices.dangerousMode
  }
  if (entry.provider === 'claude') {
    if (choices.permissionMode) out.permissionMode = choices.permissionMode
    if (choices.allowDangerous) out.allowDangerous = true
  }
  if (choices.effort) out.effort = choices.effort
  const id = launch.accountId
  const label = id ? accountLabel(entry.provider, id) : null
  if (id && label !== null) {
    if (entry.provider === 'claude') {
      out.claudeProfileId = id
      out.claudeProfileLabel = label
    } else {
      out.codexAccountId = id
      out.codexAccountLabel = label
    }
  }
  return out
}

/** Where a resumed conversation lands: the group the dialog was filtered to
 *  when it is live, else the live group the conversation LAST lived in
 *  (matched by id or name, among the groups shown), else the top level.
 *  Never the group that happens to hold the selection — `addSession`'s
 *  default — because that placement would be stamped into the ledger as
 *  somewhere the conversation lived. */
export function resumeTargetGroup(
  lived: readonly GroupRef[],
  requested: string | null,
  shownGroups: readonly GroupRef[]
): string | null {
  if (requested && shownGroups.some((g) => g.id === requested)) return requested
  for (const past of [...lived].reverse()) {
    const live = shownGroups.find((g) => entryInGroup([past], g))
    if (live) return live.id
  }
  return null
}

/** Is a history entry visible in the shown workspace? A stamped entry by its
 *  workspace id; an unstamped one (the capture seed, an "Everything"
 *  transcript) by its OWN cwd against the workspace root — the dir name in
 *  the store is lossy, the transcript's records are not. With no workspace
 *  (or no root known), everything shows. */
export function visibleInWorkspace(
  entry: { workspaceId: string | null; cwd: string; projectDir?: string },
  activeWorkspaceId: string | null,
  activeRoot: string | null
): boolean {
  if (!activeWorkspaceId) return true
  if (entry.workspaceId) return entry.workspaceId === activeWorkspaceId
  if (!activeRoot) return true
  if (entry.cwd) return entry.cwd === activeRoot || entry.cwd.startsWith(activeRoot + '/')
  // No cwd anywhere in the transcript: fall back to the store's project dir
  // name — a lossy encoding, perfectly adequate for a prefix test, and the
  // difference between "shown in its workspace" and "leaks into every one".
  if (entry.projectDir) {
    const enc = encodeProjectDir(activeRoot)
    return entry.projectDir === enc || entry.projectDir.startsWith(enc + '-')
  }
  return true
}

export { encodeProjectDir } from '../../../shared/project-dir'

/** The row dot's word, the sidebar's own mapping: a closed conversation is a
 *  hollow ring; a live tab is blue while its agent works, amber while it
 *  waits on the human, green otherwise (idle and done both read as an open
 *  tab at rest — History's axis is open/closed, not seen/unseen). */
export function dotStateOf(
  live: boolean,
  run: string | undefined
): 'closed' | 'working' | 'blocked' | 'open' {
  if (!live) return 'closed'
  if (run === 'working') return 'working'
  if (run === 'blocked') return 'blocked'
  return 'open'
}
