/**
 * The agent tools the server serves (wave 3): `clave_list`, `createGroup`,
 * `rename` (a group), `setGroupView`, `moveSession`, `addGroupTerminal` and
 * `closeSession`, mapped onto the server's commands and queries through the
 * typed client instead of a window's store. Each answers the SAME result
 * shape and the SAME error texts as the renderer's handler it replaces
 * (`src/renderer/src/lib/mcp-dispatcher.ts`), so an agent or a spec sees no
 * difference but the road (`noteRoad`).
 *
 * No Electron here: the shell's facts (windows, workspaces, session records,
 * the capture, the pty start) come in through `ServedShell`, so the module
 * is tested on fakes. A command this module cannot finish on the server
 * answers `NOT_SERVED`, and the caller sends it to the window as before.
 */
import type { ClaveApiClient } from '@clave/client'
import type { LayoutSnapshot, SidebarGroup } from '@clave/contract/sidebar'
import type { Session } from '@clave/contract/sessions'
import type { SessionRecord } from '../sessions/adapters/pty-backend'
import type { EndpointIdentity, TabClosedCapturePayload } from '../exchange-capture/types'
import { noteRoad } from './roads'

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
}

export interface ServedContext<W extends ToolWindow = ToolWindow> {
  readonly api: ClaveApiClient
  readonly shell: ServedShell<W>
  /** The window the command was routed to (mcp-server.ts resolves it). */
  readonly win: W | null
  readonly callerSessionId: string | undefined
  /** The window a `window` argument names, for moveSession. */
  readonly targetWindow?: W | null
  /** A command the window itself must run, through the server's view request. */
  readonly requestView: <T>(windowKey: string, command: string, payload: unknown) => Promise<T>
}

type Ctx = ServedContext<ToolWindow>
type Payload = Record<string, unknown>

const SERVED = new Set([
  'list',
  'createGroup',
  'rename',
  'setGroupView',
  'moveSession',
  'addGroupTerminal',
  'closeSession'
])

const tagOf = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && '_tag' in err
    ? String((err as { _tag: unknown })._tag)
    : undefined

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

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

const AGENT_MODES = new Set(['claude', 'codex', 'antigravity', 'claude-agents'])

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

function workspaceNameOf(ctx: Ctx, id: string | null | undefined): string | null {
  if (!id) return null
  return ctx.shell.workspaces().find((w) => w.id === id)?.name ?? null
}

