import { linkedDocuments } from '../linked-documents/runtime'
import { linkedOpenSchema, linkedUpdateSchema } from '../../shared/linked-documents'
import * as http from 'http'
import * as path from 'path'
import { createHash, timingSafeEqual } from 'crypto'
import { app, Notification } from 'electron'
import { TEST_NO_ACTIVATE } from '../test-mode'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { callRenderer, callRendererAll, registerMcpBridge } from './mcp-bridge'
import { windowRegistry } from '../window-registry'
import { focusedOrPrimaryWindow, bringForward } from '../window-routing'
import { workspaceManager } from '../workspace-manager'
import { moveSessionsToWindow, awaitRehomed } from '../ipc-handlers/window-handlers'
import {
  loadOrCreateServerState,
  saveServerState,
  setMcpRuntime,
  resolveSessionByToken,
  rebuildSessionTokens,
  countStaleSessionConfigs
} from './mcp-runtime'
import {
  createRequest,
  getRequest,
  waitForOutcome,
  type SecretAction,
  type SecretRequest
} from '../secret-request-manager'
import { createOffer } from '../copy-offer-manager'

const MCP_PATH = '/mcp'

// MCP server instructions are TRUNCATED BY THE HOST at ~2048 characters: whatever
// sits past that is invisible to every agent, with no error and no symptom. Measured
// 2026-09-08, when this block ran to 4242 chars and half the tools were unreachable.
// KEEP THIS STRING UNDER 2000 CHARACTERS, and put the tool an agent must not miss
// near the top. Anything longer belongs in a tool description, not here.
const INSTRUCTIONS = `You are running inside Clave, a Mac app that runs agent sessions as tabs in sidebar groups. You are one of those tabs. Tabs and groups belong to a WORKSPACE (a root folder) and live in the WINDOW they were opened in; address any tab by session id or name and Clave routes the call. What you open lands in your own window unless you pass window or workspace. Pass "mine" as a sessionId or groupId to mean your own.

Reach for a clave_* tool when:
- the user will REVIEW, EDIT or MODIFY something you drafted (a document, a plan, an email) -> clave_open_side_panel opens it in an editor beside your tab, two panes; clave_side_panel then reads, updates, prepares and sends it. That is what "open it in the panel" means. clave_open_file is not.
- they only need to READ a file -> clave_open_file (a tab; .html renders live).
- a live page belongs to a group or a tab -> clave_set_group_view / clave_set_session_view (dashboard, preview, dev server).
- work could run in parallel -> clave_open_session (a fresh agent tab: claude, codex, antigravity, pi or a plain terminal, any directory, optional prompt and model) or clave_add_group_terminal (a saved command such as a dev server). clave_launch_group starts a pinned .clave template.
- you need a secret -> clave_request_secret. Never ask for one in the chat.
- the user must copy something you produced -> clave_offer_copy (a copy button, exact bytes).
- long work finished -> clave_notify.
- tabs must talk -> clave_send_to_session (target "parent" to report back to the tab that opened yours; your own id logs a checkpoint) and clave_read_session (read a tab's recent output without interrupting it).

Also: clave_list (windows, tabs, groups, pinned templates), clave_create_group, clave_move_session, clave_rename, clave_focus, clave_close_session, clave_open_window, clave_switch_workspace (only when the user should look at another workspace). Pi tabs can be messaged and read but cannot call these tools.`

let httpServer: http.Server | null = null
let serverToken: string | null = null

/**
 * Authenticate a request and, crucially, DERIVE the caller's tab identity from
 * the presented token — never from a client-supplied header. A per-session
 * token maps to exactly one tab (that tab can't forge another's identity); the
 * shared discovery token authenticates but stays anonymous (no tab identity,
 * so the identity-gated tools refuse it).
 */
function authenticate(authHeader: string | undefined): { ok: boolean; callerSessionId?: string } {
  if (!authHeader?.startsWith('Bearer ')) return { ok: false }
  const presented = authHeader.slice('Bearer '.length)
  const sessionId = resolveSessionByToken(presented)
  if (sessionId) return { ok: true, callerSessionId: sessionId }
  if (serverToken) {
    // Hash both sides so timingSafeEqual gets equal-length buffers.
    const a = createHash('sha256').update(presented).digest()
    const b = createHash('sha256').update(serverToken).digest()
    if (timingSafeEqual(a, b)) return { ok: true }
  }
  return { ok: false }
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
      } catch (err) {
        reject(err as Error)
      }
    })
    req.on('error', reject)
  })
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Commands whose SUBJECT is an existing session — they must run in the window
 *  hosting that session (its renderer holds the tab). §3.8 rule 1. */
const SUBJECT_SESSION_COMMANDS = new Set([
  'sendToSession',
  'readSession',
  'closeSession',
  'focus',
  'rename',
  'moveSession',
  'setSessionView'
])

/** A workspace ref (id or name) → its id, main-side (the registry is global). */
function resolveWorkspaceIdMain(ref: string): string | null {
  const ws = workspaceManager.getWorkspaces()
  return (
    ws.find((w) => w.id === ref)?.id ??
    ws.find((w) => w.name === ref)?.id ??
    ws.find((w) => w.name.toLowerCase() === ref.toLowerCase())?.id ??
    null
  )
}

/** Find the one window whose renderer store holds a session named/ided `ref`.
 *  Names can collide across windows the same way they can within one, so the
 *  resolve verb returns qualified candidates and this rejects an ambiguous
 *  ref rather than guessing (the same contract the in-window resolver uses). */
async function windowForSessionRef(ref: string): Promise<BrowserWindowLike | null> {
  const replies = await callRendererAll<{ found: boolean; sessionId?: string; name?: string }>(
    'resolveSessionRef',
    { ref }
  )
  const hits = replies
    .filter((r) => r.ok && r.result?.found)
    .map((r) => ({ windowId: r.windowId, sessionId: r.result!.sessionId!, name: r.result!.name! }))
  if (hits.length === 0) return null
  if (hits.length > 1) {
    throw new Error(
      `Session "${ref}" is ambiguous across windows — use a session id. Candidates: ${hits
        .map((h) => `${h.name} (${h.sessionId})`)
        .join(', ')}`
    )
  }
  return windowRegistry.getWindow(hits[0].windowId)
}

