/**
 * The last seven agent tools served by the server (wave 4, PRDCT-3377):
 * `clave_rename` of a tab, `clave_set_session_view`, `clave_read_session`,
 * `clave_send_to_session`, `clave_switch_account`, `clave_open_session` and
 * `clave_launch_group`, each mapped onto the server's commands through the
 * typed client, with the same result shapes and the same error texts as the
 * renderer's handlers they replace (`src/renderer/src/lib/mcp-dispatcher.ts`).
 *
 * What stays the window's, by nature, is asked of it through one small view
 * request when the window is live and decided from the preferences when it
 * is not: a tab's own switching mode and its pin (the person sets them in
 * the tab's menu), and whether a pinned group is already running or hidden
 * (the pin's link to its live group is the window's memory). A proposal to
 * switch, and the showing of a hidden group, are the window's work still:
 * the tool answers `NOT_SERVED` and the caller sends it to the window.
 */
import type { AccountOverride, Session } from '@clave/contract/sessions'
import { pickAccount } from '../../shared/account-pool'
import { launchModeFields } from '../../shared/runtime-choices'
import { historyLines } from '../../shared/history-text'
import {
  type TargetHost,
  checkpointCapture,
  findTarget,
  isServerTabRef,
  readAnswer,
  requireCaller,
  resolveTarget as resolveOn,
  sendToTarget
} from './session-targets'
import {
  poolOf,
  resolveAccountRef as resolveAccountRefFrom,
  spawnFieldsOf,
  usageOf
} from './served-accounts'
import { resolveProfileRef, resolveSpawnModes } from '../../shared/open-session-modes'
import { substituteTokens } from '../../shared/prompt-tokens'
import { resolveDeclaredGroupView } from '../../shared/group-view'
import type { PinnedBlueprint, PinnedBlueprintSession } from '../../shared/pinned-blueprint'
import {
  type AccountProvider,
  type AccountSwitchMode,
  type Ctx,
  NOT_SERVED,
  type NotServed,
  type Payload,
  type ServedPoolAccount,
  allLayouts,
  endpointOf,
  getSession,
  groupOptions,
  modeOf,
  resolveGroupRef,
  resolveWorkspace,
  str,
  tagOf,
  workspaceForSpawn,
  workspaceNameOf
} from './served-core'

/** How long a tool waits for a window's own answer (a tab's pin, a pin's
 *  state) before it keeps the window road for the whole call. */
export const WINDOW_FACT_TIMEOUT_MS = 2_000
/** The size a session with no pane starts at, as the hidden spawns do. */
const HIDDEN_COLS = 120
const HIDDEN_ROWS = 30

const nameOf = (ctx: Ctx, session: Session): string => {
  const record = ctx.shell.record(session.id)
  return record?.displayName || record?.folderName || session.title
}
const modeOfSession = (ctx: Ctx, session: Session): string =>
  modeOf(ctx.shell.record(session.id), session.provider)

// ── Who may reach whom: the shared rule (`session-targets.ts`), over this host's facts ──

/** The tab that opened this one: main's own memory of the open, else the
 *  session's record, which is what still says it after a restart (#259):
 *  the opener nested or not (`openedBy`, PRDCT-4192), else the nesting
 *  parent (`spawnedBy`). */
function parentOfSession(ctx: Ctx, sessionId: string): string | null {
  const record = ctx.shell.record(sessionId)
  return ctx.shell.parentOf(sessionId) ?? record?.openedBy ?? record?.spawnedBy ?? null
}

/** This host, as the shared resolver reads it: the server's sessions through
 *  the typed client, the records and the lineage through the shell, the
 *  groups of every window's layout. */
function targetHost(ctx: Ctx, key: string): TargetHost {
  return {
    caller: ctx.callerSessionId,
    routedKey: key,
    get: (id) =>
      ctx.api.sessions.get(id).catch((err) => {
        if (tagOf(err) === 'SessionNotFound') return null
        throw err
      }),
    list: () => ctx.api.sessions.list(),
    nameOf: (session) => nameOf(ctx, session),
    modeOf: (session) => modeOfSession(ctx, session),
    parentOf: (id) => parentOfSession(ctx, id),
    groups: async () => (await allLayouts(ctx, key)).flatMap((l) => l.groups)
  }
}

