/**
 * What every served agent tool stands on (wave 3, PRDCT-3294; split out of
 * `served-tools.ts` in wave 4, PRDCT-3377, when the last seven tools joined):
 * the shell's facts a tool reads (`ServedShell`, answered by main), the
 * context a call carries, and the resolvers the renderer's dispatcher had
 * (a group by reference, a workspace, a session's mode, the capture
 * identity of a tab). No Electron here: the shell comes in through the
 * interface, so every tool is tested on fakes.
 */
import type { ClaveApiClient } from '@clave/client'
import type { LayoutSnapshot, SidebarGroup } from '@clave/contract/sidebar'
import type { Session } from '@clave/contract/sessions'
import type { SessionRecord } from '../sessions/adapters/pty-backend'
import type {
  EndpointIdentity,
  MessageCapturePayload,
  TabClosedCapturePayload,
  TabSpawnCapturePayload
} from '../exchange-capture/types'
import type { ServerEvent } from '@clave/contract/events'
import type { AccountUsageSummary } from '../../shared/account-pool'
import type { LauncherFamily } from '../../shared/agent-launch'
import type { PinnedBlueprint } from '../../shared/pinned-blueprint'

export const NOT_SERVED: unique symbol = Symbol('not served')
export type NotServed = typeof NOT_SERVED

export interface ToolWindow {
  readonly id: number
}

export interface ServedWorkspace {
  readonly id: string
  readonly name: string
  readonly rootDir: string
}

export interface ServedAccount {
  readonly id: string
  readonly label: string
  readonly exhausted: boolean
}

export type AccountProvider = 'claude' | 'codex'

/** One account of a provider's pool, as the Accounts page orders them, with
 *  its last usage read summarized for the pool's rule. */
export interface ServedPoolAccount {
  readonly id: string
  readonly label: string
  /** Can be started on at all: a token that works, a home with a credential. */
  readonly usable: boolean
  /** A Codex API key: no quota to read, the pool's fallback only. */
  readonly fallback?: boolean
  readonly usage?: AccountUsageSummary
}

export type AccountSwitchMode = 'propose' | 'automatic'

/** The shell's facts a served tool needs, each answered by main. */
export interface ServedShell<W extends ToolWindow = ToolWindow> {
  /** The window's persisted key, null when the window is unknown. */
  keyOf(win: W): string | null
  /** The live window holding that key, null when none does. */
  windowByKey(key: string): W | null
  /** Every live window. */
  liveWindows(): W[]
  /** The workspace a window shows, null when it shows none. */
  workspaceOfWindow(winId: number): string | null
  /** Every configured workspace. */
  workspaces(): ServedWorkspace[]
  /** A workspace reference (id, exact name, case-insensitive name) to its id, null when unknown. */
  resolveWorkspaceId(ref: string): string | null
  /** The record main keeps for a session, undefined when it keeps none. */
  record(sessionId: string): SessionRecord | undefined
  /** The sessions recorded as serving a view of that owner (`link.kind === 'session-view'`). */
  servingSessionsOf(ownerId: string): string[]
  /** The account a session runs on, null for a tab with no account. */
  accountOf(record: SessionRecord): ServedAccount | null
  /** What sits at an absolute path: a file, a directory, or nothing. */
  statKind(absPath: string): Promise<'file' | 'directory' | null>
  /** The sized start of a pty that has no pane to measure it. */
  startPty(id: string, cols: number, rows: number): void
  /** Resolves when every one of these sessions was re-adopted by its new window. */
  awaitRehomed(ids: string[]): Promise<void>
  /** Records a tab's close on the exchange capture. */
  captureTabClosed(payload: TabClosedCapturePayload): void
  /** The `windows` block of clave_list, built by main for that caller's window. */
  windowsListing(callerWin: W | null): unknown[]
  /** A fresh quick-launch terminal id. */
  mintTerminalId(): string
  /** Waits that long. */
  sleep(ms: number): Promise<void>
  // ── Wave 4, lane D: what the last seven tools read of the shell ──
  /** The accounts of a provider's pool, in the Accounts page's order. */
  accounts(provider: AccountProvider): ServedPoolAccount[]
  /** The account selected in settings for that provider, undefined when none is. */
  selectedAccountId(provider: AccountProvider): string | undefined
  /** The switching mode a workspace runs under: its own, else the global one. */
  switchMode(workspaceId: string | null | undefined): AccountSwitchMode
  /** The launch profiles of a family, built-ins first. */
  launchProfiles(family: LauncherFamily): { id: string; name: string }[]
  /** The pinned groups the workspace state persists, every workspace's. */
  pins(): PinnedBlueprint[]
  /** The tab that opened a tab, null when none did (`sessions/lineage.ts`). */
  parentOf(sessionId: string): string | null
  setParent(childId: string, parentId: string): void
  /** Records a delivered message, or a checkpoint, on the exchange capture. */
  captureMessage(payload: MessageCapturePayload): void
  /** Records a tab an agent opened on the exchange capture. */
  captureTabSpawn(payload: TabSpawnCapturePayload): void
  /** Tells every window a fact the server has no command for (a pinned
   *  group's launch); nothing happens without a server publishing. */
  publish(event: ServerEvent): void
  /** A note to the person, as a system notification. */
  notify(title: string, body: string): void
}