type BrowserWindowLike = ReturnType<typeof windowRegistry.getWindow>

/** The `window` tool argument → a live window, or null when absent. An
 *  unknown id is an error, never a silent fallback to another window. */
function resolveWindowArg(arg: unknown, callerSessionId: string | undefined): BrowserWindowLike {
  if (arg === undefined || arg === null) return null
  if (arg === 'mine') {
    const own = callerSessionId ? windowRegistry.getWindowForSession(callerSessionId) : null
    if (!own)
      throw new Error('window "mine" needs a calling tab — this request has no tab identity')
    return own
  }
  const id = typeof arg === 'number' ? arg : Number(arg)
  const win = Number.isInteger(id) ? windowRegistry.getWindow(id) : null
  if (!win)
    throw new Error(`No open Clave window with id ${String(arg)} — clave_list shows the windows`)
  return win
}

/** Resolve which window's renderer executes a command, BEFORE dispatch. */
async function resolveCommandWindow(
  command: string,
  payload: Record<string, unknown> | null,
  callerSessionId: string | undefined
): Promise<BrowserWindowLike> {
  const p = payload ?? {}
  // Rule 1 — the command's subject is a session.
  if (SUBJECT_SESSION_COMMANDS.has(command) && typeof p.sessionId === 'string') {
    const ref = p.sessionId
    const subjectId = ref === 'mine' ? callerSessionId : ref
    if (subjectId && UUID_RE.test(subjectId)) {
      const bySession = windowRegistry.getWindowForSession(subjectId)
      if (bySession) return bySession
    }
    // A NAME (not a UUID, not mine/parent) may be hosted in another window —
    // resolve it across the partitioned stores rather than erroring in the
    // caller's window (a real cross-workspace workflow: tabs message by name).
    if (ref !== 'mine' && ref !== 'parent' && !(subjectId && UUID_RE.test(subjectId))) {
      const byRef = await windowForSessionRef(ref)
      if (byRef) return byRef
    }
    // 'parent' / 'mine' / an unresolved ref fall to the caller's window (rule 3).
  }
  // Rule 2 — an explicit `window` argument: a window id from clave_list, or
  // "mine" for the caller's own. Any window may open work in any workspace,
  // so the workspace argument never picks a window.
  const named = resolveWindowArg(p.window, callerSessionId)
  if (named) return named
  // Rule 3 — the caller's own hosting window.
  if (callerSessionId) {
    const callerWin = windowRegistry.getWindowForSession(callerSessionId)
    if (callerWin) return callerWin
  }
  // Rule 4 — windowless caller: focused, else primary.
  return focusedOrPrimaryWindow()
}

/** Deduplicate a list of objects by their `id`, keeping the first seen. */
function dedupeById<T extends { id?: unknown }>(items: T[]): T[] {
  const seen = new Set<unknown>()
  const out: T[] = []
  for (const item of items) {
    const id = item?.id
    if (typeof id === 'string') {
      if (seen.has(id)) continue
      seen.add(id)
    }
    out.push(item)
  }
  return out
}

/** `clave_list`: dispatch to every window and merge. Each window reports its
 *  own tabs and groups (a tab lives in exactly one window), so the arrays
 *  concatenate; a dedupe by id keeps "every live session exactly once" true
 *  even during the brief moment a move leaves a session in two stores. Every
 *  session and group is annotated with the window it lives in, and the
 *  listing carries the windows themselves. The per-window scalars
 *  (workspaces, active, focused, caller) come from the caller's own window
 *  — for a windowless caller, the focused or primary one. The scope
 *  "active" is the CALLER's window's workspace, resolved here so every
 *  window filters on the same id. */
async function aggregateList(
  payload: Record<string, unknown>,
  callerSessionId: string | undefined
): Promise<unknown> {
  const callerWin =
    (callerSessionId ? windowRegistry.getWindowForSession(callerSessionId) : null) ??
    focusedOrPrimaryWindow()
  const scope = typeof payload.workspace === 'string' ? payload.workspace : 'all'
  const scoped =
    scope === 'active'
      ? {
          ...payload,
          workspace: (callerWin && windowRegistry.getWorkspaceForWindow(callerWin.id)) ?? 'all'
        }
      : payload
  const replies = await callRendererAll<Record<string, unknown>>('list', scoped)
  const ok = replies
    .filter((r) => r.ok && r.result)
    .map((r) => ({ windowId: r.windowId, r: r.result! }))
  if (ok.length === 0) {
    const firstErr = replies.find((r) => !r.ok)?.error
    throw new Error(firstErr ?? 'Clave window not available')
  }
  const base = (callerWin ? ok.find((o) => o.windowId === callerWin.id)?.r : undefined) ?? ok[0].r
  const arr = (
    o: { windowId: number; r: Record<string, unknown> },
    k: string
  ): { id?: unknown }[] =>
    Array.isArray(o.r[k])
      ? (o.r[k] as { id?: unknown }[]).map((x) => ({ ...x, windowId: o.windowId }))
      : []
  const windows = windowRegistry.listWindows().map((w) => {
    const identity = windowRegistry.identityOf(w.id)
    const ws = identity?.workspaceId ?? null
    return {
      id: w.id,
      workspaceId: ws,
      workspaceName: ws
        ? (workspaceManager.getWorkspaces().find((x) => x.id === ws)?.name ?? null)
        : null,
      isPrimary: identity?.isPrimary ?? false,
      focused:
        !!windowRegistry.resolveTargetWindow({}) &&
        windowRegistry.resolveTargetWindow({})?.id === w.id,
      mine: !!callerWin && callerWin.id === w.id
    }
  })
  return {
    ...base,
    windows,
    callerWindowId: callerWin?.id ?? null,
    sessions: dedupeById(ok.flatMap((o) => arr(o, 'sessions'))),
    groups: dedupeById(ok.flatMap((o) => arr(o, 'groups'))),
    // Pins are per workspace and global: every window holds the same list.
    pinnedGroups: dedupeById(
      ok.flatMap((o) =>
        Array.isArray(o.r.pinnedGroups) ? (o.r.pinnedGroups as { id?: unknown }[]) : []
      )
    )
  }
}