// ── The tools ──

async function rename(ctx: Ctx, _key: string, p: Payload): Promise<unknown> {
  const id = str(p.id) ?? ''
  const name = str(p.name) ?? ''
  try {
    await ctx.api.sessions.rename(id, name)
  } catch (err) {
    if (tagOf(err) === 'SessionNotFound') throw new Error(`No session with id "${id}"`)
    throw err
  }
  return { renamed: id, name }
}

async function stopServing(ctx: Ctx, ownerId: string): Promise<void> {
  for (const serving of ctx.shell.servingSessionsOf(ownerId)) {
    await ctx.api.sessions.stop(serving).catch(() => undefined)
  }
}

async function setSessionView(ctx: Ctx, _key: string, p: Payload): Promise<unknown> {
  const ref = str(p.sessionId) ?? ''
  const id = ref === 'mine' ? ctx.callerSessionId : ref
  if (!id) throw new Error('sessionId "mine" needs a caller session — pass an explicit id')
  const session = await getSession(ctx, id, ref)

  if (p.url === null) {
    // Detach: the hidden serving session goes with the view, nothing else owns it.
    await stopServing(ctx, id)
    await ctx.api.sessions.setPage(id, null, null)
    return { sessionId: id, view: null }
  }
  const url = (str(p.url) ?? '').trim()
  const command = str(p.command)
  if (url.startsWith('/')) {
    if (!/\.html?$/i.test(url)) {
      throw new Error('A file view must be an .html/.htm file (or pass an http(s) URL)')
    }
    const kind = await ctx.shell.statKind(url).catch(() => null)
    if (kind !== 'file') throw new Error(`No file at "${url}"`)
    if (command) throw new Error('A file view has no server — command only applies to http(s) URLs')
  } else if (!/^https?:\/\//i.test(url)) {
    throw new Error('url must be an http(s) URL or an absolute .html file path')
  }
  // A previous serving session is replaced, not leaked.
  await stopServing(ctx, id)
  const record = ctx.shell.record(id)
  const cwd = str(p.cwd)
  let servingSessionId: string | null = null
  if (command) {
    // The serving session launches itself at attach, hidden: no row, no
    // pane, so its sized start is made here as a group terminal's is.
    const info = await ctx.api.sessions.start({
      cwd: cwd ?? record?.cwd ?? session.cwd,
      windowKey: session.windowKey,
      options: {
        claudeMode: false,
        initialCommand: command,
        autoExecute: true,
        ...(record?.workspaceId !== undefined ? { workspaceId: record.workspaceId } : {}),
        link: { kind: 'session-view', ownerId: id }
      }
    })
    await ctx.api.sessions.resize(info.id, HIDDEN_COLS, HIDDEN_ROWS)
    servingSessionId = info.id
  }
  const title = str(p.title)
  await ctx.api.sessions.setPage(
    id,
    {
      url,
      ...(title !== undefined ? { title } : {}),
      ...(command !== undefined ? { command } : {}),
      ...(cwd !== undefined ? { cwd } : {})
    },
    servingSessionId
  )
  return { sessionId: id, view: { url, title } }
}

async function readSession(ctx: Ctx, key: string, p: Payload): Promise<unknown | NotServed> {
  const ref = str(p.sessionId) ?? ''
  // A tab running on another server, by its key or by a name no tab of this
  // host carries, is read by the window that shows it, from the owning
  // server over the fleet bridge (PRDCT-4166). Until then main answered
  // "no session" for every server tab an agent had just opened.
  if (isServerTabRef(ref)) return NOT_SERVED
  const host = targetHost(ctx, key)
  const target = ref === 'parent' ? await resolveOn(host, ref) : await findTarget(host, ref)
  if (!target) return NOT_SERVED
  requireCaller(host, 'read')
  const requested = Math.min(Math.max(typeof p.lines === 'number' ? p.lines : 100, 1), 500)
  // A chat has no screen: its recent history, one line per thing said or
  // done, under the same envelope (PRDCT-4199).
  if (target.transport === 'events') {
    const page = await ctx.api.sessions.history(target.id, undefined, requested)
    return {
      ...(readAnswer(host, target, historyLines(page.items)) as Record<string, unknown>),
      history: page.items
    }
  }
  let screen: { lines: readonly string[] }
  try {
    screen = await ctx.api.sessions.screen(target.id, requested)
  } catch (err) {
    if (tagOf(err) === 'SessionScreenUnavailable') {
      // The window's text for a tab with nothing to read; any other reason
      // the host gives is said as it is, never hidden behind it.
      const message = (err as { message?: string }).message ?? ''
      throw new Error(
        message.includes('no terminal screen')
          ? `Session "${nameOf(ctx, target)}" has no terminal buffer (tab not mounted yet)`
          : `Session "${nameOf(ctx, target)}" could not be read: ${message}`
      )
    }
    throw err
  }
  return readAnswer(host, target, screen.lines)
}