export interface ServedContext<W extends ToolWindow = ToolWindow> {
  readonly api: ClaveApiClient
  readonly shell: ServedShell<W>
  /** The window the command was routed to (mcp-server.ts resolves it). */
  readonly win: W | null
  readonly callerSessionId: string | undefined
  /** The window a `window` argument names, for moveSession. */
  readonly targetWindow?: W | null
  /** A command the window itself must run, through the server's view
   *  request; `timeoutMs` bounds the wait when the caller has a plan B. */
  readonly requestView: <T>(
    windowKey: string,
    command: string,
    payload: unknown,
    timeoutMs?: number
  ) => Promise<T>
}

export type Ctx = ServedContext<ToolWindow>
export type Payload = Record<string, unknown>

export const tagOf = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && '_tag' in err
    ? String((err as { _tag: unknown })._tag)
    : undefined

export const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** A session's mode as the renderer's `sessionMode` spells it: from the
 *  record's flags when main keeps one, else from the provider's id. */
export function modeOf(record: SessionRecord | undefined, provider: string): string {
  if (record) {
    if (record.antigravityMode) return 'antigravity'
    if (record.codexMode) return 'codex'
    if (record.piMode) return 'pi'
    if (record.claudeAgentsMode) return 'claude-agents'
    if (record.claudeMode) return 'claude'
    return 'terminal'
  }
  return ['claude', 'codex', 'antigravity', 'pi', 'claude-agents'].includes(provider)
    ? provider
    : 'terminal'
}

export const AGENT_MODES = new Set(['claude', 'codex', 'antigravity', 'claude-agents'])

export interface GroupRefOptions {
  readonly callerSessionId: string | undefined
  readonly callerWorkspaceId: string | null | undefined
  readonly windowWorkspaceId: string | null | undefined
  readonly workspaceNameOf: (id: string | null | undefined) => string | null
}

export interface ResolvedGroup {
  readonly group: SidebarGroup
  /** The key of the layout holding the group. */
  readonly windowKey: string
}

const groupsOf = (layouts: readonly LayoutSnapshot[]): ResolvedGroup[] =>
  layouts.flatMap((l) => l.groups.map((group) => ({ group, windowKey: l.windowKey })))

/** The group of the renderer's `resolveGroup`, over every window's layout:
 *  "mine", an id, then a name (the routed window's layout first). Several
 *  matches pick the caller's workspace, then the window's, else refuse. */
export function resolveGroupRef(
  layouts: readonly LayoutSnapshot[],
  routedKey: string,
  ref: string,
  opts: GroupRefOptions
): ResolvedGroup {
  const all = groupsOf(layouts)
  if (ref === 'mine') {
    if (!opts.callerSessionId) {
      throw new Error('groupId "mine" requires the call to come from inside a Clave session')
    }
    const caller = opts.callerSessionId
    const found = all.find((r) => r.group.sessionIds.includes(caller))
    if (!found) throw new Error('The calling session is not in any group')
    return found
  }
  const byId = all.find((r) => r.group.id === ref)
  if (byId) return byId

  const routed = all.filter((r) => r.windowKey === routedKey && r.group.name === ref)
  const named = routed.length > 0 ? routed : all.filter((r) => r.group.name === ref)
  if (named.length === 0) throw new Error(`No group with id or name "${ref}"`)
  if (named.length === 1) return named[0]

  const pick = (ws: string | null | undefined): ResolvedGroup | undefined => {
    if (!ws) return undefined
    const inWs = named.filter((r) => r.group.workspaceId === ws)
    return inWs.length === 1 ? inWs[0] : undefined
  }
  const chosen = pick(opts.callerWorkspaceId) ?? pick(opts.windowWorkspaceId)
  if (chosen) return chosen
  const qualified = named
    .map(
      (r) => `${opts.workspaceNameOf(r.group.workspaceId) ?? '?'}/${r.group.name} (${r.group.id})`
    )
    .join(', ')
  throw new Error(
    `Group name "${ref}" is ambiguous across workspaces — use an id. Candidates: ${qualified}`
  )
}