/** Main's "open a new window", injected by the entry (index.ts owns
 *  createWindow; importing it here would be a cycle). */
let windowOpener: ((workspaceId: string | null) => { windowId: number }) | null = null

export function registerMcpWindowOpener(
  fn: (workspaceId: string | null) => { windowId: number }
): void {
  windowOpener = fn
}

/** `clave_open_window`: a new window on the given workspace, else on the
 *  caller's own (the app once more, where you are). */
function openWindowFromTool(
  p: Record<string, unknown>,
  callerSessionId: string | undefined
): { windowId: number; workspaceId: string | null } {
  if (!windowOpener) throw new Error('Clave cannot open windows yet')
  let workspaceId: string | null
  if (typeof p.workspace === 'string' && p.workspace.length > 0) {
    workspaceId = resolveWorkspaceIdMain(p.workspace)
    if (!workspaceId) throw new Error(`Unknown workspace "${p.workspace}"`)
  } else {
    const own =
      (callerSessionId ? windowRegistry.getWindowForSession(callerSessionId) : null) ??
      focusedOrPrimaryWindow()
    workspaceId =
      (own ? windowRegistry.getWorkspaceForWindow(own.id) : null) ??
      workspaceManager.resolveInitialWorkspaceId()
  }
  const { windowId } = windowOpener(workspaceId)
  return { windowId, workspaceId }
}

/** Run a renderer command and wrap the outcome as an MCP tool result. The
 *  target window is resolved first (§3.8): with several windows the sidebar
 *  state is partitioned by hosting, so the command runs where its subject —
 *  or its caller — lives. `caller` is the token-derived identity of the
 *  calling tab and drives the routing for EVERY tool; the payload's own
 *  `callerSessionId` (forwarded only by the identity-gated tools) is what the
 *  renderer handlers read, and is the fallback for a call with no `caller`. */
async function runCommand(command: string, payload: unknown, caller?: string): Promise<ToolResult> {
  try {
    const p = (payload ?? {}) as Record<string, unknown>
    const callerSessionId =
      caller ?? (typeof p.callerSessionId === 'string' ? p.callerSessionId : undefined)
    let result: unknown
    if (command === 'list') {
      result = await aggregateList(p, callerSessionId)
    } else if (command === 'openWindow') {
      result = openWindowFromTool(p, callerSessionId)
    } else {
      const win = await resolveCommandWindow(command, p, callerSessionId)
      // A move INTO another window: the session travels first (detach +
      // re-adopt there, id preserved), then the group placement runs where
      // it now lives.
      if (command === 'moveSession' && typeof p.sessionId === 'string' && p.window !== undefined) {
        const subjectId = p.sessionId === 'mine' ? callerSessionId : p.sessionId
        const target = resolveWindowArg(p.window, callerSessionId)
        if (subjectId && UUID_RE.test(subjectId) && target && target.id !== win?.id) {
          // The waiter is registered BEFORE the move: the ack can only ever
          // answer this wait, never a stale one (rehome-ack.ts).
          const adopted = awaitRehomed([subjectId])
          const outcome = moveSessionsToWindow([subjectId], target.id)
          const refused = outcome.refused.find((r) => r.sessionId === subjectId)
          if (refused) {
            throw new Error(
              refused.reason === 'not-tmux'
                ? 'This session is not tmux-backed and cannot move between windows'
                : `Session ${subjectId} is not live`
            )
          }
          await adopted
          result = await callRenderer<unknown>(command, { ...p, sessionId: subjectId }, target)
          return { content: [{ type: 'text', text: JSON.stringify(result ?? { ok: true }) }] }
        }
      }
      result = await callRenderer<unknown>(command, payload, win)
      // Focusing a tab that lives in another window means the user should
      // SEE it: bring that window forward (inert under --test-no-activate).
      if (command === 'focus' && win) bringForward(win)
    }
    return { content: [{ type: 'text', text: JSON.stringify(result ?? { ok: true }) }] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: message }], isError: true }
  }
}

/**
 * Build a per-request McpServer. Stateless mode: a fresh server + transport
 * per POST keeps request ids isolated and needs no MCP-session bookkeeping.
 * `callerSessionId` is derived server-side from the caller's per-session token
 * (see authenticate) — it identifies which tab is calling and can't be forged.
 */
