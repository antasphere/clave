/** Agent MCP belongs to the standalone server. Local provider processes use
 * loopback and per-session tokens, independently of every desktop client. */
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type RoutineMachineWorkspace,
  ROUTINE_TOOLS_INSTRUCTION,
  registerRoutineTools
} from './routine-tools'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type {
  AgentTokensService,
  ArtefactsService,
  RoutinesService,
  SessionHostService
} from '@clave/server'
import { RoutineReportRefusal } from '../routines/service'
import { SERVER_LAYOUT_KEY } from '@clave/contract/sidebar'
import type { SidebarLayouts } from '@clave/server/sidebar-layouts'
import { BUILT_IN_LAUNCH_PROFILES, type LauncherFamily } from '../../shared/agent-launch'
import {
  CHAT_PROFILE_IDS,
  DANGEROUS_MODE_FAMILIES,
  resolveProfileRef,
  resolveSpawnModes
} from '../../shared/open-session-modes'
// ── Wave 7, lane A: the launcher's choices on this server (PRDCT-4485) ──
import { HARNESSES, HARNESS_BY_ID, type HarnessId } from '../../shared/harness'
import {
  EFFORT_PATTERN,
  SPAWN_PERMISSION_MODES,
  launchModeFields
} from '../../shared/runtime-choices'
import { accountPoolsOf, launchOptions, poolsOf } from '../../shared/launch-options'
import { firstPoolOf, isAccountPoolId } from '../../shared/connection'
import { pickAccount } from '../../shared/account-pool'
import { accountRefusal, openFormOf, resolveLaunch, type LaunchRequest } from '../routines/launch'
import { poolOf, resolveAccountRef, spawnFieldsOf, usageOf } from './served-accounts'
import { modeOf as recordModeOf } from './served-core'
import {
  accountOf,
  launchOptionsInput,
  modelsOfHarnesses,
  poolOfRecord,
  type StandaloneLaunchFacts
} from './standalone-launch-facts'
import type {
  HostedRequestInput,
  PendingRequest,
  SecretAction
} from '../../../packages/contract/src/requests'
import type { PendingRequests } from '../../../packages/server/src/requests/service'
import {
  INPUT_RESULT_DESCRIPTION,
  INPUT_SET_DESCRIPTION,
  REQUEST_INPUT_DESCRIPTION,
  inputResultPayload,
  inputResultSchema,
  inputSetSchema,
  pollResult,
  setRefusal,
  type InputSetArgs,
  requestInputSchema,
  toHostedInput,
  type RequestInputArgs
} from './request-input'
import type {
  AccountOverride,
  Session,
  SessionRecord,
  SpawnOptions
} from '@clave/contract/sessions'
import { historyLines } from '../../shared/history-text'
import {
  type TargetHost,
  readAnswer,
  resolveTarget,
  requireCaller,
  resumeTarget,
  sendToTarget
} from './session-targets'
import { planResumeFromRecords } from './conversation-history'
import type { ServerConversations } from '../session-history/server-conversations'
import type { HistoryConversation } from '@clave/contract/history'
import {
  OPEN_ARTEFACT_DESCRIPTION_SERVER,
  OPEN_ARTEFACT_TOOL,
  openArtefactSchema,
  openedAnswer
} from './artefact-tool'

export interface StandaloneMcpOptions {
  readonly sessions: SessionHostService
  readonly agentTools: AgentTokensService
  readonly requests: PendingRequests
  /** PRDCT-4157: how a request an agent tool puts to the person is created,
   *  the request-aware host's road, which publishes it to the session's views;
   *  absent, the service's own create, seen by a view only when it subscribes. */
  readonly createHosted?: ((input: HostedRequestInput) => PendingRequest) | undefined
  /** ADR 0004: the routines this server schedules; absent, the report tool says so. */
  readonly routines?: RoutinesService | undefined
  /** PRDCT-4243: what the routine tools need of this server beside its scheduler:
   *  its workspaces, its `.clave` files, its own name. Absent, the tools are not registered. */
  readonly routineTools?:
    | {
        readonly workspaces: () => Promise<ReadonlyArray<RoutineMachineWorkspace>>
        readonly ownName: () => string
      }
    | undefined
  readonly executeSecret: (action: SecretAction, value: string) => Promise<void>
  /** The daemon's one sidebar, where the groups live; absent, the group tools
   *  say this server keeps none. */
  readonly sidebar?: SidebarLayouts | undefined
  /** The family a launch profile id belongs to, or undefined when this
   *  server offers no such profile. Absent, only the built-in terminal and
   *  chat profiles are known. */
  readonly profileFamily?: ((id: string) => LauncherFamily | undefined) | undefined
  /** The chat profile this server's launcher would open a family's chat on
   *  (its default's chat form, `chatDefaultFor`); absent, the built-in chat. */
  readonly chatDefault?: ((family: LauncherFamily) => string | undefined) | undefined
  /** PRDCT-4321: this server's own History, the conversations its tabs ran.
   *  A resume of one no tab holds any more finds its folder, its model and
   *  its bypass there, so a deleted tab comes back with no `cwd` passed;
   *  `clave_history` lists it. Absent, a resume needs `cwd`. */
  readonly conversations?: ServerConversations | undefined
  /** PRDCT-4472: this server's artefacts, what `clave_open_artefact` opens a
   *  session's HTML page with. Absent, the tool is not registered. */
  readonly artefacts?: ArtefactsService
  /** PRDCT-4485: what this server's launcher offers and resolves with (the
   *  pools, the profiles, the harnesses installed, the models, the launch
   *  settings, the switch mode). Absent, `clave_launch_options` and
   *  `clave_switch_account` are not registered and `clave_open_session`
   *  refuses `account` as before. */
  readonly launch?: StandaloneLaunchFacts | undefined
}
/** The conversation this server's History remembers by its id, with its
 *  transcript still on the disk (PRDCT-4321); undefined otherwise, or when the
 *  History cannot be read. */
export function rememberedConversation(
  conversations: ServerConversations | undefined,
  id: string
): HistoryConversation | undefined {
  if (!conversations) return undefined
  try {
    return conversations
      .list()
      .conversations.find((c) => c.conversationId === id && c.transcript === 'present')
  } catch {
    return undefined
  }
}
/** The profiles every server offers: the terminal built-ins and the chat views. */
export const builtInProfileFamily = (id: string): LauncherFamily | undefined =>
  BUILT_IN_LAUNCH_PROFILES.find((p) => p.id === id)?.family ??
  (Object.entries(CHAT_PROFILE_IDS).find(([, profile]) => profile === id)?.[0] as
    | LauncherFamily
    | undefined)