/** The workspace id of an explicit reference, refused as the renderer's `resolveWorkspace` refuses. */
function resolveWorkspace(ctx: Ctx, ref: string): string {
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
function workspaceForSpawn(ctx: Ctx, explicit: string | undefined): string | undefined {
  if (explicit) return resolveWorkspace(ctx, explicit)
  const caller = ctx.callerSessionId ? ctx.shell.record(ctx.callerSessionId) : undefined
  return (
    caller?.workspaceId ?? (ctx.win ? ctx.shell.workspaceOfWindow(ctx.win.id) : null) ?? undefined
  )
}

/** The routed layout first, then every other one, each key once. */
async function allLayouts(ctx: Ctx, routedKey: string): Promise<LayoutSnapshot[]> {
  const [routed, rest] = await Promise.all([
    ctx.api.sidebar.getLayout(routedKey),
    ctx.api.sidebar.listLayouts()
  ])
  return [routed, ...rest.filter((l) => l.windowKey !== routedKey)]
}

function groupOptions(ctx: Ctx): GroupRefOptions {
  return {
    callerSessionId: ctx.callerSessionId,
    callerWorkspaceId: ctx.callerSessionId
      ? ctx.shell.record(ctx.callerSessionId)?.workspaceId
      : undefined,
    windowWorkspaceId: ctx.win ? ctx.shell.workspaceOfWindow(ctx.win.id) : null,
    workspaceNameOf: (id) => workspaceNameOf(ctx, id)
  }
}

async function getSession(ctx: Ctx, id: string, asGiven: string): Promise<Session> {
  try {
    return await ctx.api.sessions.get(id)
  } catch (err) {
    if (tagOf(err) === 'SessionNotFound') throw new Error(`No session with id "${asGiven}"`)
    throw err
  }
}

const groupOfSession = (
  layouts: readonly LayoutSnapshot[],
  sessionId: string
): SidebarGroup | undefined =>
  layouts.flatMap((l) => l.groups).find((g) => g.sessionIds.includes(sessionId))

// ── The tools ──

async function createGroup(ctx: Ctx, key: string, p: Payload): Promise<unknown> {
  const workspaceId = workspaceForSpawn(ctx, str(p.workspace))
  const prompt = str(p.prompt)
  const { group } = await ctx.api.sidebar.createGroup({
    windowKey: key,
    group: {
      name: str(p.name) ?? '',
      ...(prompt ? { prompt } : {}),
      ...(workspaceId !== undefined ? { workspaceId } : {})
    }
  })
  return {
    groupId: group.id,
    name: group.name,
    workspaceId: group.workspaceId ?? null,
    prompt: group.prompt ?? null
  }
}

async function renameGroup(ctx: Ctx, key: string, p: Payload): Promise<unknown> {
  const id = str(p.id) ?? ''
  const name = str(p.name) ?? ''
  const holder = (await allLayouts(ctx, key)).find((l) => l.groups.some((g) => g.id === id))
  if (!holder) throw new Error(`No group with id "${id}"`)
  try {
    await ctx.api.sidebar.renameGroup({ windowKey: holder.windowKey, groupId: id, name })
  } catch (err) {
    if (tagOf(err) === 'GroupNotFound') throw new Error(`No group with id "${id}"`)
    throw err
  }
  return { renamed: id, name }
}

async function setGroupView(ctx: Ctx, key: string, p: Payload): Promise<unknown> {
  const layouts = await allLayouts(ctx, key)
  const { group, windowKey } = resolveGroupRef(
    layouts,
    key,
    str(p.groupId) ?? '',
    groupOptions(ctx)
  )
  if (p.url === null) {
    await ctx.api.sidebar.setGroupView({ windowKey, groupId: group.id, view: null })
    return { groupId: group.id, view: null }
  }
  const url = (str(p.url) ?? '').trim()
  if (url.startsWith('/')) {
    if (!/\.html?$/i.test(url)) {
      throw new Error('A file view must be an .html/.htm file (or pass an http(s) URL)')
    }
    const kind = await ctx.shell.statKind(url).catch(() => null)
    if (kind !== 'file') throw new Error(`No file at "${url}"`)
  } else if (!/^https?:\/\//i.test(url)) {
    throw new Error('url must be an http(s) URL or an absolute .html file path')
  }
  const terminalId = str(p.terminalId)
  if (terminalId && !group.terminals.some((t) => t.id === terminalId)) {
    throw new Error(`Group has no terminal "${terminalId}"`)
  }
  const title = str(p.title)
  const view = { url, title, terminalId: terminalId ?? null }
  await ctx.api.sidebar.setGroupView({
    windowKey,
    groupId: group.id,
    view: { url, ...(title !== undefined ? { title } : {}), terminalId: terminalId ?? null }
  })
  const linked = terminalId ? group.terminals.find((t) => t.id === terminalId) : undefined
  if (linked && linked.serverUrl === url && !linked.groupView) {
    await ctx.api.sidebar.updateTerminal({
      windowKey,
      groupId: group.id,
      terminalId: linked.id,
      patch: { groupView: true }
    })
  }
  return { groupId: group.id, view }
}

async function moveSession(ctx: Ctx, key: string, p: Payload): Promise<unknown> {
  const ref = str(p.sessionId) ?? ''
  const id = ref === 'mine' ? ctx.callerSessionId : ref
  if (!id) throw new Error(`No session with id "${ref}"`)
  await getSession(ctx, id, ref)

  let placeKey = key
  let moved = false
  const target = ctx.targetWindow
  if (target && target.id !== ctx.win?.id) {
    const targetKey = ctx.shell.keyOf(target)
    if (!targetKey) throw new Error('Clave window not available')
    // The waiter is registered BEFORE the move: the ack can only ever answer
    // this wait, never a stale one.
    const adopted = ctx.shell.awaitRehomed([id])
    const outcome = await ctx.api.sidebar.moveSessions({
      sessionIds: [id],
      targetWindowKey: targetKey,
      focus: true
    })
    const refused = outcome.refused.find((r) => r.sessionId === id)
    if (refused) {
      adopted.catch(() => undefined)
      throw new Error(
        refused.reason === 'not-tmux'
          ? 'This session is not tmux-backed and cannot move between windows'
          : `Session ${id} is not live`
      )
    }
    await adopted
    placeKey = targetKey
    moved = true
  }

  const groupRef = str(p.groupId) ?? ''
  if (groupRef === 'root') {
    await ctx.api.sidebar.moveItems({
      windowKey: placeKey,
      itemIds: [id],
      targetId: null,
      position: 'after'
    })
    return { sessionId: id, groupId: null }
  }
  // The renderer resolved the group in the window the session lives in.
  const layout = await ctx.api.sidebar.getLayout(placeKey)
  const { group } = resolveGroupRef([layout], placeKey, groupRef, groupOptions(ctx))
  const recordWs = ctx.shell.record(id)?.workspaceId ?? null
  // Aligning a tab's workspace to its group's is the window's work still.
  if (!moved && (group.workspaceId ?? null) !== recordWs) return NOT_SERVED
  await ctx.api.sidebar.moveItems({
    windowKey: placeKey,
    itemIds: [id],
    targetId: group.id,
    position: 'inside'
  })
  return { sessionId: id, groupId: group.id }
}

async function addGroupTerminal(ctx: Ctx, key: string, p: Payload): Promise<unknown> {
  const layouts = await allLayouts(ctx, key)
  const { group, windowKey } = resolveGroupRef(
    layouts,
    key,
    str(p.groupId) ?? '',
    groupOptions(ctx)
  )
  const command = str(p.command) ?? ''
  const commandMode = p.commandMode === 'prefill' ? 'prefill' : 'auto'
  const serverUrl = str(p.serverUrl)
  if (p.groupView && !serverUrl) {
    throw new Error('groupView requires a serverUrl — the group view shows that URL')
  }
  const memberCwd = group.sessionIds
    .map((sid) => ctx.shell.record(sid))
    .find((r) => r !== undefined)?.cwd
  const groupCwd = group.cwd ?? memberCwd ?? null
  const explicitCwd = str(p.cwd)
  const cwd = explicitCwd ?? groupCwd
  if (!cwd) throw new Error('Group has no working directory — pass an explicit cwd')

  const terminalId = ctx.shell.mintTerminalId()
  await ctx.api.sidebar.addTerminal({
    windowKey,
    groupId: group.id,
    terminal: {
      id: terminalId,
      command,
      commandMode,
      color: str(p.color) ?? 'green',
      icon: str(p.icon) ?? 'terminal',
      cwd: explicitCwd && explicitCwd !== groupCwd ? explicitCwd : null,
      ...(serverUrl !== undefined ? { serverUrl } : {}),
      ...(p.groupView === true ? { groupView: true } : {}),
      sessionId: null
    }
  })
  if (p.groupView && serverUrl) {
    await ctx.api.sidebar.setGroupView({
      windowKey,
      groupId: group.id,
      view: { url: serverUrl, ...(command ? { title: command } : {}), terminalId }
    })
  }
  if (p.launch === false) return { terminalId, groupId: group.id, sessionId: null }

  const info = await ctx.api.sessions.start({
    cwd,
    windowKey,
    options: {
      claudeMode: false,
      ...(command ? { initialCommand: command } : {}),
      autoExecute: !!command && commandMode === 'auto',
      ...(group.workspaceId !== undefined ? { workspaceId: group.workspaceId } : {}),
      link: { kind: 'group-terminal', groupId: group.id, terminalId }
    }
  })
  // A terminal with no pane never gets its sized start otherwise.
  ctx.shell.startPty(info.id, 120, 30)
  await ctx.api.sidebar.updateTerminal({
    windowKey,
    groupId: group.id,
    terminalId,
    patch: { sessionId: info.id }
  })
  return { terminalId, groupId: group.id, sessionId: info.id }
}

function endpointOf(
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

async function closeSession(ctx: Ctx, key: string, p: Payload): Promise<unknown> {
  const ref = str(p.sessionId) ?? ''
  const id = ref === 'mine' ? ctx.callerSessionId : ref
  if (!id) {
    throw new Error('sessionId "mine" needs a calling tab — this request has no tab identity')
  }
  const session = await getSession(ctx, id, ref)

  // An agent-initiated close is recorded with the closing tab as `closer`
  // BEFORE the stop, while its identity is still known. Capture is
  // observability: it never fails the close.
  if (AGENT_MODES.has(modeOf(ctx.shell.record(id), session.provider))) {
    try {
      const layouts = await allLayouts(ctx, key)
      const closerSession = ctx.callerSessionId
        ? await ctx.api.sessions.get(ctx.callerSessionId).catch(() => null)
        : null
      const subject = endpointOf(ctx, session, layouts)
      const closer = closerSession ? endpointOf(ctx, closerSession, layouts) : null
      // The renderer's capture threw (and dropped the event) on a Pi closer.
      if (subject && (closerSession === null || closer !== null)) {
        ctx.shell.captureTabClosed({
          ts: new Date().toISOString(),
          session: subject,
          by: 'agent',
          closer
        })
      }
    } catch {
      // observability only
    }
  }

  await ctx.api.sessions.stop(id)
  for (let i = 0; i < 40; i++) {
    const current = await ctx.api.sessions.get(id).catch(() => null)
    if (!current || current.state === 'ended') break
    await ctx.shell.sleep(50)
  }
  for (const serving of ctx.shell.servingSessionsOf(id)) {
    await ctx.api.sessions.stop(serving).catch(() => undefined)
  }
  await ctx.api.sidebar.removeSession({ windowKey: session.windowKey || key, sessionId: id })
  return { closed: id }
}

const dedupeById = <T extends { id: string }>(items: T[]): T[] => {
  const seen = new Set<string>()
  return items.filter((x) => (seen.has(x.id) ? false : (seen.add(x.id), true)))
}

async function list(ctx: Ctx, key: string, p: Payload): Promise<unknown> {
  const activeWorkspaceId = ctx.win ? ctx.shell.workspaceOfWindow(ctx.win.id) : null
  const scope = str(p.workspace) ?? 'all'
  // 'active' with no workspace on the window keeps everything, as the
  // aggregate over the windows did.
  const scopeId: string | 'all' =
    scope === 'all'
      ? 'all'
      : scope === 'active'
        ? (activeWorkspaceId ?? 'all')
        : resolveWorkspace(ctx, scope)
  const inScope = (workspaceId: string | null | undefined): boolean =>
    scopeId === 'all' || workspaceId === scopeId || workspaceId == null

  const [allSessions, layouts] = await Promise.all([
    ctx.api.sessions.list(),
    ctx.api.sidebar.listLayouts()
  ])
  const windowIdOf = (windowKey: string): number | null =>
    ctx.shell.windowByKey(windowKey)?.id ?? null

  const sessions = allSessions
    .map((s) => ({ s, record: ctx.shell.record(s.id) }))
    .filter(({ record }) => inScope(record?.workspaceId))
    .map(({ s, record }) => ({
      id: s.id,
      name: s.title,
      cwd: s.cwd,
      mode: modeOf(record, s.provider),
      alive: s.state !== 'ended',
      agentState: s.state,
      account: record ? ctx.shell.accountOf(record) : null,
      groupId: groupOfSession(layouts, s.id)?.id ?? null,
      view: record?.view ? { url: record.view.url, title: record.view.title ?? null } : null,
      workspaceId: record?.workspaceId ?? null,
      workspaceName: workspaceNameOf(ctx, record?.workspaceId),
      windowId: windowIdOf(s.windowKey)
    }))
  const groups = layouts.flatMap((l) =>
    l.groups
      .filter((g) => inScope(g.workspaceId))
      .map((g) => ({
        id: g.id,
        name: g.name,
        cwd: g.cwd,
        color: g.color ?? null,
        view: g.view ?? null,
        sessionIds: g.sessionIds,
        workspaceId: g.workspaceId ?? null,
        workspaceName: workspaceNameOf(ctx, g.workspaceId),
        terminals: g.terminals.map((t) => ({
          id: t.id,
          command: t.command,
          commandMode: t.commandMode,
          color: t.color,
          icon: t.icon ?? null,
          serverUrl: t.serverUrl ?? null,
          sessionId: t.sessionId
        })),
        windowId: windowIdOf(l.windowKey)
      }))
  )
  const windowState = await ctx.requestView<{
    pinnedGroups?: unknown[]
    focusedSessionId?: string | null
  }>(key, 'windowState', { workspace: scopeId, callerSessionId: ctx.callerSessionId })
  const callerSessionId = ctx.callerSessionId ?? null
  return {
    workspaces: ctx.shell.workspaces().map((w) => ({
      id: w.id,
      name: w.name,
      rootDir: w.rootDir,
      active: w.id === activeWorkspaceId
    })),
    activeWorkspaceId,
    groups: dedupeById(groups),
    sessions: dedupeById(sessions),
    pinnedGroups: windowState?.pinnedGroups ?? [],
    focusedSessionId: windowState?.focusedSessionId ?? null,
    callerSessionId,
    callerGroupId: callerSessionId ? (groupOfSession(layouts, callerSessionId)?.id ?? null) : null,
    windows: ctx.shell.windowsListing(ctx.win),
    callerWindowId: ctx.win?.id ?? null
  }
}

const TOOLS: Record<string, (ctx: Ctx, key: string, p: Payload) => Promise<unknown>> = {
  list,
  createGroup,
  rename: renameGroup,
  setGroupView,
  moveSession,
  addGroupTerminal,
  closeSession
}

/** Serve an agent-tool command on the server, or answer `NOT_SERVED` for one
 *  the window must still run. */
export async function serveCommand<W extends ToolWindow>(
  command: string,
  payload: Record<string, unknown>,
  ctx: ServedContext<W>
): Promise<unknown | NotServed> {
  if (!SERVED.has(command)) return NOT_SERVED
  if (command === 'rename' && payload.target !== 'group') return NOT_SERVED
  const c = ctx as unknown as Ctx
  const key = c.win ? c.shell.keyOf(c.win) : null
  if (!key) throw new Error('Clave window not available')
  const result = await TOOLS[command](c, key, payload)
  if (result !== NOT_SERVED) noteRoad(command, 'server')
  return result
}