export function workspaceNameOf(ctx: Ctx, id: string | null | undefined): string | null {
  if (!id) return null
  return ctx.shell.workspaces().find((w) => w.id === id)?.name ?? null
}

/** The workspace id of an explicit reference, refused as the renderer's `resolveWorkspace` refuses. */
export function resolveWorkspace(ctx: Ctx, ref: string): string {
  const workspaces = ctx.shell.workspaces()
  if (workspaces.length === 0) {
    throw new Error('No workspaces configured — the workspace parameter cannot be used')
  }
  const id = ctx.shell.resolveWorkspaceId(ref)
  if (!id) {
    throw new Error(`No workspace "${ref}". Available: ${workspaces.map((w) => w.name).join(', ')}`)
  }
  return id
}

/** The renderer's `workspaceForSpawn`: the explicit argument, else the
 *  caller's workspace, else the routed window's. */
export function workspaceForSpawn(ctx: Ctx, explicit: string | undefined): string | undefined {
  if (explicit) return resolveWorkspace(ctx, explicit)
  const caller = ctx.callerSessionId ? ctx.shell.record(ctx.callerSessionId) : undefined
  return (
    caller?.workspaceId ?? (ctx.win ? ctx.shell.workspaceOfWindow(ctx.win.id) : null) ?? undefined
  )
}

/** The routed layout first, then every other one, each key once. */
export async function allLayouts(ctx: Ctx, routedKey: string): Promise<LayoutSnapshot[]> {
  const [routed, rest] = await Promise.all([
    ctx.api.sidebar.getLayout(routedKey),
    ctx.api.sidebar.listLayouts()
  ])
  return [routed, ...rest.filter((l) => l.windowKey !== routedKey)]
}

export function groupOptions(ctx: Ctx): GroupRefOptions {
  return {
    callerSessionId: ctx.callerSessionId,
    callerWorkspaceId: ctx.callerSessionId
      ? ctx.shell.record(ctx.callerSessionId)?.workspaceId
      : undefined,
    windowWorkspaceId: ctx.win ? ctx.shell.workspaceOfWindow(ctx.win.id) : null,
    workspaceNameOf: (id) => workspaceNameOf(ctx, id)
  }
}

export async function getSession(ctx: Ctx, id: string, asGiven: string): Promise<Session> {
  try {
    return await ctx.api.sessions.get(id)
  } catch (err) {
    if (tagOf(err) === 'SessionNotFound') throw new Error(`No session with id "${asGiven}"`)
    throw err
  }
}

export const groupOfSession = (
  layouts: readonly LayoutSnapshot[],
  sessionId: string
): SidebarGroup | undefined =>
  layouts.flatMap((l) => l.groups).find((g) => g.sessionIds.includes(sessionId))

export function endpointOf(
  ctx: Ctx,
  session: Session,
  layouts: readonly LayoutSnapshot[]
): EndpointIdentity | null {
  const record = ctx.shell.record(session.id)
  const mode = modeOf(record, session.provider)
  if (mode === 'pi') return null
  const group = groupOfSession(layouts, session.id)
  return {
    sessionId: session.id,
    name: record?.displayName || record?.folderName || session.title,
    mode: mode as EndpointIdentity['mode'],
    cwd: record?.cwd ?? session.cwd,
    claudeSessionId: record?.claudeSessionId ?? null,
    groupId: group?.id ?? null,
    groupName: group?.name ?? null,
    model: record?.model ?? null
  }
}