type ServedRecord = Parameters<typeof recordModeOf>[0]
type OpenMode = 'claude' | 'codex' | 'antigravity' | 'gemini' | 'pi' | 'opencode' | 'terminal'
/** The arguments of `clave_open_session` the spawn is resolved from. */
interface OpenArgs {
  readonly model?: string | undefined
  readonly dangerous?: boolean | undefined
  readonly chat?: boolean | undefined
  readonly profile?: string | undefined
  readonly account?: string | undefined
  readonly permissionMode?: string | undefined
  readonly effort?: string | undefined
  readonly provider?: string | undefined
  readonly thinking?: string | undefined
  readonly name?: string | undefined
}
/** Who opened which tab through `clave_open_session`, kept as long as this
 *  listener lives. The record's `openedBy` (PRDCT-4192) is what survives a
 *  restart of this server; this map is the word before the record is read. */
type Parents = Map<string, string>
/** The size a session with no pane starts at, as the desktop's hidden spawns. */
const HIDDEN_COLS = 120
const HIDDEN_ROWS = 30
const DESKTOP_ONLY = ['window', 'workspace'] as const
/** A server with no launch facts resolves no connection (the caller of old). */
const DESKTOP_ONLY_WITHOUT_LAUNCH = ['account', 'window', 'workspace'] as const

// ── PRDCT-4485: every description names the harnesses from the table ──
const namesWhere = (pick: (id: HarnessId) => boolean): string =>
  HARNESSES.filter((h) => pick(h.id))
    .map((h) => h.name)
    .join(', ')
const ALL_HARNESSES = HARNESSES.map((h) => `${h.id} (${h.name})`).join(', ')
const CHAT_HARNESSES = namesWhere((id) => HARNESS_BY_ID[id].chatAdapterId !== null)
const MODEL_HARNESSES = namesWhere((id) => HARNESS_BY_ID[id].takesModel)
const DANGEROUS_HARNESSES = namesWhere((id) => DANGEROUS_MODE_FAMILIES.has(id))
// Every harness with a pool takes an account on open: an account of Claude's
// or Codex's, a stored connection of Pi's or OpenCode's (PRDCT-4496).
const POOLED_HARNESSES = namesWhere((id) => poolsOf(HARNESS_BY_ID[id]).length > 0)
// A running tab moves to another connection on an account pool only: a Pi or
// OpenCode tab's move is a restart road of its own (lane D).
const SWITCHABLE_HARNESSES = namesWhere((id) => accountPoolsOf(HARNESS_BY_ID[id]).length > 0)
/** The effort and the permission mode follow the launch fields rule (`launchModeFields`). */
const EFFORT_HARNESSES = namesWhere((id) => id === 'claude' || id === 'codex')
const CLAUDE_NAME = HARNESS_BY_ID.claude.name
const PI_NAME = HARNESS_BY_ID.pi.name
const BUILT_IN_CHATS = Object.values(CHAT_PROFILE_IDS)
  .map((id) => `"${id}"`)
  .join(', ')

export const LAUNCH_OPTIONS_DESCRIPTION =
  "Before opening a tab, or when asked which harness, model or connection has room: lists, for this machine, the installed harnesses with their version, their models (served, or the reason not), the connections of their pool (a subscription or a key) with the suggested one marked, whether each is exhausted for the default model (defaultModel, the model a tab opens on when none is passed; launcherModel is the one the launcher's row would pass), its headroom line and every cap window with what is left and when it resets, and their launch profiles (chat or terminal); the harnesses not installed are named in notInstalled. Pass what you read to clave_open_session as mode, model, account and profile."
export const LIST_DESCRIPTION =
  'List the tabs this server owns, including stopped records: each with its harness (mode), model, launch profile and, on a harness with a connection pool, its connection ({ id, label, exhausted }); parentId names the tab that opened it.'
export const SWITCH_ACCOUNT_DESCRIPTION =
  'Move a tab to another connection (a subscription or a key of its harness\'s pool) when the one it runs on is about to hit its limit, or when asked: the same tab, its agent restarted on the other connection with the conversation resumed. Tabs on a harness with a connection pool only. "mine" moves your own tab (your process restarts; finish what you are writing first). The connection is an id, an exact name, or "any" for whichever connection of the pool has headroom. This server switches at once when its switch mode is automatic (accountSwitchMode in its preferences.json, read when it starts; propose is the default, and a setting from the Mac\'s server pages is PRDCT-3318) and refuses when it is propose, since a server has no window to propose to. A pin set from the Mac window lives in that window and is not visible here: this tool cannot honour it (PRDCT-4508).'
export const OPEN_SESSION_DESCRIPTION = `Open a new tab on this server: an agent of one of its harnesses (${HARNESSES.map((h) => h.name).join(', ')}) or a plain terminal, in an absolute directory. ${CHAT_HARNESSES} open in Clave's CHAT VIEW (the conversation interface with message bubbles and a composer) or in the terminal: omit chat to open the way this server's launcher does (its interaction mode), chat: true forces a chat view, chat: false the terminal. Optionally a model, a connection (account), a launch profile, a name, a first prompt and a group; clave_launch_options lists what this machine can launch. With resume, the new tab continues a PAST conversation by its id. Returns the new sessionId; the tab is linked to its caller, so clave_list reports its parentId and clave_send_to_session and clave_read_session reach it.`
export const SWITCH_PROPOSE_REFUSAL =
  'This server\'s switch mode is "propose", and a server has no window to propose to: move the tab from the Mac window, or set accountSwitchMode to "automatic" in the server\'s preferences.json, read when the server starts (a setting for it from the Mac\'s server pages is PRDCT-3318).'
const text = (value: unknown): { content: { type: 'text'; text: string }[] } => ({
  content: [{ type: 'text', text: JSON.stringify(value) }]
})
const boundedText = z.string().min(1).max(16_384)
const question = z.object({
  question: boundedText,
  header: z.string().max(256).optional(),
  options: z.array(z.object({ label: boundedText, description: boundedText.optional() })).max(100),
  multiSelect: z.boolean().optional()
})
const actionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('run'),
    command: boundedText,
    cwd: boundedText,
    envVar: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]*$/)
      .default('SECRET')
  }),
  z.object({
    type: z.literal('env-file'),
    file: boundedText,
    key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
  })
])

