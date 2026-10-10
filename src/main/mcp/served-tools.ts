/**
 * The agent tools the server serves: the wave 3 seven (`clave_list`,
 * `createGroup`, `rename` of a group, `setGroupView`, `moveSession`,
 * `addGroupTerminal`, `closeSession`) in this file, and the wave 4 seven
 * (`rename` of a tab, `setSessionView`, `readSession`, `sendToSession`,
 * `switchAccount`, `openSession`, `launchGroup`) in
 * `served-session-tools.ts`, all mapped onto the server's commands and
 * queries through the typed client instead of a window's store. Each
 * answers the SAME result shape and the SAME error texts as the renderer's
 * handler it replaces (`src/renderer/src/lib/mcp-dispatcher.ts`), so an
 * agent or a spec sees no difference but the road (`noteRoad`).
 *
 * No Electron here: the shell's facts come in through `ServedShell`
 * (`served-core.ts`), so the module is tested on fakes. A command this
 * module cannot finish on the server answers `NOT_SERVED`, and the caller
 * sends it to the window as before.
 */
import { noteRoad } from './roads'
import {
  AGENT_MODES,
  type Ctx,
  NOT_SERVED,
  type NotServed,
  type Payload,
  type ServedContext,
  type ToolWindow,
  allLayouts,
  endpointOf,
  getSession,
  groupOfSession,
  groupOptions,
  modeOf,
  resolveGroupRef,
  resolveWorkspace,
  str,
  tagOf,
  workspaceForSpawn,
  workspaceNameOf
} from './served-core'
import { sessionTools } from './served-session-tools'

export {
  NOT_SERVED,
  type NotServed,
  type ToolWindow,
  type ServedWorkspace,
  type ServedAccount,
  type ServedShell,
  type ServedContext,
  type GroupRefOptions,
  type ResolvedGroup,
  modeOf,
  resolveGroupRef
} from './served-core'

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
  // No "mine" here: the window's handler takes an id and nothing else, and
  // the two roads of one tool must answer the same call the same way.
  const ref = str(p.sessionId) ?? ''
  const id = ref
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
      // The window's listing never said 'ended' (its run state has no such
      // word; an ended tab kept its last state or none): the same vocabulary.
      agentState: s.state === 'ended' ? null : s.state,
      account: record ? ctx.shell.accountOf(record) : null,
      groupId: groupOfSession(layouts, s.id)?.id ?? null,
      view: record?.view ? { url: record.view.url, title: record.view.title ?? null } : null,
      workspaceId: record?.workspaceId ?? null,
      workspaceName: workspaceNameOf(ctx, record?.workspaceId),
      windowId: windowIdOf(s.windowKey)
    }))
  // The layouts of live windows only: a key the server keeps for a window
  // that is gone is an orphan the primary takes at its next read, and the
  // window-by-window aggregate never listed it.
  const groups = layouts
    .filter((l) => windowIdOf(l.windowKey) !== null)
    .flatMap((l) =>
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

/** Wave 3's tools here, wave 4's in `served-session-tools.ts`. */
const TOOLS: Record<string, (ctx: Ctx, key: string, p: Payload) => Promise<unknown>> = {
  list,
  createGroup,
  rename: async (ctx, key, p) =>
    p.target === 'group' ? renameGroup(ctx, key, p) : sessionTools.rename(ctx, key, p),
  setGroupView,
  moveSession,
  addGroupTerminal,
  closeSession,
  ...sessionTools.others
}
const SERVED = new Set(Object.keys(TOOLS))

/** Serve an agent-tool command on the server, or answer `NOT_SERVED` for one
 *  the window must still run. */
export async function serveCommand<W extends ToolWindow>(
  command: string,
  payload: Record<string, unknown>,
  ctx: ServedContext<W>
): Promise<unknown | NotServed> {
  if (!SERVED.has(command)) return NOT_SERVED
  const c = ctx as unknown as Ctx
  const key = c.win ? c.shell.keyOf(c.win) : null
  if (!key) throw new Error('Clave window not available')
  const result = await TOOLS[command](c, key, payload)
  if (result !== NOT_SERVED) noteRoad(command, 'server')
  return result
}
