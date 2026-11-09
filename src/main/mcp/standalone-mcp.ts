/** Agent MCP belongs to the standalone server. Local provider processes use
 * loopback and per-session tokens, independently of every desktop client. */
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { AgentTokensService, RoutinesService, SessionHostService } from '@clave/server'
import { RoutineReportRefusal } from '../routines/service'
import { SERVER_LAYOUT_KEY } from '@clave/contract/sidebar'
import type { SidebarLayouts } from '@clave/server/sidebar-layouts'
import { BUILT_IN_LAUNCH_PROFILES, type LauncherFamily } from '../../shared/agent-launch'
import {
  CHAT_PROFILE_IDS,
  resolveProfileRef,
  resolveSpawnModes
} from '../../shared/open-session-modes'
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
import type { Session, SessionRecord } from '@clave/contract/sessions'
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
}
/** The profiles every server offers: the terminal built-ins and the chat views. */
export const builtInProfileFamily = (id: string): LauncherFamily | undefined =>
  BUILT_IN_LAUNCH_PROFILES.find((p) => p.id === id)?.family ??
  (Object.entries(CHAT_PROFILE_IDS).find(([, profile]) => profile === id)?.[0] as
    | LauncherFamily
    | undefined)
/** Who opened which tab through `clave_open_session`, kept as long as this
 *  listener lives. The record's `openedBy` (PRDCT-4192) is what survives a
 *  restart of this server; this map is the word before the record is read. */
type Parents = Map<string, string>
/** The size a session with no pane starts at, as the desktop's hidden spawns. */
const HIDDEN_COLS = 120
const HIDDEN_ROWS = 30
const DESKTOP_ONLY = ['account', 'window', 'workspace'] as const
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
      if (record.claudeAgentsMode) return 'claude-agents'
      if (record.claudeMode) return 'claude'
      return 'terminal'
    }
    return ['claude', 'codex', 'antigravity', 'pi', 'claude-agents'].includes(session.provider)
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
  const server = new McpServer(
    { name: 'clave-server', version: '1' },
    {
      instructions:
        'Your Clave tools run on this server without a desktop. Ask the person for a plain value, a choice, a file, a link to open or a small form with clave_request_input (a form in their chat that lives across your turns; fill it from what they say with clave_input_set; clave_input_result reads it), for approval with clave_request_approval, for a secret with clave_request_secret. Calls return a requestId. Poll clave_request_result or clave_secret_result while pending; clients can answer later. Secret values and action output are never returned. Delegate work to a new tab with clave_open_session, then message it with clave_send_to_session (target "parent" to report back to the tab that opened yours; "mine" logs a checkpoint, typed nowhere), read it with clave_read_session, resume a stopped one with clave_resume_session and close it with clave_close_session; clave_create_group, clave_move_session and clave_rename organize the tabs. Sessions and paths are server-local.'
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
      description: 'List sessions owned by this server, including stopped records.',
      inputSchema: {}
    },
    async () =>
      text({
        sessions: sessions.list().map((s) => {
          const parentId = parentOf(s.id)
          return parentId ? { ...s, parentId } : s
        })
      })
  )
  server.registerTool(
    'clave_open_session',
    {
      description:
        'Open a new tab on this server: a Claude or Codex agent (in the chat view unless chat is false), an Antigravity or Pi agent, or a plain terminal, in an absolute directory, with an optional model, name, first prompt and group. With resume, the new tab continues a PAST conversation by its id. Returns the new sessionId; the tab is linked to its caller, so clave_list reports its parentId and clave_send_to_session and clave_read_session reach it.',
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
            'Reopen a PAST conversation by its id (a Claude session id, a Codex thread id or a Pi session id): the new agent tab continues it, in cwd. A tab of this server that already runs the conversation is answered as it is (alreadyOpen: true), nothing started; a stopped tab that still holds it is resumed in place. This server keeps no History of its own: a conversation it never held needs cwd, and starts fresh on the id when no transcript is found there. Agent modes only.'
          ),
        mode: z.enum(['claude', 'codex', 'antigravity', 'gemini', 'pi', 'terminal']).optional(),
        model: z.string().min(1).max(256).optional(),
        name: z.string().min(1).max(255).optional().describe('Display name for the new tab'),
        prompt: boundedText.optional().describe('First message an agent tab starts on'),
        command: boundedText.optional().describe('Shell command a terminal tab runs'),
        dangerous: z
          .boolean()
          .optional()
          .describe('Start a claude or codex agent without approval prompts'),
        chat: z
          .boolean()
          .optional()
          .describe(
            "Claude and Codex open in the chat view unless this is false, on the chat form of this server's default profile for the family (profile names another chat profile by its id)"
          ),
        profile: z.string().min(1).max(256).optional().describe('A launch profile id'),
        groupId: z.string().min(1).max(256).optional().describe('Group id from clave_create_group'),
        // Named so a desktop-shaped call fails clearly instead of being stripped.
        account: z.unknown().optional(),
        window: z.unknown().optional(),
        workspace: z.unknown().optional()
      }
    },
    async (args) => {
      const unsupported = DESKTOP_ONLY.filter((key) => args[key] !== undefined)
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
          if (held.kind === 'stopped') {
            const restarted = await sessions.restart(held.sessionId, {}, false, true)
            resumed = restarted.resumed
          }
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
                : 'A stopped tab of this server held this conversation; it was resumed in place.'
          })
        }
        if (mode === 'terminal')
          throw new Error(
            'resume continues an agent conversation: pass an agent mode, not terminal.'
          )
      }
      if (args.cwd === undefined)
        throw new Error(
          'cwd is required unless resume names a conversation a tab of this server still holds.'
        )
      if (!isAbsolute(args.cwd)) throw new Error('cwd must be an absolute path.')
      const directory = await stat(args.cwd).catch(() => undefined)
      if (!directory?.isDirectory()) throw new Error(`no such directory: ${args.cwd}`)
      const groupId = args.groupId === undefined ? null : knownGroup(args.groupId)
      const { claudeMode, antigravityMode, codexMode, piMode, dangerousMode, model, family } =
        resolveSpawnModes({
          mode,
          ...(args.dangerous !== undefined ? { dangerous: args.dangerous } : {}),
          ...(args.model !== undefined ? { model: args.model } : {})
        })
      const launchProfileId = resolveProfileRef(
        {
          mode,
          // The chat view is the standalone default; a named profile decides for itself.
          chat:
            args.chat ?? (args.profile === undefined && (mode === 'claude' || mode === 'codex')),
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
      const terminal = mode === 'terminal'
      // The new tab lands beside its caller (PRDCT-4150): the caller's
      // workspace, read from its record (the live session on the wire
      // carries none), goes on the start. A caller with no workspace leaves
      // the tab as the host stamps it today; the agent never picks one.
      const workspaceId = callerWorkspace(sessionId)
      const info = await sessions.start({
        cwd: args.cwd,
        options: {
          claudeMode,
          antigravityMode,
          codexMode,
          piMode,
          dangerousMode,
          ...(model !== undefined ? { model } : {}),
          ...(launchProfileId !== undefined ? { launchProfileId } : {}),
          ...(resume !== undefined ? { resumeSessionId: resume } : {}),
          ...(terminal && args.command ? { initialCommand: args.command } : {}),
          autoExecute: terminal && !!args.command,
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