function buildServer(
  options: StandaloneMcpOptions,
  sessionId: string,
  parents: Parents
): McpServer {
  const { sessions, requests, sidebar } = options
  const profileFamily = options.profileFamily ?? builtInProfileFamily
  const chatDefault = options.chatDefault ?? ((): undefined => undefined)
  const own = (id: string): string => (id === 'mine' ? sessionId : id)
  const known = (id: string): string => {
    const resolved = own(id)
    if (!sessions.get(resolved)) throw new Error(`Unknown session "${id}".`)
    return resolved
  }
  const groups = (): SidebarLayouts => {
    if (!sidebar) throw new Error('This server keeps no groups.')
    return sidebar
  }
  const knownGroup = (groupId: string): string => {
    if (
      !groups()
        .get(SERVER_LAYOUT_KEY)
        .groups.some((g) => g.id === groupId)
    )
      throw new Error(`Unknown group "${groupId}".`)
    return groupId
  }
  const holds = (groupId: string, id: string): boolean =>
    groups()
      .get(SERVER_LAYOUT_KEY)
      .groups.some((g) => g.id === groupId && g.sessionIds.includes(id))
  const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
  /** A tab's record, as this host keeps it; undefined when it keeps none. */
  const recordOf = (id: string): SessionRecord | undefined => {
    try {
      return sessions.listAdoptableRecords([id]).find((r) => r.id === id)
    } catch {
      return undefined
    }
  }
  /** The workspace the calling tab belongs to, from its record; undefined
   *  when it has none or this host keeps no records. */
  const callerWorkspace = (id: string): string | undefined => recordOf(id)?.workspaceId || undefined
  /** The tab that opened this one: this listener's memory of the open, else
   *  the record, which is what still says it after this server restarted
   *  (PRDCT-4192): the opener nested or not, else the nesting parent. */
  const parentOf = (id: string): string | null => {
    const record = recordOf(id)
    return parents.get(id) ?? record?.openedBy ?? record?.spawnedBy ?? null
  }
  const nameOf = (session: Session): string => {
    const record = recordOf(session.id)
    return record?.displayName || record?.folderName || session.title
  }
  /** The tab's mode as the desktop spells it, from the record's flags when
   *  this host keeps one, else from the provider's id. */
  const modeOf = (session: Session): string => {
    const record = recordOf(session.id)
    if (record) {
      if (record.antigravityMode) return 'antigravity'
      if (record.codexMode) return 'codex'
      if (record.piMode) return 'pi'
      if (record.opencodeMode) return 'opencode'
      if (record.claudeAgentsMode) return 'claude-agents'
      if (record.claudeMode) return 'claude'
      return 'terminal'
    }
    return ['claude', 'codex', 'antigravity', 'pi', 'opencode', 'claude-agents'].includes(
      session.provider
    )
      ? session.provider
      : 'terminal'
  }
  /** This server, as the shared resolver reads it (`session-targets.ts`):
   *  the same rule the desktop's tools apply, over this host's facts. */
  const targetHost: TargetHost = {
    caller: sessionId,
    get: async (id) => sessions.get(id) ?? null,
    list: async () => sessions.list(),
    nameOf,
    modeOf,
    parentOf,
    groups: async () => (sidebar ? sidebar.get(SERVER_LAYOUT_KEY).groups : [])
  }
  const launch = options.launch
  const server = new McpServer(
    { name: 'clave-server', version: '1' },
    {
      instructions:
        'Your Clave tools run on this server without a desktop. Ask the person every question, value, choice, file or link to open with clave_request_input, never with your own question tool (a form in their chat that lives across your turns; fill it from what they say with clave_input_set; clave_input_result reads it), for approval with clave_request_approval, for a secret with clave_request_secret. Calls return a requestId. Poll clave_request_result or clave_secret_result while pending; clients can answer later. Secret values and action output are never returned. Delegate work to a new tab with clave_open_session, then message it with clave_send_to_session (target "parent" to report back to the tab that opened yours; "mine" logs a checkpoint, typed nowhere), read it with clave_read_session, resume a stopped one with clave_resume_session and close it with clave_close_session; clave_create_group, clave_move_session and clave_rename organize the tabs. Sessions and paths are server-local. An HTML page, document or deck you made -> clave_open_artefact with its folder (index.html inside): open it ONCE, then edit its files; it reloads itself and keeps a version per turn. Before opening a tab, or to know which harness, model or connection has room -> clave_launch_options. ' +
        ROUTINE_TOOLS_INSTRUCTION.slice(2)
    }
  )
  // PRDCT-4321: this server's own History, the conversations its tabs ran,
  // deleted tabs included.
  const conversations = options.conversations
  if (conversations)
    server.registerTool(
      'clave_history',
      {
        description:
          'List the past Claude conversations this server\'s tabs ran ("what was I working on", "find the conversation about", "reopen the tab I deleted"), newest first: deleted tabs included, as long as the server ran them. Each row: id, title, the tab\'s name, directory, model, group, last activity, whether the transcript is still on this server\'s disk, and whether a tab of this server holds it (running, stopped or closed). Read-only. Reopen one with clave_open_session and resume: <id>; its directory, model and bypass come back with it. Filters: query (a substring of the title, the tab name or the directory), open (only conversations a tab holds), limit (50 by default, 200 at most).',
        inputSchema: {
          query: z.string().min(1).max(500).optional(),
          open: z.boolean().optional(),
          limit: z.number().int().min(1).max(200).optional()
        }
      },
      async ({ query, open, limit }) => {
        const needle = query?.trim().toLowerCase()
        const rows = conversations
          .list()
          .conversations.filter(
            (c) =>
              !needle ||
              (c.title ?? '').toLowerCase().includes(needle) ||
              c.name.toLowerCase().includes(needle) ||
              c.cwd.toLowerCase().includes(needle)
          )
          .filter((c) => open !== true || c.held !== 'closed')
          .sort((a, b) =>
            a.lastHumanAt < b.lastHumanAt ? 1 : a.lastHumanAt > b.lastHumanAt ? -1 : 0
          )
          .map((c) => ({
            conversationId: c.conversationId,
            title: c.title ?? c.name,
            name: c.name,
            cwd: c.cwd,
            model: c.model,
            group: c.groupName,
            lastActivity: c.lastHumanAt,
            transcriptExists: c.transcript === 'present',
            held: c.held,
            sessionId: c.held === 'closed' ? null : c.sessionId,
            resumable: c.transcript === 'present',
            ...(c.launch ? { launch: c.launch } : {})
          }))
        const shown = rows.slice(0, Math.min(Math.max(limit ?? 50, 1), 200))
        return text({ conversations: shown, shown: shown.length, total: rows.length })
      }
    )
  server.registerTool(
    'clave_request_approval',
    {
      description:
        'Ask the user to approve a described action. It waits on this server with no client; poll the returned requestId.',
      inputSchema: { description: boundedText }
    },
    async ({ description }) => {
      const request = requests.create({
        sessionId,
        kind: 'permission',
        description,
        options: [
          { id: 'approve', label: 'Approve' },
          { id: 'deny', label: 'Deny' }
        ]
      })
      return text({ requestId: request.id, status: 'pending' })
    }
  )
  server.registerTool(
    'clave_request_input',
    { description: REQUEST_INPUT_DESCRIPTION, inputSchema: requestInputSchema },
    async (args) => {
      const createHosted = options.createHosted ?? ((input) => requests.createHosted(input))
      const request = createHosted(toHostedInput(args as RequestInputArgs, sessionId))
      const view = await pollResult(
        (waitMs) => requests.resultAfter(request.id, sessionId, waitMs),
        (args as RequestInputArgs).timeoutSeconds * 1000
      )
      return text(inputResultPayload(view))
    }
  )
  server.registerTool(
    'clave_input_set',
    { description: INPUT_SET_DESCRIPTION, inputSchema: inputSetSchema },
    async (args) => {
      const { requestId, answers, submit, notes } = args as InputSetArgs
      try {
        return text(
          inputResultPayload(
            await requests.setAnswers({
              requestId,
              sessionId,
              answers,
              ...(submit && { submit: true }),
              ...(notes && { notes })
            })
          )
        )
      } catch (error) {
        return { isError: true, content: [{ type: 'text', text: setRefusal(error) }] }
      }
    }
  )
  server.registerTool(
    'clave_input_result',
    { description: INPUT_RESULT_DESCRIPTION, inputSchema: inputResultSchema },
    async ({ requestId, waitSeconds }) =>
      text(
        inputResultPayload(
          await pollResult(
            (waitMs) => requests.resultAfter(requestId, sessionId, waitMs),
            waitSeconds * 1000
          )
        )
      )
  )
  server.registerTool(
    'clave_request_clarification',
    {
      description:
        'Ask the user one or more questions. Requests wait without a desktop and are shared across attached clients. Poll the returned requestId.',
      inputSchema: { description: boundedText, questions: z.array(question).min(1).max(20) }
    },
    async ({ description, questions }) => {
      const request = requests.create({ sessionId, kind: 'clarification', description, questions })
      return text({ requestId: request.id, status: 'pending' })
    }
  )
  server.registerTool(
    'clave_request_secret',
    {
      description:
        'Ask for a sensitive value through a private client input, then run the exact action on this server. The secret and action output are never returned. Poll clave_secret_result with requestId.',
      inputSchema: {
        description: boundedText,
        action: actionSchema,
        timeoutSeconds: z.number().int().min(0).max(300).optional()
      }
    },
    async ({ description, action }) => {
      if (action.type === 'run') {
        if (
          !isAbsolute(action.cwd) ||
          (!action.command.includes(`$${action.envVar}`) &&
            !action.command.includes(`\${${action.envVar}}`))
        )
          throw new Error(
            'Use an absolute cwd and reference the secret through the named environment variable.'
          )
      } else if (!isAbsolute(action.file)) throw new Error('Use an absolute env-file path.')
      const request = requests.create(
        { sessionId, kind: 'secret', description, action },
        async (response) => {
          if (response.type === 'secret') await options.executeSecret(action, response.value)
        }
      )
      return text({ requestId: request.id, status: 'pending' })
    }
  )
  for (const name of ['clave_request_result', 'clave_secret_result'])
    server.registerTool(
      name,
      {
        description:
          'Poll a request created by this session. Pending requests survive client disconnection; terminal results expire after ten minutes. Secret values and action output are absent.',
        inputSchema: {
          requestId: z.string().min(1).max(256),
          waitSeconds: z.number().min(0).max(300).optional()
        }
      },
      async ({ requestId }) => text(requests.result(requestId, sessionId))
    )
  server.registerTool(
    'clave_list',
    {
      description: LIST_DESCRIPTION,
      inputSchema: {}
    },
    async () => {
      // PRDCT-4485: each row carries what it runs on, from its record.
      let records: readonly SessionRecord[] = []
      try {
        records = sessions.listAdoptableRecords()
      } catch {
        // A host with no records: the rows carry what the session says.
      }
      return text({
        sessions: sessions.list().map((s) => {
          const parentId = parentOf(s.id)
          const record = records.find((r) => r.id === s.id)
          return {
            ...s,
            ...(parentId ? { parentId } : {}),
            mode: recordModeOf(record as ServedRecord | undefined, s.provider),
            model: record?.model ?? null,
            launchProfileId: record?.launchProfileId ?? null,
            account: launch && record ? accountOf(launch, record) : null
          }
        })
      })
    }
  )
  // ── PRDCT-4485: what this machine can launch, the launcher's menu as data ──
  if (launch)
    server.registerTool(
      'clave_launch_options',
      { description: LAUNCH_OPTIONS_DESCRIPTION, inputSchema: {} },
      async () => {
        // A detection a step of which failed is no fact: every harness is
        // listed with its presence unknown, and the answer says why.
        const warnings: string[] = []
        let statuses: Awaited<ReturnType<typeof launch.harnesses>> | undefined
        try {
          statuses = await launch.harnesses()
        } catch (error) {
          warnings.push(message(error))
        }
        const models = await modelsOfHarnesses(launch)
        const answer = launchOptions(launchOptionsInput(launch, statuses, models))
        return text(warnings.length > 0 ? { ...answer, warnings } : answer)
      }
    )
  /** Today's resolution, for a terminal and for a caller with no launch
   *  facts: the modes, the profile checked against this server's families,
   *  the launch fields and Pi's own. */
  const legacySpawn = (mode: OpenMode, args: OpenArgs): SpawnOptions => {
    if (args.account !== undefined)
      throw new Error(
        `The account argument applies to harnesses with a connection pool (${POOLED_HARNESSES}); a terminal runs on none.`
      )
    const modes = resolveSpawnModes({
      mode,
      ...(args.dangerous !== undefined ? { dangerous: args.dangerous } : {}),
      ...(args.model !== undefined ? { model: args.model } : {})
    })
    const { family } = modes
    const launchProfileId = resolveProfileRef(
      {
        mode,
        // The chat view is the standalone default; a named profile decides for itself.
        chat: args.chat ?? (args.profile === undefined && (mode === 'claude' || mode === 'codex')),
        ...(args.profile !== undefined ? { profile: args.profile } : {})
      },
      // The chat this server's launcher would open: the person's own chat
      // profile when they set one on this server.
      family ? chatDefault(family) : undefined
    )
    // A profile picks the adapter, so one from another family would start
    // another agent than the mode names: refuse it before anything starts.
    if (launchProfileId !== undefined) {
      if (family === null)
        throw new Error(`The profile argument applies to agent modes only (got mode "${mode}")`)
      const owner = profileFamily(launchProfileId)
      if (!owner) throw new Error(`Unknown ${family} launch profile "${launchProfileId}"`)
      if (owner !== family)
        throw new Error(`Launch profile "${launchProfileId}" belongs to ${owner}, not ${family}`)
    }
    return {
      claudeMode: modes.claudeMode,
      antigravityMode: modes.antigravityMode,
      codexMode: modes.codexMode,
      piMode: modes.piMode,
      opencodeMode: modes.opencodeMode,
      dangerousMode: modes.dangerousMode,
      ...(modes.model !== undefined ? { model: modes.model } : {}),
      ...(launchProfileId !== undefined ? { launchProfileId } : {}),
      ...launchModeFields({
        claudeMode: modes.claudeMode,
        codexMode: modes.codexMode,
        dangerousMode: modes.dangerousMode,
        permissionMode: args.permissionMode,
        effort: args.effort,
        allowDangerous: undefined
      }),
      ...(modes.piMode && args.provider !== undefined ? { piProvider: args.provider } : {}),
      ...(modes.piMode && args.thinking !== undefined ? { piThinking: args.thinking } : {})
    }
  }
  /** PRDCT-4485: an agent tab resolved as a routine run is (ADR 0004): the
   *  arguments laid out as a launch declaration, the form decided by the
   *  person's launcher (their interaction mode) when `chat` is omitted. */
  const resolvedSpawn = (
    facts: StandaloneLaunchFacts,
    mode: Exclude<OpenMode, 'terminal'>,
    args: OpenArgs,
    resuming: boolean,
    workspaceId: string | undefined
  ): SpawnOptions => {
    const agent: HarnessId = mode === 'gemini' ? 'antigravity' : mode
    // A built-in chat id names the chat view, not one profile: the
    // harness's configured chat default (PRDCT-4348).
    const builtInChat = args.profile !== undefined && args.profile === CHAT_PROFILE_IDS[agent]
    const profile = builtInChat && args.chat !== false ? undefined : args.profile
    const chat = builtInChat && args.chat !== false ? true : args.chat
    // The form the listing's `openProfileId` reads too (`openProfileIdFor`).
    const form = openFormOf(agent, { chat, profile }, facts.interactionMode())
    const request: LaunchRequest = {
      name: args.name ?? 'tab',
      workspaceId: workspaceId ?? null,
      launch: {
        agent,
        form,
        ...(profile !== undefined ? { profile } : {}),
        ...(args.account !== undefined ? { account: args.account } : {}),
        ...(args.model !== undefined ? { model: args.model } : {}),
        // The skip flag is ignored where the harness has none, as before.
        ...(args.dangerous !== undefined && DANGEROUS_MODE_FAMILIES.has(agent)
          ? { dangerousMode: args.dangerous }
          : {}),
        ...(args.permissionMode !== undefined ? { permissionMode: args.permissionMode } : {}),
        ...(args.effort !== undefined ? { effort: args.effort } : {}),
        ...(args.provider !== undefined ? { provider: args.provider } : {}),
        ...(args.thinking !== undefined ? { thinking: args.thinking } : {})
      }
    }
    // A resumed conversation runs its own model, which nothing here knows
    // unless the call or the History says: never the remembered chat model.
    const resolved = resolveLaunch(request, resuming ? { ...facts, launchModel: undefined } : facts)
    if (!resolved.ok) throw new Error(resolved.reason)
    return resolved.spawn
  }
  /** The connection a stopped tab resumed in place moves to, judged on its own model. */
  const heldAccount = (
    facts: StandaloneLaunchFacts,
    record: SessionRecord,
    ref: string
  ): AccountOverride => {
    const pool = poolOfRecord(record)
    if (!pool) {
      const mode = recordModeOf(record as ServedRecord, '')
      const harness = HARNESS_BY_ID[mode as HarnessId]
      throw new Error(
        harness
          ? accountRefusal(harness.id)
          : `The account argument applies to harnesses with a connection pool (${POOLED_HARNESSES}).`
      )
    }
    return spawnFieldsOf(pool, resolveAccountRef(facts, pool, ref, record.model ?? undefined))
  }
  server.registerTool(
    'clave_open_session',
    {
      description: OPEN_SESSION_DESCRIPTION,
      inputSchema: {
        attachToParent: z
          .boolean()
          .default(false)
          .describe(
            'Nest the new tab under the calling session in the sidebar (default false). Use true for execution helpers and verifiers; false for lane leads and successors. The caller remains the messaging parent either way while the server is running. Without a caller, the tab stays separate.'
          ),
        cwd: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Absolute path of the working directory. Required unless resume names a conversation a tab of this server still holds.'
          ),
        resume: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(
            "Reopen a PAST conversation by its id (a Claude session id, a Codex thread id or a Pi session id): the new agent tab continues it, in cwd. A tab of this server that already runs the conversation is answered as it is (alreadyOpen: true), nothing started; a stopped tab that still holds it is resumed in place, on the connection account names when passed. A Claude conversation this server's History remembers (clave_history), its tab deleted, reopens in its own folder with no cwd. Any other conversation needs cwd, and starts fresh on the id when no transcript is found there. Agent modes only."
          ),
        mode: z
          .enum(['claude', 'codex', 'antigravity', 'gemini', 'pi', 'opencode', 'terminal'])
          .optional()
          .describe(
            `Which harness to start: ${ALL_HARNESSES}; or terminal for a plain shell. claude when omitted; gemini is an old alias of antigravity.`
          ),
        model: z
          .string()
          .min(1)
          .max(256)
          .optional()
          .describe(
            `Model the new agent starts on: an alias or a full model id, as clave_launch_options lists them. ${MODEL_HARNESSES} only (the others take no model on their command line). Omitted = the launch profile's default, else the CLI's. The user can still switch later inside the tab.`
          ),
        name: z.string().min(1).max(255).optional().describe('Display name for the new tab'),
        prompt: boundedText
          .optional()
          .describe('Agent modes only: the first message the agent starts working on'),
        command: boundedText
          .optional()
          .describe('Terminal mode only: a shell command to run in the new terminal'),
        autoRun: z
          .boolean()
          .optional()
          .describe(
            'Terminal mode only: execute the command immediately (default true); false just prefills it'
          ),
        dangerous: z
          .boolean()
          .optional()
          .describe(
            `Start the agent without approval prompts, on its own skip flag: ${DANGEROUS_HARNESSES}. Ignored for the other harnesses and for terminal.`
          ),
        chat: z
          .boolean()
          .optional()
          .describe(
            `true forces Clave's chat view ("chat", "chat mode", "the chat UI"), false the terminal; omit it to open the way this server's launcher does (its interaction mode). true is for ${CHAT_HARNESSES} only; errors for any other mode. Opens the chat the launcher would: the chat form of this server's default profile for the harness (its own flags included), the built-in chat otherwise; profile may name another chat profile instead.`
          ),
        profile: z
          .string()
          .min(1)
          .max(256)
          .optional()
          .describe(
            `A launch profile of the harness, by id or name (clave_launch_options lists them with their form). Omit to use this server's default. A built-in chat id (${BUILT_IN_CHATS}) opens the harness's configured chat default.`
          ),
        account: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe(
            `Connection the new tab runs on (a subscription or a key of its harness's pool): an id or its exact name ("default" is the machine login), or "any" for whichever connection of the pool has headroom for the model. Harnesses with a connection pool only (${POOLED_HARNESSES}). Omit to follow this server's settings: the selected connection, or the recommended one when enabled, moved along the pool when exhausted. On ${PI_NAME} and ${HARNESS_BY_ID.opencode.name}, a stored provider connection by its label or its id, or "any" for the first one with a key; omitted, they run on the login inside the harness. Unknown names error with the list. clave_list reports each tab's connection.`
          ),
        permissionMode: z
          .enum(SPAWN_PERMISSION_MODES)
          .optional()
          .describe(
            `The mode a ${CLAUDE_NAME} agent asks permission under, short of bypass (bypass is dangerous). ${CLAUDE_NAME} only; ignored with dangerous: true.`
          ),
        effort: z
          .string()
          .regex(EFFORT_PATTERN)
          .optional()
          .describe(
            `The reasoning effort the agent starts at ("low", "medium", "high", "xhigh", "max"). ${EFFORT_HARNESSES} only.`
          ),
        provider: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe(`${PI_NAME}'s provider id. ${PI_NAME} only.`),
        thinking: z
          .enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
          .optional()
          .describe(`${PI_NAME}'s thinking level. ${PI_NAME} only.`),
        groupId: z.string().min(1).max(256).optional().describe('Group id from clave_create_group'),
        // Named so a desktop-shaped call fails clearly instead of being stripped.
        window: z.unknown().optional(),
        workspace: z.unknown().optional()
      }
    },
    async (input) => {
      let args = input
      const unsupported = (launch ? DESKTOP_ONLY : DESKTOP_ONLY_WITHOUT_LAUNCH).filter(
        (key) => (args as Record<string, unknown>)[key] !== undefined
      )
      if (unsupported.length > 0)
        throw new Error(
          `${unsupported.join(', ')} ${unsupported.length > 1 ? 'are' : 'is'} not available on a standalone server.`
        )
      const mode = args.mode ?? 'claude'
      const resume = args.resume?.trim()
      if (resume !== undefined) {
        // A past conversation (PRDCT-4236): a tab of this server that holds
        // it is the answer, live as it is, stopped resumed in place; nothing
        // starts a second process on one conversation.
        let records: readonly SessionRecord[] = []
        try {
          records = sessions.listAdoptableRecords()
        } catch {
          // A host with no records keeps nothing to find.
        }
        const held = planResumeFromRecords(records, sessions.list(), resume)
        if (held) {
          let resumed = false
          let accountApplied = false
          if (held.kind === 'stopped') {
            // PRDCT-4485: the connection the call names, judged on the
            // conversation's own model; the restart carries no other field.
            const record = records.find((r) => r.id === held.sessionId)
            // A Pi or OpenCode tab resumed in place keeps the connection it
            // ran on: moving it is the restart road of its own (lane D), so
            // the account is said not applied, never refused (PRDCT-4496).
            const onProviderPool = !!record && (record.piMode || record.opencodeMode) === true
            accountApplied = !!launch && args.account !== undefined && !!record && !onProviderPool
            const restarted = await sessions.restart(
              held.sessionId,
              launch && accountApplied && record && args.account !== undefined
                ? heldAccount(launch, record, args.account)
                : {},
              false,
              true
            )
            resumed = restarted.resumed
          }
          // A held tab runs on its own launch: every field the call passed
          // that this road does not apply is said not applied, never silently
          // dropped (PRDCT-4485). A live tab applies none; a stopped one
          // resumed in place applies the connection alone.
          const unapplied = (
            ['account', 'permissionMode', 'effort', 'model', 'profile', 'dangerous'] as const
          ).filter((key) => args[key] !== undefined && !(key === 'account' && accountApplied))
          return text({
            sessionId: held.sessionId,
            groupId: null,
            workspaceId: records.find((r) => r.id === held.sessionId)?.workspaceId ?? null,
            conversation: resume,
            alreadyOpen: true,
            resumed,
            note:
              held.kind === 'open'
                ? 'A tab of this server already runs this conversation; nothing was started.'
                : 'A stopped tab of this server held this conversation; it was resumed in place.',
            ...(unapplied.length > 0
              ? {
                  warnings: [
                    held.kind === 'open'
                      ? `${unapplied.join(', ')} not applied: the conversation is already open in tab ${held.sessionId}`
                      : `${unapplied.join(', ')} not applied: the conversation was resumed in place in tab ${held.sessionId}`
                  ]
                }
              : {})
          })
        }
        if (mode === 'terminal')
          throw new Error(
            'resume continues an agent conversation: pass an agent mode, not terminal.'
          )
      }
      // A conversation the server's History remembers (PRDCT-4321), its tab
      // deleted: its folder, its model and its bypass, unless the call says.
      const remembered =
        resume !== undefined && mode === 'claude'
          ? rememberedConversation(options.conversations, resume)
          : undefined
      if (remembered) {
        args = {
          ...args,
          cwd: args.cwd ?? remembered.cwd,
          ...(args.model === undefined && remembered.model ? { model: remembered.model } : {}),
          // The profile it ran on (its chat view), unless the call picks one.
          ...(args.profile === undefined &&
          args.chat === undefined &&
          remembered.launchProfileId &&
          profileFamily(remembered.launchProfileId) === 'claude'
            ? { profile: remembered.launchProfileId }
            : {}),
          ...(args.dangerous === undefined && remembered.launch?.dangerous !== undefined
            ? { dangerous: remembered.launch.dangerous }
            : {})
        }
      }
      if (args.cwd === undefined)
        throw new Error(
          "cwd is required unless resume names a conversation this server's History remembers or a tab of this server still holds."
        )
      if (!isAbsolute(args.cwd)) throw new Error('cwd must be an absolute path.')
      const directory = await stat(args.cwd).catch(() => undefined)
      if (!directory?.isDirectory()) throw new Error(`no such directory: ${args.cwd}`)
      const groupId = args.groupId === undefined ? null : knownGroup(args.groupId)
      const terminal = mode === 'terminal'
      // The new tab lands beside its caller (PRDCT-4150): the caller's
      // workspace, read from its record (the live session on the wire
      // carries none), goes on the start. A caller with no workspace leaves
      // the tab as the host stamps it today; the agent never picks one.
      const workspaceId = callerWorkspace(sessionId)
      const spawn =
        launch && !terminal
          ? resolvedSpawn(launch, mode, args, resume !== undefined, workspaceId)
          : legacySpawn(mode, args)
      const info = await sessions.start({
        cwd: args.cwd,
        options: {
          ...spawn,
          ...(resume !== undefined ? { resumeSessionId: resume } : {}),
          ...(terminal && args.command ? { initialCommand: args.command } : {}),
          autoExecute: terminal && !!args.command && args.autoRun !== false,
          ...(!terminal && args.prompt ? { initialPrompt: args.prompt } : {}),
          ...(args.attachToParent ? { spawnedBy: sessionId } : {}),
          // The opener, nested or not, on the record (PRDCT-4192): what
          // "parent" and the name tie-break read once this server restarted.
          openedBy: sessionId,
          ...(workspaceId !== undefined ? { workspaceId } : {})
        }
      })
      parents.set(info.id, sessionId)
      // The tab exists from here on: what follows is best effort, and the
      // answer always names the tab so the caller can find or close it.
      const warnings: string[] = []
      if (args.name) {
        try {
          sessions.rename(info.id, args.name)
        } catch (err) {
          warnings.push(`The tab started but was not renamed: ${message(err)}`)
        }
      }
      let placed: string | null = null
      if (groupId) {
        try {
          groups().moveItems(SERVER_LAYOUT_KEY, [info.id], groupId, 'inside')
        } catch {
          // Reported below from the layout itself.
        }
        if (holds(groupId, info.id)) placed = groupId
        else warnings.push(`Group "${groupId}" no longer exists; the tab is at the top level.`)
      }
      // A terminal starts its process at its first size; no window gives it one here.
      if (sessions.get(info.id)?.transport === 'pty') {
        try {
          sessions.resize(info.id, HIDDEN_COLS, HIDDEN_ROWS)
        } catch (err) {
          warnings.push(`The terminal could not be sized to start: ${message(err)}`)
        }
      }
      return text({
        sessionId: info.id,
        groupId: placed,
        // Where the tab landed (PRDCT-4193): the caller's workspace, or none.
        workspaceId: workspaceId ?? null,
        ...(warnings.length > 0 ? { warnings } : {})
      })
    }
  )
  // ── PRDCT-4485: a tab moved to another connection, the Mac's rule with no window to ask ──
  if (launch)
    server.registerTool(
      'clave_switch_account',
      {
        description: SWITCH_ACCOUNT_DESCRIPTION,
        inputSchema: {
          sessionId: z.string().describe('Id of the tab to move, or "mine" for the calling tab'),
          account: z
            .string()
            .min(1)
            .max(128)
            .describe(
              'Connection id, exact name, or "any" for the pool\'s next connection with headroom'
            )
        }
      },
      async (args) => {
        const id = own(args.sessionId)
        const session = sessions.get(id)
        if (!session) throw new Error(`Unknown session "${args.sessionId}".`)
        const record = recordOf(id)
        const mode = recordModeOf(record as ServedRecord | undefined, session.provider)
        const harness = HARNESS_BY_ID[(mode === 'claude-agents' ? 'claude' : mode) as HarnessId]
        const pool = harness ? firstPoolOf(harness) : null
        if (!isAccountPoolId(pool))
          throw new Error(
            `Only a tab on a harness with a connection pool (${SWITCHABLE_HARNESSES}) runs on a connection`
          )
        const current =
          (pool === 'codex' ? record?.codexAccountId : record?.claudeProfileId) ?? 'default'
        let target: { id: string; label: string }
        if (args.account === 'any') {
          const accounts = launch.accounts(pool)
          const next = pickAccount({
            accounts: poolOf(accounts),
            usage: usageOf(accounts, { model: record?.model ?? undefined }),
            preferredId: current,
            leavingId: current,
            preferWeeklyHeadroom: true
          })
          if (next === current) throw new Error('No other connection of this pool has headroom')
          target = accounts.find((a) => a.id === next) ?? { id: next, label: next }
        } else {
          target = resolveAccountRef(launch, pool, args.account, record?.model ?? undefined)
        }
        const account = { id: target.id, label: target.label }
        // The mode before the switch-to-current answer, as the Mac's
        // `switchAccount` (served-session-tools.ts) checks its mode first:
        // under propose every call that is not an error is refused, a switch
        // to the current connection included.
        if (launch.switchMode() === 'propose') throw new Error(SWITCH_PROPOSE_REFUSAL)
        // Already there: the Mac's answer.
        if (target.id === current)
          return text({ sessionId: id, account, resumed: true, switched: true, proposed: false })
        const restarted = await sessions.restart(id, spawnFieldsOf(pool, target), false)
        return text({
          sessionId: id,
          account,
          resumed: restarted?.resumed === true,
          switched: true,
          proposed: false
        })
      }
    )
  server.registerTool(
    'clave_close_session',
    {
      description: 'Close a session on this server, stopping its process.',
      inputSchema: {
        sessionId: z.string().describe('Id of the session to close, or "mine" for the calling tab')
      }
    },
    async (args) => {
      const id = known(args.sessionId)
      await sessions.stop(id)
      parents.delete(id)
      return text({ closed: id })
    }
  )
  server.registerTool(
    'clave_rename',
    {
      description: 'Rename a group or a session (tab) on this server.',
      inputSchema: {
        target: z.enum(['group', 'session']),
        id: z.string().describe('Group id, or session id ("mine" for the calling tab)'),
        name: z.string().min(1).max(255).describe('New display name')
      }
    },
    async (args) => {
      if (args.target === 'session') {
        const id = known(args.id)
        sessions.rename(id, args.name)
        return text({ renamed: id })
      }
      const renamed = groups().renameGroup(SERVER_LAYOUT_KEY, args.id, args.name)
      if (!renamed.ok) throw new Error(`Unknown group "${args.id}".`)
      return text({ renamed: args.id })
    }
  )
  server.registerTool(
    'clave_create_group',
    {
      description:
        "Create an empty group in this server's sidebar and return its groupId. Put tabs in it with clave_open_session or clave_move_session.",
      inputSchema: { name: z.string().min(1).max(255).describe('Display name for the group') }
    },
    async (args) => {
      const { group } = groups().createGroup(SERVER_LAYOUT_KEY, { name: args.name })
      return text({ groupId: group.id })
    }
  )
  server.registerTool(
    'clave_move_session',
    {
      description: "Move a session into a group of this server's sidebar.",
      inputSchema: {
        sessionId: z.string().describe('Id of the session to move, or "mine" for the calling tab'),
        groupId: z.string().describe('Group id from clave_create_group')
      }
    },
    async (args) => {
      const id = known(args.sessionId)
      const groupId = knownGroup(args.groupId)
      groups().moveItems(SERVER_LAYOUT_KEY, [id], groupId, 'inside')
      if (!holds(groupId, id)) throw new Error(`Unknown group "${groupId}".`)
      return text({ sessionId: id, groupId })
    }
  )
  server.registerTool(
    'clave_read_session',
    {
      description:
        'Read the recent output of a tab on this server without interrupting it: the last lines of a terminal, the recent history of a chat. Target by session id, exact tab name, "parent" (the tab whose agent opened yours) or "mine". Any tab of this server can be read. Read a tab first to learn what it is doing; message it only when you need it to act, never to report progress to a tab that did not ask: an unasked message becomes that agent\'s next instruction.',
      inputSchema: {
        sessionId: z.string().default('mine'),
        lines: z.number().int().min(1).max(500).default(100)
      }
    },
    async (args) => {
      const target = await resolveTarget(
        targetHost,
        args.sessionId === 'mine' ? sessionId : args.sessionId
      )
      requireCaller(targetHost, 'read')
      if (target.transport === 'pty') {
        const screen = await sessions.screen(target.id, args.lines)
        return text(readAnswer(targetHost, target, screen.lines))
      }
      // A chat has no screen: its recent history, one line per thing said
      // or done, under the same envelope (PRDCT-4199).
      const page = sessions.history(target.id, undefined, args.lines)
      return text({
        ...(readAnswer(targetHost, target, historyLines(page.items)) as Record<string, unknown>),
        history: page.items
      })
    }
  )
  server.registerTool(
    'clave_send_to_session',
    {
      description:
        'Send a message to another agent tab on this server: the text is typed into that tab\'s input under a provenance header naming your tab, then submitted. Target by session id, exact tab name or "parent" (the tab whose agent opened yours). Addressed to your OWN tab ("mine", your own id or name) it is a CHECKPOINT: nothing is typed anywhere, the note is only taken for the record. Any tab of this server can be messaged; read it first with clave_read_session to learn what it is doing, and message it only when you need it to act, never to report progress to a tab that did not ask: an unasked message becomes that agent\'s next instruction. Refused for plain terminals (typed text would run as a shell command). A tab that has ended is refused unless resume is true, which resumes it first (clave_resume_session) and then delivers.',
      inputSchema: {
        sessionId: z.string(),
        message: boundedText,
        resume: z
          .boolean()
          .optional()
          .describe('When the target has ended, resume it first and then deliver (default false)')
      }
    },
    async (args) =>
      text(
        await sendToTarget(
          targetHost,
          { ref: args.sessionId, message: args.message, resume: args.resume === true },
          {
            // This server keeps no exchange record: the checkpoint is taken
            // and typed nowhere, and the answer says it was not logged.
            checkpoint: () => false,
            type: async (target, text) => {
              const outcome = await sessions.type(target.id, text)
              return { submitted: outcome.submitted, draftHandling: outcome.draftHandling }
            },
            resume: async (target) => {
              await sessions.restart(target.id, {}, false, true)
            }
          }
        )
      )
  )
  server.registerTool(
    'clave_resume_session',
    {
      description:
        'Resume a stopped tab on this server ("resume the tab", "bring the lane back"): the same tab, its agent started again under the same id with its conversation resumed where the provider can, on the model and in the permission mode it was last running. Any tab of this server can be resumed; a running tab is refused. Read a tab first with clave_read_session to learn what it is doing.',
      inputSchema: {
        sessionId: z.string().describe('Target: a session id, an exact tab name, or "parent"')
      }
    },
    async (args) =>
      text(
        await resumeTarget(targetHost, args.sessionId, async (target) => {
          const result = await sessions.restart(target.id, {}, false, true)
          return { resumed: result.resumed }
        })
      )
  )
  server.registerTool(
    'clave_routine_report',
    {
      description:
        'You are a Clave routine run: report your result. Call this ONCE when the job is done, with status (ok | attention | failed), a one-line headline, a markdown summary and data matching the routine schema named in your first message. Invalid data is refused with the errors: correct it and call again. A run that ends without a valid report counts as failed. Refused from any session that is not a routine run.',
      inputSchema: {
        status: z.enum(['ok', 'attention', 'failed']),
        headline: z.string().min(1).max(120),
        summary: z.string().min(1).max(4000),
        data: z.unknown()
      }
    },
    async (args) => {
      if (!options.routines)
        return {
          content: [{ type: 'text', text: 'This server runs no routines.' }],
          isError: true
        }
      try {
        const result = await options.routines.report({
          sessionId,
          status: args.status,
          headline: args.headline,
          summary: args.summary,
          data: args.data
        })
        return text({ ok: true, ...result })
      } catch (error) {
        const lines = [message(error)]
        if (error instanceof RoutineReportRefusal) lines.push(...error.errors.map((e) => `- ${e}`))
        return { content: [{ type: 'text', text: lines.join('\n') }], isError: true }
      }
    }
  )
  // ── PRDCT-4472: a session's HTML artefact, opened on this server for the calling session ──
  const artefacts = options.artefacts
  if (artefacts)
    server.registerTool(
      OPEN_ARTEFACT_TOOL,
      { description: OPEN_ARTEFACT_DESCRIPTION_SERVER, inputSchema: openArtefactSchema },
      async ({ path }) => {
        try {
          return text(openedAnswer(await artefacts.open(sessionId, path)))
        } catch (error) {
          return { content: [{ type: 'text', text: message(error) }], isError: true }
        }
      }
    )
  // ── PRDCT-4243: the routine tools, over this server alone ──
  if (options.routines && options.routineTools) {
    const { routines, routineTools } = options
    registerRoutineTools(server, {
      machines: async () => [
        {
          id: 'local',
          label: routineTools.ownName(),
          routines: {
            list: async () => routines.list(),
            create: (input) => routines.create(input),
            update: (key, patch) => routines.update(key, patch),
            delete: (key) => routines.delete(key),
            pause: (key, paused) => routines.pause(key, paused),
            runNow: (key) => routines.runNow(key),
            moveToFile: (key, input) => routines.moveToFile(key, input)
          },
          workspaces: routineTools.workspaces
        }
      ]
    })
  }
  return server
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk)
    length += bytes.length
    if (length > 256 * 1024) throw new Error('MCP body exceeds limit')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