async function sendToSession(ctx: Ctx, key: string, p: Payload): Promise<unknown | NotServed> {
  const ref = str(p.sessionId) ?? ''
  // A tab of another server is the window's (PRDCT-4193); so is a name no
  // tab of this host carries, which the window may know as a server tab's.
  if (isServerTabRef(ref)) return NOT_SERVED
  const host = targetHost(ctx, key)
  if (ref !== 'mine' && ref !== 'parent' && !(await findTarget(host, ref))) return NOT_SERVED
  const layouts = await allLayouts(ctx, key)
  return sendToTarget(
    host,
    { ref, message: str(p.message) ?? '', resume: p.resume === true },
    {
      // A self-addressed send: logged into the transport record, delivered
      // nowhere, typed nowhere (the solo lane's checkpoint).
      checkpoint: (self, name, message) => {
        if (modeOfSession(ctx, self) === 'pi')
          throw new Error('Pi exchange capture is not supported yet')
        if (modeOfSession(ctx, self) === 'opencode')
          throw new Error('OpenCode exchange capture is not supported yet')
        const endpoint = endpointOf(ctx, self, layouts)
        if (!endpoint) throw new Error('Exchange capture is not supported yet for this harness')
        const { text, provenance } = checkpointCapture(self, name, message)
        ctx.shell.captureMessage({
          ts: new Date().toISOString(),
          sender: endpoint,
          target: endpoint,
          text,
          provenance,
          delivered: false
        })
        return true
      },
      type: async (target, text, senderName) => {
        try {
          return await ctx.api.sessions.type(target.id, text, senderName)
        } catch (err) {
          const tag = tagOf(err)
          if (tag === 'SessionNotFound') throw new Error(`No session with id or name "${ref}"`)
          if (tag === 'SessionWriteRefused')
            throw new Error((err as { message?: string }).message ?? 'The write was refused')
          throw err
        }
      },
      // The Resume the person's button makes, under the same id, the
      // conversation resumed where the provider can (PRDCT-4193).
      resume: async (target) => {
        await ctx.api.sessions.restart(target.id, {}, false, undefined, true)
      },
      capture: ({ sender, target, text, provenance, delivered }) => {
        const from = endpointOf(ctx, sender, layouts)
        const to = endpointOf(ctx, target, layouts)
        if (from && to)
          ctx.shell.captureMessage({
            ts: new Date().toISOString(),
            sender: from,
            target: to,
            text,
            provenance,
            delivered
          })
      }
    }
  )
}

// ── Accounts: the pool's rule, shared with the routines (`served-accounts.ts`) ──

const resolveAccountRef = (
  ctx: Ctx,
  provider: AccountProvider,
  ref: string | undefined,
  model?: string
): ServedPoolAccount => resolveAccountRefFrom(ctx.shell, provider, ref, model)

const providerOf = (ctx: Ctx, session: Session): AccountProvider | null => {
  const mode = modeOfSession(ctx, session)
  if (mode === 'claude' || mode === 'claude-agents') return 'claude'
  if (mode === 'codex') return 'codex'
  return null
}