function buildServer(callerSessionId: string | undefined): McpServer {
  const server = new McpServer(
    { name: 'clave', version: app.getVersion() },
    { instructions: INSTRUCTIONS }
  )
  // Every tool routes on the authenticated caller (rule 3 needs it even for
  // tools whose payload does not carry callerSessionId, e.g. focus/rename/
  // switchWorkspace — otherwise they silently fall to the primary window).
  const run = (command: string, args: unknown): Promise<ToolResult> =>
    runCommand(command, args, callerSessionId)
  const windowArg = z
    .union([z.number().int(), z.literal('mine')])
    .optional()
    .describe(
      'Window to land in: a window id from clave_list, or "mine" (the default — your own tab\'s window).'
    )

  server.registerTool(
    'clave_list',
    {
      description:
        'List the open Clave windows (id, workspace, which is yours), the registered workspaces (root folders; each window shows one and scopes what the user sees in it), all groups and sessions (tabs) currently open across every window, plus the pinned workspace groups (launchable templates from .clave files, with their state: idle / active-visible / active-hidden), the focused session, and — when called from inside a Clave tab — which session/group/window is yours. Sessions and groups are annotated with their workspaceId/workspaceName and the windowId they live in; a Claude session also carries its account ({ id, label }, the subscription it runs on).',
      inputSchema: {
        workspace: z
          .string()
          .optional()
          .describe(
            'Scope the listing: "all" (default), "active" (your own window\'s workspace), or a workspace id/name. Hidden workspaces\' sessions keep running — "all" shows everything.'
          )
      }
    },
    (args) => run('list', { ...args, callerSessionId })
  )

  server.registerTool(
    'clave_create_group',
    {
      description:
        'Create a new (empty) group in the Clave sidebar. Returns the new groupId. Follow up with clave_open_session to put a tab in it — some interactions prune empty groups.',
      inputSchema: {
        name: z.string().describe('Display name for the group'),
        prompt: z
          .string()
          .optional()
          .describe(
            "Default prompt for the group: sessions launched from the group's own + button start on it, so a whole lane shares one starting brief. Agent sessions only."
          ),
        workspace: z
          .string()
          .optional()
          .describe(
            "Workspace (id or name) the group belongs to. Default: your own tab's workspace, else the active one."
          ),
        window: windowArg
      }
    },
    (args) => run('createGroup', { ...args, callerSessionId })
  )

  server.registerTool(
    'clave_open_session',
    {
      description:
        'Open a new tab in Clave: a Claude Code, Antigravity, Codex, or Pi session, or a plain terminal, in the given directory. Optionally place it in a group — pass a groupId, an exact group name, or "mine" for the calling tab\'s own group. Returns { sessionId, groupId }.',
      inputSchema: {
        cwd: z.string().describe('Absolute path of the working directory for the new session'),
        mode: z
          // 'gemini' is kept as a deprecated alias (the Gemini CLI was retired
          // and folded into Antigravity); it maps to an antigravity session.
          .enum(['claude', 'antigravity', 'gemini', 'codex', 'pi', 'terminal'])
          .default('claude')
          .describe('Which agent CLI to start, or terminal for a plain shell'),
        groupId: z
          .string()
          .optional()
          .describe('Target group: a group id, an exact group name, or "mine"'),
        name: z.string().optional().describe('Display name for the new tab'),
        dangerous: z
          .boolean()
          .optional()
          .describe(
            'Start the agent without approval prompts: claude with --dangerously-skip-permissions, codex with --yolo. Ignored for antigravity, pi and terminal.'
          ),
        model: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            'Model the new agent starts on: an alias ("opus", "sonnet", "haiku") or a full model id ("claude-fable-5"). claude, codex and pi modes only; omitted = the launch profile\'s default, else the CLI\'s. The user can still switch later with /model inside the tab.'
          ),
        profile: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe('Named local launch profile id or name. Omit to use the workspace default.'),
        account: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe(
            'Claude account (subscription) the new tab runs on: an account id or its exact name as set in Settings → Usage → Claude accounts ("default" is the machine login). claude mode only. Omit to use the account selected in settings. Unknown names error with the list. clave_list reports each session\'s account.'
          ),
        provider: z.string().min(1).max(200).optional().describe('Pi provider id. Pi mode only.'),
        thinking: z
          .enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
          .optional()
          .describe('Pi thinking level. Pi mode only.'),
        command: z
          .string()
          .optional()
          .describe('Terminal mode only: a shell command to run in the new terminal'),
        autoRun: z
          .boolean()
          .optional()
          .describe(
            'Terminal mode only: execute the command immediately (default true); false just prefills it'
          ),
        prompt: z
          .string()
          .optional()
          .describe('Agent modes only: an initial prompt the agent starts working on immediately'),
        workspace: z
          .string()
          .optional()
          .describe(
            "Workspace (id or name) the new tab belongs to — lets you open work in another workspace WITHOUT switching the user's view. Default: the target group's workspace, else your own tab's, else the active one."
          ),
        window: windowArg
      }
    },
    (args) => run('openSession', { ...args, callerSessionId })
  )

  server.registerTool(
    'clave_launch_group',
    {
      description:
        'Launch a pinned workspace group (a template from a .clave file): spawns all its sessions and attaches its quick-launch terminals as one group. If the group is already running but hidden, it is shown instead. Use clave_list to see the available pinned groups and their state. A name existing in several workspaces resolves to your own workspace first, then the active one; still-ambiguous names error with qualified candidates.',
      inputSchema: {
        group: z.string().describe('Pinned group id or name (case-insensitive)'),
        workspace: z
          .string()
          .optional()
          .describe('Restrict the lookup to one workspace (id or name)'),
        window: windowArg
      }
    },
    (args) => run('launchGroup', { ...args, callerSessionId })
  )

  server.registerTool(
    'clave_switch_workspace',
    {
      description:
        "Switch YOUR WINDOW's active workspace — that window's whole visible world (sidebar sessions, groups, templates, toolbar) flips to that workspace; hidden workspaces' sessions keep running, other windows are untouched. Prefer opening background work with clave_open_session's workspace parameter, or another window with clave_open_window; switch only when the user should actually look at the other workspace here.",
      inputSchema: {
        workspace: z.string().describe('Workspace id or name to activate')
      }
    },
    (args) => run('switchWorkspace', args)
  )

  server.registerTool(
    'clave_move_session',
    {
      description:
        'Move an existing Clave tab into a group, or out of its group with "root" — and, with window, into another WINDOW (tmux-backed tabs only: the tab keeps its id and scrollback). Use this instead of closing and recreating a session. Note: moving the last tab out of a group deletes that group (including its quick-launch terminal configs).',
      inputSchema: {
        sessionId: z.string().describe('Id of the session to move'),
        groupId: z
          .string()
          .describe(
            'Target: a group id, an exact group name, "mine" for the calling tab\'s group, or "root" to ungroup'
          ),
        window: z
          .union([z.number().int(), z.literal('mine')])
          .optional()
          .describe(
            'Window to move the tab INTO (a window id from clave_list, or "mine"); the group is then resolved in that window. Omit to stay in its window.'
          )
      }
    },
    (args) => run('moveSession', { ...args, callerSessionId })
  )

  server.registerTool(
    'clave_add_group_terminal',
    {
      description:
        'Attach a quick-launch terminal to a Clave group: a saved shell command (e.g. a dev server) shown as a colored icon on the group, re-runnable on click. By default it also launches right away. Returns { terminalId, groupId, sessionId }.',
      inputSchema: {
        groupId: z.string().describe('Target group: a group id, an exact group name, or "mine"'),
        command: z.string().describe('Shell command this terminal runs, e.g. "npm run dev"'),
        commandMode: z
          .enum(['prefill', 'auto'])
          .default('auto')
          .describe('auto = run the command on launch; prefill = type it but wait for Enter'),
        color: z
          .enum(['black', 'green', 'teal', 'blue', 'purple', 'yellow', 'pink', 'red'])
          .default('green')
          .describe('Icon color'),
        icon: z
          .enum([
            'terminal',
            'fire',
            'bolt',
            'rocket',
            'eye',
            'globe',
            'cube',
            'heart',
            'star',
            'user',
            'shield',
            'wrench',
            'beaker',
            'cpu',
            'signal',
            'bug',
            'sparkles',
            'cloud'
          ])
          .default('terminal')
          .describe('Icon shown on the group'),
        cwd: z.string().optional().describe("Working directory; defaults to the group's directory"),
        serverUrl: z
          .string()
          .optional()
          .describe(
            'Declared dev-server URL (e.g. "http://localhost:3000") for commands that serve one. On toolbar server buttons this enables probe-first "ensure running, then open"; with groupView it becomes the page shown when the user clicks the group.'
          ),
        groupView: z
          .boolean()
          .optional()
          .describe(
            "Requires serverUrl: also attach that URL as the group's web view — clicking the group then shows the served page in the main pane instead of the tiled sessions, with a start-server action bound to this terminal. Same binding as clave_set_group_view with a terminalId."
          ),
        launch: z
          .boolean()
          .optional()
          .describe('Launch the terminal immediately (default true); false just saves the config'),
        window: windowArg
      }
    },
    (args) => run('addGroupTerminal', { ...args, callerSessionId })
  )

  server.registerTool(
    'clave_set_group_view',
    {
      description:
        'Attach a web view to a Clave group: the page the user sees in the main pane when they click the group, instead of the tiled session mosaic. Point it at a local dev server (a live dashboard, a docs site, a design preview — e.g. a workstream viewer or a Slideless dev server) or at an absolute .html file path rendered in-app. Optionally link the group terminal that serves the URL (terminalId from clave_add_group_terminal) so a down server shows a one-click start action. Attaching never switches what the user is currently looking at — they see the view on their next group click. Pass url: null to detach. Returns { groupId, view }.',
      inputSchema: {
        groupId: z.string().describe('Target group: a group id, an exact group name, or "mine"'),
        url: z
          .string()
          .nullable()
          .describe(
            'What the view shows: an http(s) URL (typically a localhost dev server) or an absolute path to an .html file. null detaches the view.'
          ),
        title: z
          .string()
          .optional()
          .describe("Short label shown in the view's header (defaults to the group name)"),
        terminalId: z
          .string()
          .optional()
          .describe(
            'Id of the group terminal whose command serves this URL — powers the "start server" action when the URL is down'
          )
      }
    },
    (args) => run('setGroupView', { ...args, callerSessionId })
  )

  server.registerTool(
    'clave_set_session_view',
    {
      description:
        'Attach a web view to a single Clave session (tab): a dashboard icon appears on the session\'s row in the sidebar, and clicking it shows the page in the main pane — clicking the row itself still shows the terminal. The groupless counterpart of clave_set_group_view, for a page belonging to ONE tab (e.g. a fast-lane workstream dashboard). Point it at an http(s) URL or an absolute .html file path. Pass `command` (http(s) URLs only) to have Clave spawn a hidden serving terminal immediately — it launches at attach, and its command doubles as the view\'s one-click start action when the server is down (after an app restart, say). The serving terminal is invisible in the sidebar and dies with its session. Attaching never switches what the user is looking at. Pass url: null to detach (the serving terminal is killed). Pass sessionId "mine" to attach to your own tab. Returns { sessionId, view }.',
      inputSchema: {
        sessionId: z.string().describe('Target session id, or "mine" for the calling tab'),
        url: z
          .string()
          .nullable()
          .describe(
            'What the view shows: an http(s) URL (typically a localhost dev server) or an absolute path to an .html file. null detaches the view and kills the serving terminal.'
          ),
        title: z
          .string()
          .optional()
          .describe("Short label shown in the view's header (defaults to the session name)"),
        command: z
          .string()
          .optional()
          .describe(
            'Shell command that serves the URL (e.g. "exos workstream open acme 2026-08-23-x --port 4740"). Spawned hidden at attach; also the start action when the URL probes down. http(s) URLs only.'
          ),
        cwd: z
          .string()
          .optional()
          .describe("Working directory for command (defaults to the session's cwd)")
      }
    },
    (args) => run('setSessionView', { ...args, callerSessionId })
  )

  server.registerTool(
    'clave_close_session',
    {
      description: 'Close a Clave tab and terminate its underlying process.',
      inputSchema: { sessionId: z.string().describe('Id of the session to close') }
    },
    // callerSessionId rides along so the close is recorded with its closer.
    (args) => run('closeSession', { ...args, callerSessionId })
  )

  server.registerTool(
    'clave_rename',
    {
      description: 'Rename a Clave group or session (tab).',
      inputSchema: {
        target: z.enum(['group', 'session']),
        id: z.string().describe('Group or session id'),
        name: z.string().describe('New display name')
      }
    },
    (args) => run('rename', args)
  )

  server.registerTool(
    'clave_focus',
    {
      description: 'Focus a Clave tab (bring it to the foreground in the app).',
      inputSchema: { sessionId: z.string().describe('Id of the session to focus') }
    },
    (args) => run('focus', args)
  )

  server.registerTool(
    'clave_send_to_session',
    {
      description:
        'Send a message to another agent tab (claude, antigravity, or codex): the text is typed into that tab\'s input under a provenance header naming your tab, then submitted. If the target agent is mid-task, the message queues as its next turn. Use it to report results back to the tab that opened yours (target "parent"), or to coordinate with a sibling. Addressed to your OWN tab ("mine", your own id, or your own name), it becomes a CHECKPOINT instead: nothing is delivered or typed anywhere — the message is only logged into the transport record as an internal note (exos workstream capture lands it), so a solo lane leaves a narrative. Write checkpoints headline-first with the exos lane vocabulary (ASSIGNMENT, EXPLORATION DONE, GATES GREEN, VERDICT, MERGED, LANE DONE…) so exos workstream stats derives the lane phases. Refused for plain terminals (typed text would run as a shell command).',
      inputSchema: {
        sessionId: z
          .string()
          .describe(
            'Target: a session id, an exact tab name, "parent" (the tab whose agent opened yours via clave_open_session), or "mine" / your own id to log a checkpoint instead of delivering. "mine" always means the caller: a tab literally named "mine" is reachable by id only.'
          ),
        message: z
          .string()
          .min(1)
          .max(8000)
          .describe('The message, delivered verbatim under the provenance header')
      }
    },
    (args) => run('sendToSession', { ...args, callerSessionId })
  )

  server.registerTool(
    'clave_read_session',
    {
      description:
        "Read the last N rendered lines of a tab's terminal without interrupting it — check what a delegated agent is doing, read a dev server's logs, or inspect a sibling's state. Works for any tab, plain terminals included. Returns scrollback for normal-buffer output (most CLIs, including claude/codex inline); for a full-screen/alternate-screen program (e.g. a pager or a TUI that took over the screen) it returns only the currently visible screen, so a large `lines` value may come back shorter. Target by session id, exact tab name, or \"parent\".",
      inputSchema: {
        sessionId: z.string().describe('Target: a session id, an exact tab name, or "parent"'),
        lines: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(100)
          .describe('How many trailing lines to return (default 100)')
      }
    },
    (args) => run('readSession', { ...args, callerSessionId })
  )

  server.registerTool(
    'clave_open_side_panel',
    {
      description:
        'THE tool for "open the panel", "open it beside this session", "let me review/edit/modify that draft": opens a Markdown/HTML file or a structured email in a SIDE PANEL beside YOUR calling session, two panes, focused immediately, and the user edits it there. Prefer it over clave_open_file whenever the user will change what you wrote — clave_open_file is a read-only-ish tab elsewhere in the window, not the panel. Pass exactly one of path or email; email takes to/cc/subject/bodyHtml/threadId and makes this a full composer. Files and attachments must use absolute paths. Signatures support text, links, tables and inline styling; local/data/HTTPS images are staged when signaturePath imports an HTML file. Reopening a path preserves edits. Then use clave_side_panel to read/update/prepare/send. Never send without an explicit user instruction.',
      inputSchema: linkedOpenSchema
    },
    async (args) => {
      if (!callerSessionId)
        return {
          content: [{ type: 'text' as const, text: 'Requires an authenticated Clave session' }],
          isError: true
        }
      return run('openLinkedDocument', { callerSessionId, input: args })
    }
  )
  server.registerTool(
    'clave_side_panel',
    {
      description:
        'Companion to clave_open_side_panel: work on the document or email now open in YOUR side panel. Read it, update it with the expected revision, prepare an immutable email package, or send a prepared package via Gmail. Read returns exact current content. Revision conflicts require reading again, never overwriting user edits. Prepare is NOT send. Send ONLY after explicit user instruction, with the returned packageId and userConfirmed=true. Do not reconstruct MIME. Sent/failed/unknown results are persisted; never automatically retry an unknown result or create duplicate revisions to bypass delivery guards.',
      inputSchema: {
        action: z.enum(['read', 'update', 'prepare', 'send']),
        revision: z.number().int().positive().optional(),
        update: linkedUpdateSchema.optional(),
        packageId: z.string().optional(),
        userConfirmed: z.boolean().optional()
      }
    },
    async (args) => {
      try {
        if (!callerSessionId) throw new Error('Requires an authenticated Clave session')
        const owner = windowRegistry.getWindowForSession(callerSessionId)
        if (!owner) throw new Error('Calling session window unavailable')
        await callRenderer('flushLinkedDocument', { sessionId: callerSessionId }, owner)
        const store = linkedDocuments(),
          doc = store.current(callerSessionId)
        let result: unknown
        if (args.action === 'read') result = doc
        else if (args.action === 'update') {
          if (args.revision === undefined || !args.update)
            throw new Error('revision and update required')
          result = await store.update(doc.id, args.revision, args.update, callerSessionId)
        } else if (args.action === 'prepare') {
          if (args.revision === undefined) throw new Error('revision required')
          const pkg = await store.prepare(doc.id, args.revision, callerSessionId)
          result = {
            packageId: pkg.id,
            revision: pkg.revision,
            sha256: pkg.sha256,
            messageId: pkg.messageId
          }
        } else {
          if (!args.packageId || args.userConfirmed !== true)
            throw new Error('Explicit user instruction required: packageId and userConfirmed=true')
          result = await store.send(args.packageId, callerSessionId)
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
      } catch (error) {
        return {
          content: [
            { type: 'text' as const, text: error instanceof Error ? error.message : String(error) }
          ],
          isError: true
        }
      }
    }
  )

  server.registerTool(
    'clave_open_file',
    {
      description:
        'Open a file as a tab in Clave for the user to READ — e.g. to present a document, plan, report, or HTML page you produced. If the user is going to edit or revise it (a draft, an email, anything they asked to "review", "modify", or see "in the panel"), use clave_open_side_panel instead: this tool opens a separate tab, not the editor beside your session. Idempotent: opening an already-open file focuses its existing tab. Text files render with editing; markdown renders formatted; .html files render as a live page by default (a Rendered ⇄ Source toggle sits in the tab header).',
      inputSchema: {
        path: z
          .string()
          .describe("File path — absolute, or relative to the calling tab's working directory"),
        name: z
          .string()
          .optional()
          .describe('Display name for the tab (defaults to the file name)'),
        view: z
          .enum(['rendered', 'source'])
          .optional()
          .describe(
            'How an .html/.htm file opens: "rendered" shows the live page (the default for HTML), "source" the code editor. Ignored for other file types.'
          ),
        window: windowArg
      }
    },
    (args) => run('openFile', { ...args, callerSessionId })
  )

  server.registerTool(
    'clave_open_window',
    {
      description:
        "Open a NEW Clave window — the whole app once more, on a workspace. Defaults to your own window's workspace (a second view of the same workspace, its own sidebar); pass workspace to open another one without switching the user's view here. Returns { windowId, workspaceId }; use the windowId as the window parameter of clave_open_session / clave_create_group / clave_launch_group / clave_move_session to put work in it.",
      inputSchema: {
        workspace: z
          .string()
          .optional()
          .describe("Workspace (id or name) the new window opens on. Default: your own window's.")
      }
    },
    (args) => run('openWindow', { ...args, callerSessionId })
  )

  server.registerTool(
    'clave_notify',
    {
      description:
        'Show a native macOS notification to the user — use when finishing long-running work in a tab the user may not be watching. Clicking the notification focuses the given tab. Suppressed while the Clave window is focused (the returned status says whether it was shown).',
      inputSchema: {
        title: z.string().describe('Notification title'),
        body: z.string().describe('Notification body text'),
        sessionId: z
          .string()
          .optional()
          .describe('Tab to focus when the notification is clicked (defaults to the calling tab)')
      }
    },
    (args) => run('notify', { ...args, callerSessionId })
  )

  server.registerTool(
    'clave_request_secret',
    {
      description:
        'Ask the user for a sensitive value (API key, token) WITHOUT it ever entering the conversation. Clave shows the user your description and the exact action for review, with a private masked input. For "run" actions the command MUST reference the secret only via the env var (e.g. gh secret set MY_KEY --body "$SECRET") and MUST NOT contain the value itself. For "env-file" actions Clave natively upserts KEY=value in the file (no shell). The secret value is never returned to you; command output comes back with the secret redacted. If the result is {status:"pending"}, the user has not acted yet — poll clave_secret_result with the requestId.',
      inputSchema: {
        description: z
          .string()
          .describe(
            'Human-readable explanation of what secret is needed and why — shown verbatim to the user'
          ),
        action: z
          .discriminatedUnion('type', [
            z.object({
              type: z.literal('run'),
              command: z
                .string()
                .describe(
                  'Shell command to run with the secret injected as an env var. Reference it as "$SECRET" (or your envVar). Never inline the value.'
                ),
              cwd: z.string().describe('Absolute working directory for the command'),
              envVar: z
                .string()
                .regex(/^[A-Z_][A-Z0-9_]*$/)
                .default('SECRET')
                .describe('Env var name the secret is injected as (default SECRET)')
            }),
            z.object({
              type: z.literal('env-file'),
              file: z.string().describe('Absolute path of the .env file to create or update'),
              key: z
                .string()
                .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
                .describe('Variable name to upsert; the user-supplied value becomes KEY=value')
            })
          ])
          .describe('What to do with the secret once the user provides it'),
        timeoutSeconds: z
          .number()
          .int()
          .min(5)
          .max(300)
          .default(30)
          .describe(
            'How long to block waiting for the user before returning status "pending". Keep this well under your MCP client\'s tool timeout (commonly ~60s): if the client aborts the call first, you never receive the requestId to poll with. Default 30 leaves margin; the user can still take as long as they like — you just poll clave_secret_result.'
          )
      }
    },
    async (args) => {
      const action = args.action as SecretAction
      if (action.type === 'run') {
        if (!path.isAbsolute(action.cwd)) {
          return errorResult('cwd must be an absolute path')
        }
        const ref = `$${action.envVar}`
        if (!action.command.includes(ref) && !action.command.includes(`\${${action.envVar}}`)) {
          return errorResult(
            `The command must reference the secret via ${ref} — never inline the value`
          )
        }
      } else if (!path.isAbsolute(action.file)) {
        return errorResult('file must be an absolute path')
      }
      const request = createRequest({
        description: args.description,
        action,
        callerSessionId
      })
      const result = await waitForOutcome(request.id, args.timeoutSeconds * 1000)
      return secretRequestResult(result)
    }
  )

  server.registerTool(
    'clave_offer_copy',
    {
      description:
        "Hand the user a value to copy with ONE CLICK — the outbound mirror of clave_request_secret. Use it whenever the user will paste something you produced somewhere else (a command for another machine, a config snippet, a URL, a message for Slack/email): selecting text in a terminal mangles lines, this preserves the exact bytes. A copy button appears in your tab's header listing every value you have offered; one call per value, with a short label so the user knows what they are copying. Returns immediately — you are not told if or when the user copies. Set sensitive:true for values that should not be previewed on screen (the user can still copy them). For long-running work, pair with clave_notify so the user knows a value is waiting.",
      inputSchema: {
        label: z
          .string()
          .min(1)
          .max(120)
          .describe(
            'Short human-readable name for the value, e.g. "Webhook URL for the Stripe dashboard"'
          ),
        value: z
          .string()
          .min(1)
          .max(262144)
          .describe(
            'The exact text to place on the clipboard — newlines and formatting are preserved byte-for-byte'
          ),
        sensitive: z
          .boolean()
          .default(false)
          .describe(
            'Mask the on-screen preview (for values like tokens that should not be shoulder-surfable)'
          )
      }
    },
    async (args) => {
      // Identity-gated like the cross-tab tools: the button is rendered in the
      // calling tab's header, so an anonymous caller has nowhere to surface it.
      if (!callerSessionId) {
        return errorResult(
          'clave_offer_copy requires a per-session token (it surfaces the value in the calling tab). The shared discovery token is anonymous.'
        )
      }
      const offer = createOffer({
        callerSessionId,
        label: args.label,
        value: args.value,
        sensitive: args.sensitive
      })
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ ok: true, offerId: offer.id, label: offer.label })
          }
        ]
      }
    }
  )

  server.registerTool(
    'clave_secret_result',
    {
      description:
        'Fetch the outcome of a clave_request_secret call that returned {status:"pending"}. Optionally wait up to waitSeconds for the user to act. Outcomes are kept ~10 minutes.',
      inputSchema: {
        requestId: z.string(),
        waitSeconds: z.number().int().min(0).max(300).default(0)
      }
    },
    async (args) => {
      const request = getRequest(args.requestId)
      // Scope to the creating session so other tabs can't snoop outcomes.
      if (!request || (request.callerSessionId && request.callerSessionId !== callerSessionId)) {
        return errorResult(`No secret request "${args.requestId}"`)
      }
      const result =
        args.waitSeconds > 0
          ? await waitForOutcome(args.requestId, args.waitSeconds * 1000)
          : request
      return secretRequestResult(result)
    }
  )

  return server
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