export async function startStandaloneMcp(options: StandaloneMcpOptions): Promise<{
  readonly url: string
  readonly close: () => Promise<void>
}> {
  const sockets = new Set<Socket>()
  const active = new Set<McpServer>()
  const parents: Parents = new Map()
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.url !== '/mcp') {
      response.writeHead(404).end()
      return
    }
    // Derive identity only from the existing per-session token store.
    const auth = request.headers.authorization
    const owner = auth?.startsWith('Bearer ')
      ? options.agentTools.resolve(auth.slice(7))
      : undefined
    if (!owner || !options.sessions.get(owner.sessionId)) {
      response.writeHead(401).end()
      return
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end()
      return
    }
    let body: unknown
    try {
      body = await readBody(request)
    } catch {
      response.writeHead(400).end()
      return
    }
    const server = buildServer(options, owner.sessionId, parents)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    active.add(server)
    response.once('close', () => {
      active.delete(server)
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(request, response, body)
  }
  const node = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500).end()
      else response.end()
    })
  })
  node.requestTimeout = 10_000
  node.headersTimeout = 10_000
  node.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    node.once('error', reject)
    node.listen(0, '127.0.0.1', () => {
      node.off('error', reject)
      resolve()
    })
  })
  const address = node.address()
  if (!address || typeof address === 'string') throw new Error('MCP listener unavailable')
  let closing: Promise<void> | undefined
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () =>
      (closing ??= (async () => {
        const closed = new Promise<void>((resolve) => node.close(() => resolve()))
        for (const server of active) await server.close()
        for (const socket of sockets) socket.destroy()
        await closed
      })())
  }
}