async function switchAccount(ctx: Ctx, _key: string, p: Payload): Promise<unknown> {
  const ref = str(p.sessionId) ?? ''
  const id = ref === 'mine' ? ctx.callerSessionId : ref
  const session = id ? await ctx.api.sessions.get(id).catch(() => null) : null
  if (!session) throw new Error(`Unknown session "${ref}"`)
  const provider = providerOf(ctx, session)
  if (!provider) throw new Error('Only Claude and Codex tabs run on an account')
  const record = ctx.shell.record(session.id)
  const current =
    (provider === 'codex' ? record?.codexAccountId : record?.claudeProfileId) ?? 'default'
  const accountRef = str(p.account) ?? ''
  let target: { id: string; label: string }
  if (accountRef === 'any') {
    const accounts = ctx.shell.accounts(provider)
    const next = pickAccount({
      accounts: poolOf(accounts),
      usage: usageOf(accounts, { model: record?.model }),
      preferredId: current,
      leavingId: current,
      preferWeeklyHeadroom: true
    })
    if (next === current) throw new Error('No other account of this provider has headroom')
    target = accounts.find((a) => a.id === next) ?? { id: next, label: next }
  } else {
    target = resolveAccountRef(ctx, provider, accountRef)
  }
  // The tab's own mode and its pin are the window's (the person sets them in
  // the tab's menu): asked of the window holding the tab when it is live,
  // decided from the preferences when it is not. A window that does not
  // answer in time keeps the whole call, as before.
  let own: { pinned: boolean; mode: AccountSwitchMode | null } = { pinned: false, mode: null }
  if (session.windowKey && ctx.shell.windowByKey(session.windowKey)) {
    const asked = await ctx
      .requestView<{
        pinned?: boolean
        mode?: AccountSwitchMode | null
      }>(session.windowKey, 'sessionSwitchState', { sessionId: session.id }, WINDOW_FACT_TIMEOUT_MS)
      .catch(() => null)
    if (!asked) return NOT_SERVED
    own = { pinned: asked.pinned === true, mode: asked.mode ?? null }
  }
  if (own.pinned) {
    throw new Error('This tab is pinned to its account; the user can unpin it from the tab menu')
  }
  const workspaceId =
    record?.workspaceId ?? (ctx.win ? ctx.shell.workspaceOfWindow(ctx.win.id) : null)
  const mode = own.mode ?? ctx.shell.switchMode(workspaceId)
  // A proposal is something the person sees: the window's.
  if (mode === 'propose') return NOT_SERVED
  if (target.id === current) {
    return {
      sessionId: session.id,
      account: { id: target.id, label: target.label },
      resumed: true,
      switched: true,
      proposed: false
    }
  }
  let resumed: boolean
  try {
    const restarted = await ctx.api.sessions.restart(
      session.id,
      spawnFieldsOf(provider, target) as AccountOverride
    )
    resumed = restarted.resumed
  } catch (err) {
    const message = (err as { message?: string }).message
    throw new Error(message || 'The switch failed')
  }
  return {
    sessionId: session.id,
    account: { id: target.id, label: target.label },
    resumed,
    switched: true,
    proposed: false
  }
}

// ── Opening a session ──

type OpenMode = 'claude' | 'antigravity' | 'gemini' | 'codex' | 'pi' | 'opencode' | 'terminal'