/** Serialize a request for the agent: status + redacted outcome, no internals. */
function secretRequestResult(request: SecretRequest): ToolResult {
  const payload = {
    requestId: request.id,
    status: request.status,
    description: request.description,
    ...(request.outcome ? { outcome: request.outcome } : {})
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...(request.status === 'failed' ? { isError: true } : {})
  }
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  // Unauthenticated liveness endpoint (127.0.0.1 only). Lets anything — a
  // health script, a booting second instance probing a taken port — tell a
  // live Clave MCP server apart from a foreign process or a dead socket.
  if (url.pathname === '/health' && req.method === 'GET') {
    res
      .writeHead(200, { 'Content-Type': 'application/json' })
      .end(JSON.stringify({ app: 'clave', version: app.getVersion(), pid: process.pid }))
    return
  }
  if (url.pathname !== MCP_PATH) {
    res.writeHead(404).end()
    return
  }
  const auth = authenticate(req.headers.authorization)
  if (!auth.ok) {
    res.writeHead(401, { 'Content-Type': 'application/json' }).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Unauthorized' },
        id: null
      })
    )
    return
  }
  if (req.method !== 'POST') {
    // Stateless mode: no SSE notification stream, no sessions to delete.
    res.writeHead(405, { Allow: 'POST' }).end()
    return
  }

  // Identity comes from the token (see authenticate), NOT from any request
  // header — a tab cannot present another tab's id.
  const callerSessionId = auth.callerSessionId

  let body: unknown
  try {
    body = await readBody(req)
  } catch {
    res.writeHead(400).end()
    return
  }

  const server = buildServer(callerSessionId)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => {
    void transport.close()
    void server.close()
  })
  await server.connect(transport)
  await transport.handleRequest(req, res, body)
}