async function openSession(ctx: Ctx, key: string, p: Payload): Promise<unknown> {
  // The target group first, so a bad reference fails cleanly; its window is
  // where the tab opens when the group lives in another window.
  const groupRef = str(p.groupId)
  const target = groupRef
    ? resolveGroupRef(await allLayouts(ctx, key), key, groupRef, groupOptions(ctx))
    : null
  const spawnKey = target?.windowKey ?? key
  const explicitWorkspace = str(p.workspace)
  const workspaceId = explicitWorkspace
    ? resolveWorkspace(ctx, explicitWorkspace)
    : (target?.group.workspaceId ?? workspaceForSpawn(ctx, undefined))

  if (explicitWorkspace && target?.group.workspaceId && workspaceId !== target.group.workspaceId)
    throw new Error('The group and workspace arguments name different workspaces')

  const mode = (str(p.mode) as OpenMode | undefined) ?? 'claude'
  const {
    claudeMode,
    antigravityMode,
    codexMode,
    piMode,
    opencodeMode,
    dangerousMode,
    model,
    family
  } = resolveSpawnModes({
    mode,
    ...(p.dangerous !== undefined ? { dangerous: p.dangerous === true } : {}),
    ...(str(p.model) !== undefined ? { model: str(p.model) } : {})
  })
  const profileRef = resolveProfileRef(
    {
      mode,
      ...(p.chat !== undefined ? { chat: p.chat === true } : {}),
      ...(str(p.profile) !== undefined ? { profile: str(p.profile) } : {})
    },
    // The chat the launcher would open in that workspace: the person's own
    // chat profile when they set one. Until 3 November 2026 the built-in
    // replaced it, and a wave's Codex chats asked before every command.
    family ? ctx.shell.chatDefault(family, workspaceId) : undefined,
    // An omitted `chat` follows the person's launcher (PRDCT-4425); a host
    // with no setting keeps the terminal, as before 11 November 2026.
    ctx.shell.interactionMode?.() ?? 'terminal'
  )
  const launchProfileId =
    family && profileRef
      ? ctx.shell
          .launchProfiles(family)
          .find((x) => x.id === profileRef || x.name.toLowerCase() === profileRef.toLowerCase())?.id
      : undefined
  if (profileRef && family && !launchProfileId)
    throw new Error(`Unknown ${family} launch profile "${profileRef}"`)
  const accountRef = str(p.account)
  if (accountRef && !claudeMode && !codexMode) {
    throw new Error(
      `The account argument applies to claude and codex modes only (got mode "${mode}")`
    )
  }
  // The account is judged for the model the tab will run: a Fable week
  // spent never costs a launch on Opus its account (PRDCT-4253). A launch
  // naming no model runs the one main remembers for its chat, a resumed
  // conversation its own, which nothing here knows (the shared caps judge).
  const resumeSessionId = str(p.resumeSessionId)
  const pooled: AccountProvider | null = claudeMode ? 'claude' : codexMode ? 'codex' : null
  const judgedModel =
    model ??
    (pooled && resumeSessionId === undefined
      ? ctx.shell.launchModel?.(pooled, launchProfileId, workspaceId)
      : undefined)
  const accountFields = pooled
    ? spawnFieldsOf(pooled, resolveAccountRef(ctx, pooled, accountRef, judgedModel))
    : {}
  const cwd = str(p.cwd) ?? ''
  const command = str(p.command)
  const prompt = str(p.prompt)
  const provider = str(p.provider)
  const thinking = str(p.thinking)
  let info: { id: string; folderName: string }
  try {
    info = await ctx.api.sessions.start({
      cwd,
      windowKey: spawnKey,
      options: {
        claudeMode,
        antigravityMode,
        codexMode,
        piMode,
        opencodeMode,
        dangerousMode,
        ...(model !== undefined ? { model } : {}),
        ...(launchProfileId !== undefined ? { launchProfileId } : {}),
        ...accountFields,
        // A past conversation reopened (PRDCT-4236): the History's id, for
        // the spawn's --resume (Claude), resume (Codex) or --session (Pi).
        ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
        // The mode and the effort to start at (PRDCT-4236): the caller's, or
        // the ones a resumed conversation last ran at. Bypass is the flag.
        ...launchModeFields({
          claudeMode,
          codexMode,
          dangerousMode,
          permissionMode: p.permissionMode,
          effort: p.effort,
          allowDangerous: p.allowDangerous
        }),
        ...(piMode && provider !== undefined ? { piProvider: provider } : {}),
        ...(piMode && thinking !== undefined ? { piThinking: thinking } : {}),
        ...(mode === 'terminal' && command ? { initialCommand: command } : {}),
        autoExecute: mode === 'terminal' && !!command && p.autoRun !== false,
        ...(mode !== 'terminal' && prompt ? { initialPrompt: prompt } : {}),
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        // Persisted lineage folds the tab under its caller. Separate tabs
        // keep the in-memory messaging link below without sidebar nesting.
        ...(p.attachToParent === true && ctx.callerSessionId
          ? { spawnedBy: ctx.callerSessionId }
          : {}),
        // The opener, nested or not, on the record (PRDCT-4192): what the
        // name tie-break read once this process's memory of the open is gone.
        ...(ctx.callerSessionId ? { openedBy: ctx.callerSessionId } : {})
      }
    })
  } catch (err) {
    const tag = tagOf(err)
    if (tag === 'SessionStartFailed' || tag === 'CapabilityUnavailable')
      throw new Error((err as { message?: string }).message ?? 'The session could not start')
    throw err
  }
  // Attached, the new record is the server's: read again before it is named.
  await ctx.shell.syncRecords?.()
  // The parent link for "parent": only when the open came from inside
  // another tab (an agent's delegation), never from the app's own UI.
  if (ctx.callerSessionId) ctx.shell.setParent(info.id, ctx.callerSessionId)
  const name = str(p.name)
  if (name) await ctx.api.sessions.rename(info.id, name)
  // The tab enters the window's sidebar: the first row of its group, or the
  // first row of the sidebar; the window takes it in from its record.
  await ctx.api.sidebar.placeSession({
    windowKey: spawnKey,
    sessionId: info.id,
    groupId: target?.group.id ?? null
  })
  // With no window to mount a pane, nothing would ever start the process.
  if (!ctx.shell.windowByKey(spawnKey)) {
    await ctx.api.sessions.resize(info.id, HIDDEN_COLS, HIDDEN_ROWS).catch(() => undefined)
  }
  // An agent's delegation is a transport event (PRDCT-1568), recorded with
  // its launch prompt; a terminal, a Pi and an OpenCode tab are not captured.
  if (ctx.callerSessionId && mode !== 'terminal' && mode !== 'pi' && mode !== 'opencode') {
    try {
      const layouts = await allLayouts(ctx, key)
      const [spawner, spawned] = await Promise.all([
        ctx.api.sessions.get(ctx.callerSessionId).catch(() => null),
        ctx.api.sessions.get(info.id).catch(() => null)
      ])
      const from = spawner ? endpointOf(ctx, spawner, layouts) : null
      const to = spawned ? endpointOf(ctx, spawned, layouts) : null
      if (from && to) {
        ctx.shell.captureTabSpawn({
          ts: new Date().toISOString(),
          spawner: from,
          session: to,
          prompt: prompt || null,
          model: model ?? null
        })
      }
    } catch {
      // observability only
    }
  }
  return { sessionId: info.id, groupId: target?.group.id ?? null }
}