/**
 * Start the in-app MCP server on 127.0.0.1. Failure is non-fatal: the app
 * works without it, spawned sessions simply don't get the --mcp-config flag.
 */
export async function startMcpServer(): Promise<void> {
  registerMcpBridge()
  const { port, token } = loadOrCreateServerState()
  serverToken = token

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('[mcp] request failed', err)
      if (!res.headersSent) res.writeHead(500).end()
    })
  })

  const listen = (p: number): Promise<number> =>
    new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(p, '127.0.0.1', () => {
        server.removeListener('error', reject)
        const address = server.address()
        if (address && typeof address === 'object') resolve(address.port)
        else reject(new Error('Could not determine MCP server port'))
      })
    })

  let boundPort: number | null = null
  try {
    boundPort = await listen(port)
  } catch {
    // The persisted port is taken. Surviving tmux tabs hold this exact
    // endpoint in memory — an agent's MCP connection is read once at spawn and
    // can never be re-pointed — so giving the port up cuts every one of them
    // off permanently. Fight for it first. A live Clave answering /health is
    // ANOTHER instance (dev run beside the installed app): it won't release,
    // skip straight to an ephemeral port. No answer means our own previous
    // instance is still draining (quit, or an update's relaunch) — retry while
    // it exits.
    if (port > 0 && !(await probeClaveHealth(port))) {
      for (let attempt = 0; attempt < 10 && boundPort === null; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        try {
          boundPort = await listen(port)
        } catch {
          /* still taken */
        }
      }
    }
    if (boundPort === null) boundPort = await listen(0)
  }

  httpServer = server
  const mcpUrl = `http://127.0.0.1:${boundPort}${MCP_PATH}`
  setMcpRuntime({ url: mcpUrl, token })
  // Re-map per-session tokens from surviving tabs' config files (post-restart),
  // now that runtime.token is set so the anonymous shared token is skipped.
  rebuildSessionTokens()
  if (port > 0 && boundPort !== port) {
    // The endpoint moved. Every surviving session whose config still carries
    // the old URL holds it in memory too — those tabs are cut off until they
    // restart, and nothing else in the app will ever say so. Say it here.
    const stale = countStaleSessionConfigs(mcpUrl)
    console.error(
      `[mcp] persisted port ${port} was unavailable — now on ${boundPort}; ` +
        `${stale} surviving session(s) hold the old endpoint and need a tab restart`
    )
    if (stale > 0 && !TEST_NO_ACTIVATE && Notification.isSupported()) {
      new Notification({
        title: 'Agent tabs lost Clave tools',
        body:
          `Clave's agent endpoint changed port on restart. ${stale} running tab` +
          `${stale === 1 ? '' : 's'} can no longer reach Clave — restart ` +
          `${stale === 1 ? 'that tab' : 'those tabs'} to reconnect.`,
        silent: false
      }).show()
    }
  }
  saveServerState(mcpUrl, token)
  console.log(`[mcp] listening on ${mcpUrl}`)
}

/** True when a live Clave MCP server answers /health on the port. */
function probeClaveHealth(port: number, timeoutMs = 750): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/health', timeout: timeoutMs },
      (res) => {
        let data = ''
        res.on('data', (chunk: Buffer) => (data += chunk))
        res.on('end', () => {
          try {
            resolve(
              res.statusCode === 200 && (JSON.parse(data) as { app?: string }).app === 'clave'
            )
          } catch {
            resolve(false)
          }
        })
      }
    )
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
  })
}

export function stopMcpServer(): void {
  // close() alone waits for open keep-alive connections — agent tabs hold
  // theirs for the life of the session — so the port could stay occupied while
  // a replacement instance boots (the app-update relaunch). Drop them so quit
  // actually releases the port.
  httpServer?.close()
  httpServer?.closeAllConnections()
  httpServer = null
  setMcpRuntime(null)
}