// ── Launching a pinned group ──

/** The pin's live group, by served launch, for a window that is not there
 *  to be asked; a window's own launches are its own memory. */
const launched = new Map<string, string>()

/** The renderer's `handleLaunchGroup` resolution: an optional workspace
 *  narrows the pool; an id, an exact name, a case-insensitive name; a name
 *  in several workspaces resolves to the caller's, then the window's. */
function resolvePin(ctx: Ctx, p: Payload): PinnedBlueprint {
  const ref = str(p.group) ?? ''
  const pins = ctx.shell.pins()
  const explicit = str(p.workspace)
  const pool = explicit
    ? (() => {
        const ws = resolveWorkspace(ctx, explicit)
        return pins.filter((pin) => pin.workspaceId === ws)
      })()
    : pins
  const byId = pool.find((pin) => pin.id === ref)
  const named = byId
    ? [byId]
    : (() => {
        const exact = pool.filter((pin) => pin.name === ref)
        if (exact.length > 0) return exact
        return pool.filter((pin) => pin.name.toLowerCase() === ref.toLowerCase())
      })()
  let pin = named.length === 1 ? named[0] : undefined
  if (!pin && named.length > 1) {
    const callerWs = workspaceForSpawn(ctx, undefined)
    const inCallerWs = callerWs ? named.filter((x) => x.workspaceId === callerWs) : []
    if (inCallerWs.length === 1) pin = inCallerWs[0]
    if (!pin) {
      const activeWs = ctx.win ? ctx.shell.workspaceOfWindow(ctx.win.id) : null
      const inActiveWs = activeWs ? named.filter((x) => x.workspaceId === activeWs) : []
      if (inActiveWs.length === 1) pin = inActiveWs[0]
    }
    if (!pin) {
      const qualified = named
        .map((x) => `${workspaceNameOf(ctx, x.workspaceId) ?? '?'}/${x.name} (${x.id})`)
        .join(', ')
      throw new Error(
        `Pinned group "${ref}" is ambiguous across workspaces — pass the workspace parameter or an id. Candidates: ${qualified}`
      )
    }
  }
  if (!pin) {
    const available = pool.map((x) => x.name).join(', ') || '(none)'
    throw new Error(`No pinned group "${ref}". Available: ${available}`)
  }
  return pin
}

/** The spawn fields for a pinned session's account (ADR 0002): what the
 *  file names by label, `any` or nothing for the pool's pick. A name this
 *  Mac does not know falls back to the Default, and says so. */
function pinnedAccountFields(
  ctx: Ctx,
  session: PinnedBlueprintSession,
  groupName: string,
  pinOtherProvider: boolean,
  workspaceId: string | undefined
): AccountOverride {
  const provider: AccountProvider | null = session.codexMode
    ? 'codex'
    : session.claudeAgentsMode || (session.claudeMode && !pinOtherProvider)
      ? 'claude'
      : null
  if (!provider) return {}
  // A pinned session names no model: it starts on the one its family's
  // selected profile remembers, and its account is judged for that one, as
  // the window's pinned groups do (`pinned-store.ts`). `claude agents` runs
  // no chat, so the shared caps judge it.
  const model = session.claudeAgentsMode
    ? undefined
    : ctx.shell.launchModel?.(provider, undefined, workspaceId)
  let account: { id: string; label: string }
  try {
    account = resolveAccountRef(ctx, provider, session.account, model)
  } catch {
    const fallback = ctx.shell.accounts(provider).find((a) => a.id === 'default')
    account = fallback ?? { id: 'default', label: 'Default' }
    ctx.shell.notify(
      groupName,
      `Account "${session.account}" is not set up on this Mac: "${session.name}" starts on the Default account.`
    )
  }
  return spawnFieldsOf(provider, account)
}

/** The renderer's `resolveGroupDefaults`: the brief a later `+` starts on
 *  and where it opens, from the root session carrying a brief, then the
 *  first carrying one, then the first declared. */
function groupDefaults(pin: PinnedBlueprint): { prompt: string | null; rootSession: boolean } {
  const entry =
    pin.sessions.find((s) => s.rootSession && s.prompt) ??
    pin.sessions.find((s) => s.prompt) ??
    pin.sessions[0] ??
    null
  return { prompt: pin.prompt ?? entry?.prompt ?? null, rootSession: entry?.rootSession === true }
}

async function launchGroup(ctx: Ctx, key: string, p: Payload): Promise<unknown> {
  const pin = resolvePin(ctx, p)
  // Whether the pin is running or hidden is the window's memory: asked of
  // the routed window when it is live. A running group is answered as such;
  // a hidden one is shown by the window (NOT_SERVED); a window that does not
  // answer in time keeps the call. With no window, this process remembers
  // the launches it served.
  if (ctx.shell.windowByKey(key)) {
    const state = await ctx
      .requestView<{
        state: 'idle' | 'active-visible' | 'active-hidden'
        groupId: string | null
      }>(key, 'pinnedState', { pinnedId: pin.id }, WINDOW_FACT_TIMEOUT_MS)
      .catch(() => null)
    if (!state) return NOT_SERVED
    if (state.state === 'active-visible')
      return { pinnedId: pin.id, groupId: state.groupId, status: 'already-running' }
    if (state.state === 'active-hidden') return NOT_SERVED
  } else {
    const groupId = launched.get(pin.id)
    const layouts = groupId ? await allLayouts(ctx, key) : []
    if (groupId && layouts.some((l) => l.groups.some((g) => g.id === groupId)))
      return { pinnedId: pin.id, groupId, status: 'already-running' }
  }

  const spawned: { id: string; cwd: string }[] = []
  for (const session of pin.sessions) {
    try {
      const pinOtherProvider = !!(
        session.antigravityMode ||
        session.codexMode ||
        session.piMode ||
        session.opencodeMode ||
        session.claudeAgentsMode
      )
      const atRoot = session.rootSession === true && !!pin.workspaceRoot
      const spawnCwd = atRoot ? (pin.workspaceRoot as string) : session.cwd
      // `claude agents` is spawned bare and rejects a positional prompt; the
      // path tokens expand against the workspace root and the project dir.
      const initialPrompt = session.claudeAgentsMode
        ? undefined
        : session.prompt
          ? substituteTokens(session.prompt, pin.workspaceRoot ?? pin.rootDir ?? null, session.cwd)
          : undefined
      const info = await ctx.api.sessions.start({
        cwd: spawnCwd,
        windowKey: key,
        options: {
          claudeMode: pinOtherProvider ? false : session.claudeMode,
          antigravityMode: session.antigravityMode,
          codexMode: session.codexMode,
          ...(session.piMode !== undefined ? { piMode: session.piMode } : {}),
          ...(session.opencodeMode !== undefined ? { opencodeMode: session.opencodeMode } : {}),
          ...(session.claudeAgentsMode !== undefined
            ? { claudeAgentsMode: session.claudeAgentsMode }
            : {}),
          dangerousMode: session.dangerousMode,
          ...(initialPrompt !== undefined ? { initialPrompt } : {}),
          ...pinnedAccountFields(
            ctx,
            session,
            pin.name,
            pinOtherProvider,
            pin.workspaceId ?? undefined
          ),
          // The pin's workspace wins over the window's: a launch of a hidden
          // workspace's pin must not leak its sessions into the view.
          ...(pin.workspaceId ? { workspaceId: pin.workspaceId } : {})
        }
      })
      if (session.name !== info.folderName) {
        await ctx.api.sessions.rename(info.id, session.name).catch(() => undefined)
      }
      spawned.push({ id: info.id, cwd: info.cwd })
    } catch (err) {
      console.error(`[pinned] Failed to spawn session "${session.name}":`, err)
    }
  }
  if (spawned.length === 0) {
    throw new Error(
      `Launching "${pin.name}" spawned no sessions — check that its directories exist`
    )
  }
  const terminals = pin.terminals.map((t) => ({
    id: crypto.randomUUID(),
    command: t.command,
    commandMode: t.commandMode,
    color: t.color,
    ...(t.icon !== undefined ? { icon: t.icon } : {}),
    ...(t.cwd !== undefined ? { cwd: t.cwd } : {}),
    ...(t.autoLaunchLocalhost !== undefined ? { autoLaunchLocalhost: t.autoLaunchLocalhost } : {}),
    ...(t.serverUrl !== undefined ? { serverUrl: t.serverUrl } : {}),
    ...(t.groupView !== undefined ? { groupView: t.groupView } : {}),
    sessionId: null
  }))
  // What the person sees on clicking the group: a terminal's served page or
  // the group's own page; the shared rule owns the precedence.
  const declaredView = resolveDeclaredGroupView(terminals, pin.view ?? null, pin.name)
  const defaults = groupDefaults(pin)
  const { group } = await ctx.api.sidebar.createGroup({
    windowKey: key,
    group: {
      name: pin.name,
      sessionIds: spawned.map((s) => s.id),
      cwd: pin.cwd ?? spawned[0].cwd,
      color: pin.color ?? null,
      prompt: defaults.prompt,
      rootSession: defaults.rootSession,
      terminals,
      ...(declaredView
        ? {
            view: {
              url: declaredView.url,
              ...(declaredView.title !== undefined ? { title: declaredView.title } : {}),
              terminalId: declaredView.terminalId
            }
          }
        : {}),
      ...(pin.workspaceId ? { workspaceId: pin.workspaceId } : {})
    }
  })
  // The sessions have no pane until the window takes them in; with no
  // window, nothing else would start them.
  if (!ctx.shell.windowByKey(key)) {
    for (const s of spawned)
      await ctx.api.sessions.resize(s.id, HIDDEN_COLS, HIDDEN_ROWS).catch(() => undefined)
  }
  launched.set(pin.id, group.id)
  // The windows learn which pin this group belongs to.
  ctx.shell.publish(
    { _tag: 'pinned_group.launched', pinnedId: pin.id, groupId: group.id, windowKey: key },
    key
  )
  return { pinnedId: pin.id, groupId: group.id, status: 'launched' }
}

/** Tests only: forget the launches this process served. */
export function resetServedLaunchesForTests(): void {
  launched.clear()
}

export const sessionTools = {
  rename,
  others: { setSessionView, readSession, sendToSession, switchAccount, openSession, launchGroup }
} as const
