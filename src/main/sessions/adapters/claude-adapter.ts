import { EventEmitter } from 'node:events'
import { UnconfirmedSessionWrite } from '@clave/contract/session-write-error'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { REQUEST_GONE } from '../../../shared/request-refusals'
import { z } from 'zod'
import {
  SessionInputSchema,
  userMessageEvent,
  providerPrompt,
  AgentQuestionSchema,
  type SessionInput,
  type UserMessageInput,
  type SessionEvent,
  type BackgroundTask,
  type HistoryItem,
  type ModelOption,
  type CommandOption,
  type PermissionModeOption,
  type SessionControl,
  flattenAnswers
} from '../../../shared/session-model'
import { buildAgentArgv, claudeProfilePermissions } from '../../../shared/agent-launch'
import { isValidModelName } from '../../../shared/model-name'
import { effortLabel, isValidEffort } from '../../../shared/effort'
import {
  CLAUDE_MODELS,
  claudeContextWindow,
  claudeModelName,
  earlierClaudeIds,
  findClaudeModel,
  isDefaultClaudeAlias
} from '../../../shared/claude-models'
import type {
  SessionAdapter,
  SessionAdapterEvents,
  SessionHandle,
  SpawnSpec,
  Unsubscribe
} from '../adapter'
import { findExecutable, resolvePosixShellLaunch } from '../../shell-launch'
import { launchProfileManager } from '../../launch-profile-manager'
import { lazyTerminalPorts } from '../../ports/terminals'
import {
  accountTokenForSpawn,
  buildSpawnEnv,
  getLoginShellEnv,
  getUserShell,
  buildClaudeHookSettingsArg,
  shellSingleQuote,
  isValidClaudeSessionId,
  type PtySpawnOptions
} from './pty-backend'
import { NdjsonLines } from './ndjson'
import { replayClaudeTranscript } from '@clave/session-bridge/readers/claude'
import { toHistoryItems } from './bridge-history'
import { commandTitle } from '../../../shared/command-title'

const object = z.record(z.string(), z.unknown())
const envelope = object.and(z.object({ type: z.string() }))
const optionsSchema = z.object({
  resume: z.string().optional(),
  model: z.string().optional(),
  /** The reasoning effort to start on (`--effort`), the one last picked. */
  effort: z.string().refine(isValidEffort).optional(),
  permissionMode: z
    .enum(['manual', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'])
    .optional(),
  /** Bypass offered as a mode without starting in it (`--allow-dangerously-skip-permissions`). */
  allowDangerous: z.boolean().optional()
})
type Permission = { input: unknown; suggestions: unknown[] }
/** The modes a running session can be switched between, in the order the
 *  TUI's Shift+Tab cycles them. The CLI names the ask-every-time mode `manual`
 *  on its command line and `default` once it runs; this file speaks the
 *  running name. `auto` is offered and may be refused (it depends on the
 *  model), and the refusal reaches the reader in the CLI's own words. */
const PERMISSION_MODES: PermissionModeOption[] = [
  { id: 'default', label: 'Manual' },
  { id: 'acceptEdits', label: 'Accept edits' },
  { id: 'plan', label: 'Plan' },
  { id: 'auto', label: 'Auto' }
]
/** Bypass is only reachable in a session LAUNCHED on it: the CLI refuses the
 *  switch otherwise, as the TUI leaves it out of its cycle. */
const BYPASS_MODE: PermissionModeOption = { id: 'bypassPermissions', label: 'Bypass permissions' }
const runningMode = (mode: string): string => (mode === 'manual' ? 'default' : mode)
/** The tokens a call's context held: what it read, cached or not, and wrote. */
function contextTokens(usage: unknown): number {
  const u = object.safeParse(usage).data ?? {}
  const n = (key: string): number => (typeof u[key] === 'number' ? (u[key] as number) : 0)
  return (
    n('input_tokens') +
    n('cache_read_input_tokens') +
    n('cache_creation_input_tokens') +
    n('output_tokens')
  )
}

/** One translator per process: partial messages and completed snapshots overlap. */
/** The CLI only names its commands in the init frame, which only follows the
 *  first message; a session that has not spoken yet is served the last list a
 *  session in the same folder received (the built-ins plus the skills found
 *  there), else the last list seen anywhere. */
const lastCommandsByCwd = new Map<string, string[]>()
let lastCommandsAnywhere: string[] = []
const toCommands = (names: string[]): CommandOption[] =>
  names.map((name) => ({ name, insert: `/${name} ` }))
type InitializeRequest = {
  resolve: (response: Record<string, unknown>) => void
  reject: (error: Error) => void
  /** The control request asked: `initialize`, or the type of one a view sent,
   *  whose answer may be a bare success and whose refusal is its own. */
  what: string
}
/** How long a menu waits on the CLI's initialize answer before calling it unavailable. */
const INITIALIZE_TIMEOUT_MS = 20_000
/** The CLI's control request body for one a view may send; the switch is
 *  exhaustive, so a request added to the union and not mapped here fails the
 *  typecheck rather than reaching the CLI as something else. */
function controlBody(request: SessionControl): Record<string, unknown> {
  switch (request.type) {
    case 'mcp_status':
      return { subtype: 'mcp_status' }
    case 'mcp_toggle':
      return { subtype: 'mcp_toggle', serverName: request.server, enabled: request.enabled }
    case 'mcp_reconnect':
      return { subtype: 'mcp_reconnect', serverName: request.server }
    case 'mcp_authenticate':
      return { subtype: 'mcp_authenticate', serverName: request.server }
    case 'mcp_clear_auth':
      return { subtype: 'mcp_clear_auth', serverName: request.server }
    case 'reload_plugins':
      return { subtype: 'reload_plugins' }
    default: {
      const never: never = request
      throw new Error(`Unknown control request: ${JSON.stringify(never)}`)
    }
  }
}
/** How long a view waits on a control request: a reconnect or the start of a
 *  sign-in can take far longer than the initialize answer. */
const CONTROL_TIMEOUT_MS = 60_000
/** The host's own commands, offered before the CLI's: the chat view acts on
 *  them itself rather than sending them to the agent. Each is a menu in the
 *  TUI that headless Claude answers with a line of text, or not at all. */
export const HOST_COMMANDS: CommandOption[] = [
  { name: 'resume', description: 'Resume a past conversation from this folder', insert: '/resume' },
  { name: 'mcp', description: 'Manage MCP servers', insert: '/mcp' },
  { name: 'plugin', description: 'Manage plugins', insert: '/plugin' }
]
/** The CLI's own acknowledgement of an interrupt, written into the
 *  conversation as a user text block: "[Request interrupted by user]", or
 *  "[Request interrupted by user for tool use]" when a tool was running. */
function isInterruptNotice(text: unknown): boolean {
  return typeof text === 'string' && /^\[Request interrupted by user/.test(text.trim())
}
/** Where Claude Code keeps a conversation: `<root>/<cwd, dashed>/<id>.jsonl`,
 *  else wherever in the root a file of that id is (the cwd may have moved). */
export function findTranscript(id: string, cwd: string, configDir?: string): string | null {
  const root = configDir
    ? join(configDir, 'projects')
    : process.env.CLAVE_TRANSCRIPTS_ROOT || join(homedir(), '.claude', 'projects')
  const direct = join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`)
  if (existsSync(direct)) return direct
  try {
    for (const dir of readdirSync(root)) {
      const candidate = join(root, dir, `${id}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // No transcript store at all: nothing to replay.
  }
  return null
}
export class ClaudeStreamTranslator {
  readonly permissions = new Map<string, Permission>()
  /** The pending requests that are AskUserQuestion, answered with `answers`. */
  readonly questionRequests = new Set<string>()
  /** The slash commands (skills included) the CLI named at init. */
  commands: string[] | null = null
  /** request_id → the model a set_model control request asked for. */
  readonly modelRequests = new Map<string, string | null>()
  /** request_id → the mode a set_permission_mode control request asked for. */
  readonly modeRequests = new Map<string, string>()
  /** request_id → the task a stop_task control request asked to stop. */
  readonly stopRequests = new Map<string, string>()
  /** request_id → the level an apply_flag_settings request asked for. */
  readonly effortRequests = new Map<string, string>()
  /** The get_settings requests in flight: each answer names the effort the
   *  session really runs at, which is what the composer shows. */
  readonly settingsRequests = new Set<string>()
  /** Ask the CLI for its settings; the adapter sets it once the process can
   *  be written to. Called after every switch the CLI confirmed, since a
   *  model switch can change the effort too (Haiku runs at none). */
  requestSettings: () => void = () => {}
  /** The get_context_usage requests in flight: each answer names the window
   *  of the model the session runs on, which nothing else says before a turn
   *  ends (a resumed transcript never does, and the settings name the model
   *  without its `[1m]`). */
  readonly contextRequests = new Set<string>()
  /** Ask the CLI how full the context is; the adapter sets it once the
   *  process can be written to. Called at ready and after every switch the
   *  CLI confirmed, since a switch can change the window. */
  requestContext: () => void = () => {}
  /** What a `permission_mode` event offers; the adapter sets it at launch. */
  modes: PermissionModeOption[] = PERMISSION_MODES
  /** The main thread's context after its last call, and the model's window. */
  private contextUsed: number | null = null
  private contextWindow: number | null = null
  /** Each running subagent's own context, by the call that started it. */
  private readonly subagentContext = new Map<string, number>()
  /** Each subagent's model, once its first answer has named it. */
  private readonly subagentModels = new Map<string, string>()
  private publishUsage(): void {
    if (this.contextUsed === null) return
    this.emit({ type: 'context_usage', used: this.contextUsed, window: this.contextWindow })
  }
  /** request_id → the caller waiting on one of our control requests' answer. */
  readonly listRequests = new Map<string, InitializeRequest>()
  private streamed = false
  private finished = false
  private tools = new Set<string>()
  /** The turn in flight was stopped by the reader: set when the adapter sends
   *  the interrupt and when the CLI writes its own "[Request interrupted by
   *  user]" acknowledgement, consumed by the result that closes the turn.
   *  That result says `is_error` with no text, which read as a failure. */
  interrupted = false
  /** task_id → the work the CLI reports running in the background. */
  private readonly background = new Map<string, BackgroundTask>()
  /** tool_use_id → the output file its "running in background" result named. */
  private readonly outputFiles = new Map<string, string>()
  /** tool_use_id → a Bash call's command and the title the model gave it,
   *  so a background shell reads by that title rather than by the command
   *  the CLI echoes. Bounded: only the recent calls can still be promoted. */
  private readonly bashCalls = new Map<string, { command: string; title?: string }>()
  /** A list held back because it named a task its call is not known for. */
  private heldList = false
  /** task_id → the call of a task the turn waits on (a foreground
   *  task_started names both). Never listed; kept so that a list naming the
   *  task later (the command moved to the background) links it to its call.
   *  Forgotten at the task's end, at the turn's end and at the CLI's exit. */
  private readonly foregroundCalls = new Map<string, string>()
  constructor(private readonly send: (event: SessionEvent) => void) {}
  /** Every event a view reads goes out after a held list, so holding one
   *  never changes what came first. The raw frame does not wait. */
  private emit(event: SessionEvent): void {
    if (this.heldList && event.type !== 'provider_event' && event.type !== 'background_tasks')
      this.publishBackground()
    this.send(event)
  }
  /** Publish the background list whole; a snapshot replaces the last. */
  private publishBackground(): void {
    this.heldList = false
    this.send({ type: 'background_tasks', tasks: [...this.background.values()] })
  }
  /** The CLI names a new background task in its list before the
   *  task_started that names its call, in the same write (Claude Code,
   *  claude-stream/background-bash.ndjson). Published at once, the task has
   *  no call yet and a view shows it twice for a moment, beside the call's
   *  own card. So such a list waits for the end of the read it came in: the
   *  task_started that links it, any event a view reads, or the read's end
   *  publishes it, linked or not. */
  private holdList(): void {
    if (this.heldList) return
    this.heldList = true
    queueMicrotask(() => {
      if (this.heldList) this.publishBackground()
    })
  }
  /** Nothing outlives the CLI: its exit empties the list, once. */
  clearBackground(): void {
    this.heldList = false
    this.foregroundCalls.clear()
    if (!this.background.size) return
    this.background.clear()
    this.publishBackground()
  }
  /**
   * The CLI's own record of background work, which is what lets the chat say
   * "still running" after the turn ends. `background_tasks_changed` is the
   * authoritative list — a task it no longer names is gone, which is how the
   * list clears itself instead of keeping a dead task "running" — and the
   * per-task frames fill in what the list lacks (the tool call, the output
   * file) and retire a task even from a CLI that never sends the list.
   * Returns false for any frame that is not one of these.
   */
  private backgroundFrame(p: Record<string, unknown>): boolean {
    const kindOf = (type: unknown): BackgroundTask['kind'] =>
      typeof type !== 'string'
        ? 'other'
        : /bash|shell/.test(type)
          ? 'shell'
          : /agent/.test(type)
            ? 'agent'
            : 'other'
    const track = (id: string, type: unknown, description: unknown, toolUseId?: string): void => {
      const known = this.background.get(id)
      const tool = toolUseId ?? known?.toolUseId ?? this.foregroundCalls.get(id)
      this.foregroundCalls.delete(id)
      const outputFile = known?.outputFile ?? (tool ? this.outputFiles.get(tool) : undefined)
      const kind = known?.kind ?? kindOf(type)
      const said = typeof description === 'string' && description ? description : undefined
      // A shell reads by the title its call gave it, else by the name the CLI
      // lists it under (its own prose, or the command shortened). The whole
      // command rides along for a tooltip.
      const call = kind === 'shell' && tool ? this.bashCalls.get(tool) : undefined
      const command = kind === 'shell' ? (call?.command ?? known?.command ?? said) : undefined
      this.background.set(id, {
        id,
        kind,
        description:
          call?.title ||
          (kind === 'shell' && said ? commandTitle(said) : said) ||
          known?.description ||
          (call ? commandTitle(call.command) : id),
        ...(command ? { command } : {}),
        startedAt: known?.startedAt ?? Date.now(),
        ...(tool ? { toolUseId: tool } : {}),
        ...(outputFile ? { outputFile } : {})
      })
    }
    if (p.subtype === 'background_tasks_changed') {
      const tasks = z
        .array(z.object({ task_id: z.string(), task_type: z.unknown(), description: z.unknown() }))
        .catch([])
        .parse(p.tasks)
      const live = new Set(tasks.map((t) => t.task_id))
      for (const id of this.background.keys()) if (!live.has(id)) this.background.delete(id)
      const unlinked = tasks.some((t) => !this.background.get(t.task_id)?.toolUseId)
      for (const t of tasks) track(t.task_id, t.task_type, t.description)
      if (unlinked && [...this.background.values()].some((t) => !t.toolUseId)) {
        this.holdList()
        return true
      }
    } else if (p.subtype === 'task_started') {
      // A foreground task (a subagent or a command the turn waits on) is the
      // turn's own work, already on screen as its tool call: not listed, its
      // call remembered in case the CLI lists it later.
      if (typeof p.task_id !== 'string') return true
      if (p.is_backgrounded === false) {
        if (typeof p.tool_use_id === 'string') this.foregroundCalls.set(p.task_id, p.tool_use_id)
        return true
      }
      track(
        p.task_id,
        p.task_type,
        p.description,
        typeof p.tool_use_id === 'string' ? p.tool_use_id : undefined
      )
    } else if (p.subtype === 'task_updated') {
      const status = z.object({ status: z.string() }).safeParse(p.patch)
      if (!status.success || status.data.status === 'running' || typeof p.task_id !== 'string')
        return true
      this.foregroundCalls.delete(p.task_id)
      if (!this.background.delete(p.task_id)) return true
    } else if (p.subtype === 'task_notification') {
      if (typeof p.task_id !== 'string') return true
      this.foregroundCalls.delete(p.task_id)
      if (!this.background.delete(p.task_id)) return true
    } else return false
    // A held list waits while a task it named is still unlinked; the read's
    // end publishes it either way.
    if (this.heldList && [...this.background.values()].some((t) => !t.toolUseId)) return true
    this.publishBackground()
    return true
  }
  /** A control_response answering one of our own control requests (initialize,
   *  or one a view sent); false for any other. */
  private listRequest(p: Record<string, unknown>): boolean {
    const response = z
      .object({
        request_id: z.string(),
        subtype: z.enum(['success', 'error']),
        error: z.string().optional(),
        response: object.optional()
      })
      .safeParse(p.response)
    if (!response.success) return false
    const request = this.listRequests.get(response.data.request_id)
    if (!request) return false
    this.listRequests.delete(response.data.request_id)
    if (response.data.subtype === 'success' && response.data.response)
      request.resolve(response.data.response)
    else if (response.data.subtype === 'success' && request.what !== 'initialize')
      request.resolve({})
    else
      request.reject(
        new Error(
          response.data.error ??
            (request.what === 'initialize'
              ? 'Claude did not answer initialize'
              : 'Claude refused the request')
        )
      )
    return true
  }
  /** Tell the reader the mode the CLI is in now. */
  publishMode(mode: string): void {
    const id = runningMode(mode)
    const modes = this.modes.some((m) => m.id === id)
      ? this.modes
      : [...this.modes, { id, label: id }]
    this.emit({ type: 'permission_mode', mode: id, modes })
  }
  /** A control_response answering one of our set_permission_mode requests;
   *  false for any other. The CLI refuses a mode it cannot enter (auto on a
   *  model without it, bypass in a session not launched on it) with a reason
   *  worth showing as it stands. */
  private modeRequest(p: Record<string, unknown>): boolean {
    const response = z
      .object({
        request_id: z.string(),
        subtype: z.enum(['success', 'error']),
        error: z.string().optional(),
        response: z.object({ mode: z.string() }).optional()
      })
      .safeParse(p.response)
    if (!response.success || !this.modeRequests.has(response.data.request_id)) return false
    const asked = this.modeRequests.get(response.data.request_id)!
    this.modeRequests.delete(response.data.request_id)
    if (response.data.subtype === 'success') this.publishMode(response.data.response?.mode ?? asked)
    else
      this.emit({
        type: 'error',
        message: response.data.error ?? `Claude refused to switch to ${asked}`,
        fatal: false
      })
    return true
  }
  /** A control_response answering one of our stop_task requests; false for
   *  any other. A stop the CLI takes needs no word: the task's own frames
   *  retire it from the background list. A refusal is the reader's to see. */
  private stopRequest(p: Record<string, unknown>): boolean {
    const response = z
      .object({
        request_id: z.string(),
        subtype: z.enum(['success', 'error']),
        error: z.string().optional()
      })
      .safeParse(p.response)
    if (!response.success || !this.stopRequests.has(response.data.request_id)) return false
    const task = this.stopRequests.get(response.data.request_id)
    this.stopRequests.delete(response.data.request_id)
    if (response.data.subtype === 'error')
      this.emit({
        type: 'error',
        message: response.data.error ?? `Claude could not stop ${task}`,
        fatal: false
      })
    return true
  }
  /** A control_response answering one of our apply_flag_settings requests
   *  (an effort switch); false for any other. The CLI acknowledges any value
   *  without saying what it applied, so the answer is read back from its
   *  settings rather than taken from the request. */
  private effortRequest(p: Record<string, unknown>): boolean {
    const response = z
      .object({
        request_id: z.string(),
        subtype: z.enum(['success', 'error']),
        error: z.string().optional()
      })
      .safeParse(p.response)
    if (!response.success || !this.effortRequests.has(response.data.request_id)) return false
    const effort = this.effortRequests.get(response.data.request_id)!
    this.effortRequests.delete(response.data.request_id)
    if (response.data.subtype === 'success') this.requestSettings()
    else
      this.emit({
        type: 'error',
        message: response.data.error ?? `Claude refused the ${effortLabel(effort)} effort`,
        fatal: false
      })
    return true
  }
  /** A control_response answering one of our get_settings requests; false for
   *  any other. `applied.effort` is the level the session runs at, null for a
   *  model that takes none. */
  private settingsRequest(p: Record<string, unknown>): boolean {
    const response = z
      .object({
        request_id: z.string(),
        subtype: z.enum(['success', 'error']),
        response: z.unknown().optional()
      })
      .safeParse(p.response)
    if (!response.success || !this.settingsRequests.has(response.data.request_id)) return false
    this.settingsRequests.delete(response.data.request_id)
    const applied = object.safeParse(object.safeParse(response.data.response).data?.applied).data
    if (response.data.subtype !== 'success' || !applied) return true
    // The model the session runs on, as the CLI applied it (PRDCT-4256): the
    // launch's `--model`, else the user's own setting, else the account's
    // default, resolved to its id ("claude-sonnet-5-5"). Asked at ready, so
    // the chip names it before the first message; asked again after a switch,
    // so it confirms the switch. The `default` alias is not a model.
    const model = applied.model
    if (typeof model === 'string' && isValidModelName(model) && !isDefaultClaudeAlias(model))
      this.emit({ type: 'session_meta', model, providerSessionId: null })
    const effort = applied.effort
    // A CLI too old to report what it applied says nothing, and nothing is shown;
    // neither is a value that is not a level.
    if (!('effort' in applied)) return true
    if (effort === null || effort === undefined) this.emit({ type: 'effort', effort: null })
    else if (typeof effort === 'string' && isValidEffort(effort))
      this.emit({ type: 'effort', effort })
    return true
  }
  /** A control_response answering one of our get_context_usage requests;
   *  false for any other. The CLI names its model's window (`maxTokens`) with
   *  no turn and no token, a resumed conversation included, so the meter
   *  fills to its count on a model Clave's table does not list (PRDCT-4456).
   *  The count stays the last call's when there is one (a resumed
   *  conversation's replay), so the meter does not jump; before any call it
   *  is the CLI's own (`totalTokens`). A CLI that does not know the request
   *  answers an error, and the meter keeps what it had. */
  private contextRequest(p: Record<string, unknown>): boolean {
    const response = z
      .object({
        request_id: z.string(),
        subtype: z.enum(['success', 'error']),
        response: z.unknown().optional()
      })
      .safeParse(p.response)
    if (!response.success || !this.contextRequests.has(response.data.request_id)) return false
    this.contextRequests.delete(response.data.request_id)
    if (response.data.subtype !== 'success') return true
    const usage = z
      .object({
        maxTokens: z.number().int().positive(),
        totalTokens: z.number().int().nonnegative().optional()
      })
      .safeParse(response.data.response)
    if (!usage.success) return true
    const used = this.contextUsed ?? usage.data.totalTokens ?? null
    if (used === this.contextUsed && usage.data.maxTokens === this.contextWindow) return true
    this.contextUsed = used
    this.contextWindow = usage.data.maxTokens
    this.publishUsage()
    return true
  }
  /** A control_response answering one of our set_model requests; false for any other. */
  private modelRequest(p: Record<string, unknown>): boolean {
    const response = z
      .object({
        request_id: z.string(),
        subtype: z.enum(['success', 'error']),
        error: z.string().optional()
      })
      .safeParse(p.response)
    if (!response.success || !this.modelRequests.has(response.data.request_id)) return false
    const model = this.modelRequests.get(response.data.request_id) ?? null
    this.modelRequests.delete(response.data.request_id)
    if (response.data.subtype === 'success') {
      this.emit({ type: 'session_meta', model, providerSessionId: null })
      // The CLI answers set_model once the switch is done, not before: only
      // now do get_settings and get_context_usage describe the new model.
      this.requestSettings()
      this.requestContext()
    } else
      this.emit({
        type: 'error',
        message:
          response.data.error ?? `Claude refused to switch to ${model ?? 'the default model'}`,
        fatal: false
      })
    return true
  }
  /** A resumed conversation's past, read from its transcript as the events a
   *  live turn would have produced, each with the moment the transcript gives
   *  it: the CLI resumes it without repeating it, so a view would otherwise
   *  open on an empty page. Returned, never streamed: a view asks for it a page
   *  at a time (`sessions:history`), the newest first. The reader is the
   *  session bridge's (PRDCT-4301, `bridge-history.ts` says what the chat
   *  keeps for itself); the past's tool ids are learnt here, so a live frame
   *  that names one again is not emitted twice. */
  replay(lines: Iterable<string>): HistoryItem[] {
    const items = toHistoryItems(replayClaudeTranscript(lines), { wrappers: 'drop' })
    for (const { event } of items) {
      if (event.type === 'tool_call') this.tools.add(event.id)
      // The context as the conversation left it: the count the view shows
      // from the replay, which the CLI's window joins at ready.
      else if (event.type === 'context_usage' && !event.parent) this.contextUsed = event.used
    }
    return items
  }
  line(line: string): void {
    try {
      this.translate(envelope.parse(JSON.parse(line)))
    } catch {
      this.emit({ type: 'error', message: 'Malformed Claude stream JSON or event', fatal: false })
    }
  }
  private translate(p: Record<string, unknown> & { type: string }): void {
    const fallback = (): void =>
      this.emit({ type: 'provider_event', provider: 'claude', payload: p })
    if (p.type === 'system' && p.subtype === 'init') {
      const names = z.array(z.string()).safeParse(p.slash_commands)
      if (names.success) this.commands = names.data
      this.emit({
        type: 'session_meta',
        model: typeof p.model === 'string' ? p.model : null,
        providerSessionId: typeof p.session_id === 'string' ? p.session_id : null
      })
      if (typeof p.permissionMode === 'string') this.publishMode(p.permissionMode)
      this.emit({ type: 'state_change', state: 'working' })
    } else if (p.type === 'system' && p.subtype === 'status') {
      // The CLI reports a mode change it made itself (leaving plan mode once
      // the plan is approved) as it reports ours.
      if (typeof p.permissionMode === 'string') this.publishMode(p.permissionMode)
      fallback()
    } else if (p.type === 'system' && this.backgroundFrame(p)) {
      // Kept on the stream too: a view may still read the raw frame.
      fallback()
    } else if (p.type === 'stream_event') {
      const e = envelope.parse(p.event)
      if (e.type === 'message_start') {
        this.streamed = false
        this.finished = false
        fallback()
      } else if (e.type === 'content_block_delta' && object.parse(e.delta).type === 'text_delta') {
        const delta = z.object({ text: z.string() }).parse(e.delta)
        this.streamed = true
        this.emit({ type: 'assistant_text', delta: delta.text, final: false })
      } else if (e.type === 'message_stop') {
        this.finish()
      } else fallback()
    } else if (p.type === 'assistant' || p.type === 'user') {
      // Replayed user acknowledgements may carry plain text, not tool blocks.
      // The local write already echoed it; retain the provider frame without
      // duplicating the conversation row or calling valid JSON malformed.
      if (p.type === 'user' && typeof object.parse(p.message).content === 'string') {
        fallback()
        return
      }
      const message = z.object({ content: z.array(object) }).parse(p.message)
      // A subagent's frames name the call that started it; its usage is its
      // own context, never the conversation's.
      const parent = typeof p.parent_tool_use_id === 'string' ? p.parent_tool_use_id : undefined
      for (const block of message.content) {
        // A subagent's own words: its brief (the user text its call gave it)
        // and what it says, whole, since the CLI streams nothing of a
        // subagent (claude-stream/README.md). Each carries its parent, so a
        // view of that agent reads them and the transcript never does; the
        // conversation's own streaming state is not theirs to touch.
        if (parent && block.type === 'text' && typeof block.text === 'string') {
          if (p.type === 'user' && block.text.trim())
            this.emit({ type: 'user_message', text: block.text, parent })
          else if (p.type === 'assistant' && block.text.trim())
            this.emit({ type: 'assistant_text', delta: block.text, final: true, parent })
        } else if (block.type === 'text' && p.type === 'user' && isInterruptNotice(block.text)) {
          this.interrupted = true
        } else if (block.type === 'text' && p.type === 'assistant' && !this.streamed) {
          this.emit({ type: 'assistant_text', delta: z.string().parse(block.text), final: false })
        } else if (block.type === 'tool_use') {
          const tool = z
            .object({ id: z.string(), name: z.string(), input: z.unknown() })
            .parse(block)
          if (!this.tools.has(tool.id)) {
            this.tools.add(tool.id)
            if (tool.name === 'Bash' && !parent) this.noteBashCall(tool.id, tool.input)
            this.emit({ type: 'tool_call', ...tool, ...(parent ? { parent } : {}) })
          }
        } else if (block.type === 'tool_result') {
          this.noteOutputFile(z.string().parse(block.tool_use_id), block.content)
          // `is_error` is the only word anyone gets that the tool failed: the
          // content of a failed call is the error text and reads like any other
          // output. Dropping it here left every view guessing from prose.
          this.emit({
            type: 'tool_result',
            id: z.string().parse(block.tool_use_id),
            output: block.content,
            error: z.boolean().optional().catch(undefined).parse(block.is_error),
            ...(parent ? { parent } : {})
          })
        }
      }
      if (p.type === 'assistant') {
        // Every block of one message repeats its usage: announce a change only.
        const used = contextTokens(object.safeParse(p.message).data?.usage)
        if (!parent && used > 0 && used !== this.contextUsed) {
          this.contextUsed = used
          // Until a result names the window, the answering model says it.
          const model = z.object({ model: z.string() }).safeParse(p.message)
          if (this.contextWindow === null && model.success)
            this.contextWindow = claudeContextWindow(model.data.model)
          this.publishUsage()
        } else if (parent && used > 0 && used !== this.subagentContext.get(parent)) {
          this.subagentContext.set(parent, used)
          this.emit({ type: 'context_usage', used, window: null, parent })
        }
        const model = z.object({ model: z.string() }).safeParse(p.message)
        if (parent && model.success && this.subagentModels.get(parent) !== model.data.model) {
          this.subagentModels.set(parent, model.data.model)
          this.emit({ type: 'subagent_model', parent, model: model.data.model })
        }
      }
      // Preserve usage, thinking, attachments, and unknown content without duplicate text.
      fallback()
    } else if (
      p.type === 'control_response' &&
      (this.modelRequest(p) ||
        this.modeRequest(p) ||
        this.stopRequest(p) ||
        this.effortRequest(p) ||
        this.settingsRequest(p) ||
        this.contextRequest(p) ||
        this.listRequest(p))
    ) {
      // Answered above: the switch took or the CLI said why not; the list arrived or did not.
    } else if (p.type === 'control_request' && object.parse(p.request).subtype === 'can_use_tool') {
      const r = z
        .object({
          tool_name: z.string(),
          input: z.unknown(),
          permission_suggestions: z.array(z.unknown()).optional(),
          description: z.string().optional()
        })
        .parse(p.request)
      const id = z.string().parse(p.request_id)
      const suggestions = r.permission_suggestions ?? []
      const modeChanges = suggestions.flatMap((suggestion) => {
        const mode = z
          .object({
            type: z.literal('setMode'),
            mode: z.string(),
            destination: z.string().optional()
          })
          .safeParse(suggestion)
        return mode.success
          ? [`Switch ${mode.data.destination ?? 'session'} to ${mode.data.mode}`]
          : []
      })
      this.permissions.set(id, { input: r.input, suggestions })
      // AskUserQuestion reaches the host as a permission, but allowing it
      // unanswered hands the model an empty answer: the reply must carry the
      // reader's choices (`answers`, question → label) in its updated input.
      const questions =
        r.tool_name === 'AskUserQuestion'
          ? z.object({ questions: z.array(AgentQuestionSchema) }).safeParse(r.input)
          : undefined
      if (questions?.success) {
        this.questionRequests.add(id)
        this.emit({
          type: 'permission_request',
          id,
          description:
            questions.data.questions.length === 1
              ? questions.data.questions[0].question
              : `Claude asks ${questions.data.questions.length} questions`,
          toolName: r.tool_name,
          input: r.input,
          questions: questions.data.questions,
          options: [
            { id: 'answer', label: 'Submit' },
            { id: 'deny', label: 'Skip' }
          ]
        })
        this.emit({ type: 'state_change', state: 'blocked' })
        return
      }
      this.emit({
        type: 'permission_request',
        id,
        description: r.description
          ? `Allow ${r.tool_name}: ${r.description}`
          : `Allow ${r.tool_name}?`,
        toolName: r.tool_name,
        input: r.input,
        ...(r.description ? { detail: r.description } : {}),
        options: [
          { id: 'allow-once', label: 'Allow once' },
          ...(suggestions.length
            ? [
                {
                  id: 'allow-always',
                  label: modeChanges.length ? modeChanges.join('; ') : 'Allow suggested permissions'
                }
              ]
            : []),
          { id: 'deny', label: 'Deny' }
        ]
      })
      this.emit({ type: 'state_change', state: 'blocked' })
    } else if (p.type === 'control_cancel_request') {
      const id = z.string().parse(p.request_id)
      const held = this.permissions.delete(id)
      this.questionRequests.delete(id)
      fallback()
      // The views settle the card on this word: the raw frame never reaches
      // a window (`host.ts`, isRawWireFrame), and the card it left behind came
      // back ahead of the next request (PRDCT-4032).
      if (held) this.emit({ type: 'permission_withdrawn', id })
      if (!this.permissions.size) this.emit({ type: 'state_change', state: 'working' })
    } else if (p.type === 'result') {
      this.finish()
      // Nothing the turn waited on outlives it: a request still open is
      // withdrawn before the turn is said to be done.
      for (const id of this.permissions.keys()) this.emit({ type: 'permission_withdrawn', id })
      this.permissions.clear()
      this.questionRequests.clear()
      this.tools.clear()
      // Nothing the turn waited on outlives it.
      this.foregroundCalls.clear()
      if (p.is_error && this.interrupted) this.emit({ type: 'turn_interrupted' })
      else if (p.is_error)
        this.emit({
          type: 'error',
          message: typeof p.result === 'string' ? p.result : 'Claude turn failed',
          fatal: false
        })
      this.interrupted = false
      // The result names the window of every model the turn used; subagents
      // may run on a narrower one, so the conversation's is the widest.
      const windows = Object.values(object.safeParse(p.modelUsage).data ?? {}).map((usage) => {
        const w = object.safeParse(usage).data?.contextWindow
        return typeof w === 'number' ? w : 0
      })
      const widest = Math.max(0, ...windows)
      if (widest && widest !== this.contextWindow) {
        this.contextWindow = widest
        this.publishUsage()
      }
      fallback()
      this.emit({ type: 'state_change', state: 'done' })
      this.streamed = false
      this.finished = false
    } else fallback()
  }
  private noteBashCall(id: string, input: unknown): void {
    const call = z
      .object({ command: z.string(), description: z.string().optional() })
      .safeParse(input)
    if (!call.success) return
    const title = call.data.description?.trim()
    this.bashCalls.set(id, { command: call.data.command, ...(title ? { title } : {}) })
    if (this.bashCalls.size > 200) this.bashCalls.delete(this.bashCalls.keys().next().value!)
  }
  /** A background call's result names the file its output goes to; keep it
   *  for the task that call started, whichever of the two frames came first. */
  private noteOutputFile(toolUseId: string, content: unknown): void {
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
          : ''
    const file = /Output is being written to: (\S+?)\.?(?:\s|$)/.exec(text)?.[1]
    if (!file) return
    this.outputFiles.set(toolUseId, file)
    for (const task of this.background.values())
      if (task.toolUseId === toolUseId && !task.outputFile) {
        task.outputFile = file
        this.publishBackground()
      }
  }
  private finish(): void {
    if (this.finished) return
    this.finished = true
    this.emit({ type: 'assistant_text', delta: '', final: true })
  }
  response(id: string, optionId: string, answers?: Record<string, string>): unknown {
    const pending = this.permissions.get(id)
    if (!pending) throw new Error(`${REQUEST_GONE.claude}: ${id}`)
    const question = this.questionRequests.has(id)
    if (
      question
        ? !['answer', 'deny'].includes(optionId)
        : !['allow-once', 'allow-always', 'deny'].includes(optionId)
    )
      throw new Error('Invalid Claude permission option')
    if (optionId === 'allow-always' && !pending.suggestions.length)
      throw new Error('Invalid Claude permission option')
    if (optionId === 'answer' && (!answers || !Object.keys(answers).length))
      throw new Error('An answer needs at least one choice')
    this.permissions.delete(id)
    this.questionRequests.delete(id)
    if (optionId === 'answer')
      return {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: id,
          response: { behavior: 'allow', updatedInput: { ...object.parse(pending.input), answers } }
        }
      }
    return {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: id,
        response:
          optionId === 'deny'
            ? {
                behavior: 'deny',
                message: question ? 'The user skipped the question' : 'Denied by user'
              }
            : {
                behavior: 'allow',
                updatedInput: pending.input,
                ...(optionId === 'allow-always' ? { updatedPermissions: pending.suggestions } : {})
              }
      }
    }
  }
}

interface Live {
  handle: SessionHandle
  emitter: EventEmitter
  translator: ClaudeStreamTranslator
  start: () => ChildProcessWithoutNullStreams
  process?: ChildProcessWithoutNullStreams
  ended: boolean
  initialized: boolean
  ready: boolean
  initialPrompt?: string
  /** A whole message to send at ready, attachments prepared: the prompt an
   *  account's limit rejected, sent again on the account the tab moved to
   *  (ADR 0002). Consumed once, like `initialPrompt`. */
  initialInput?: UserMessageInput
  /** The last message the reader sent, as the provider received it. What a
   *  limit rejects is this one; the restart on the next account resends it. */
  lastUserMessage?: UserMessageInput
  commandError?: string
  /** The conversation this session resumes. Its past is read from the
   *  transcript once and kept here for as long as the session lives, so a
   *  view asks for it a page at a time, and asks again after a remount. */
  resume?: { id: string; cwd: string; configDir?: string; history?: HistoryItem[] }
  /** The model the session was launched on; the CLI's init frame refines it. */
  model: string | null
  /** The permission mode the session is in, as the CLI last reported it. */
  permissionMode: string
  emit: (event: SessionEvent) => void
  finish: (code: number) => void
}

/** One model as the CLI's initialize answer lists it. */
const cliModel = z.object({
  value: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  resolvedModel: z.string().optional(),
  supportsEffort: z.boolean().optional(),
  supportedEffortLevels: z.array(z.string()).optional()
})
const cliModels = z.array(cliModel)
type CliModel = z.infer<typeof cliModel>
const plainId = (id: string): string => id.replace(/\[[^\]]*\]$/, '')
/** The model the CLI's `default` alias stands for, as its list says it; a
 *  list without a default, or whose default names no resolution, answers the
 *  first listed model's resolution, else null (the CLI's init frame will say). */
export function resolvedDefaultModel(cli: CliModel[]): string | null {
  const fallback = cli.find((m) => isDefaultClaudeAlias(m.value))
  const model = fallback?.resolvedModel ?? cli[0]?.resolvedModel
  return model && isValidModelName(model) && !isDefaultClaudeAlias(model) ? model : null
}
/** The efforts a listed model takes, as the menu offers them. */
function cliEfforts(model: CliModel | undefined): Pick<ModelOption, 'efforts'> {
  const levels = model?.supportsEffort === false ? [] : (model?.supportedEffortLevels ?? [])
  const efforts = levels.filter(isValidEffort).map((id) => ({ id, label: effortLabel(id) }))
  return efforts.length ? { efforts } : {}
}
/** The efforts of a row from the first source the CLI lists: an entry that
 *  names this very model (its version row, else its alias, else the default
 *  entry when the row is the default's) is the word on it, levels or none;
 *  only a model the CLI lists under none of those takes its family's. The real
 *  CLI lists Haiku 4.5 with no levels and `supportsEffort` unset, and it takes
 *  none: yielding past a listed entry gave it its family's five (round 2). */
function effortsFrom(...sources: (CliModel | undefined)[]): Pick<ModelOption, 'efforts'> {
  return cliEfforts(sources.find((source) => source !== undefined))
}
/** The CLI's list made the menu (PRDCT-4257): every listed version under its
 *  own name, the family's gloss on its newest ("Best for everyday, complex
 *  tasks", without the version the name already says), "Earlier version" on an
 *  older one, then whatever the CLI offers that no version covers. Which
 *  version is the newest of a family is read off the whole list's ids
 *  (`earlierClaudeIds`), so a version the table does not know yet (the CLI's
 *  Haiku 5.5) is the newest over the table's Haiku 4.5. The CLI's `default` is
 *  not a row of its own: the model it resolves to carries the Default gloss on
 *  its row ("Default · Best for everyday, complex tasks"), and selecting that
 *  row selects that model, so the alias never goes on the wire (PRDCT-4256). */
export function claudeModelOptions(cli: CliModel[]): ModelOption[] {
  const fallback = cli.find((m) => isDefaultClaudeAlias(m.value))
  const resolvedDefault = fallback?.resolvedModel ? plainId(fallback.resolvedModel) : null
  // The default's gloss, without the model name the row already says.
  const defaultGloss = fallback?.description?.replace(/^[^·]*·\s*/, '')
  const defaultHint = defaultGloss ? `Default · ${defaultGloss}` : 'Default'
  // Every row with the model it stands for and the gloss it would carry as
  // the newest of its family; which rows are earlier is decided over them all.
  const rows: { option: ModelOption; model: string; gloss?: string; isDefault: boolean }[] = []
  for (const model of CLAUDE_MODELS) {
    const family = cli.find(
      (m) =>
        !isDefaultClaudeAlias(m.value) &&
        findClaudeModel(m.resolvedModel ?? m.value)?.alias === model.alias
    )
    const gloss = family?.description?.replace(/^[^·]*·\s*/, '')
    // The efforts are the version's own when the CLI lists it (Opus 4.6 takes
    // no xhigh), else its family's.
    const resolved = plainId(model.id)
    // The family's own row is its alias ("fable", "fable[1m]"), wherever the
    // CLI lists it; a dated version of the family is not.
    const alias = cli.find((m) => plainId(m.value) === model.alias)
    const version = cli.find(
      (m) => !isDefaultClaudeAlias(m.value) && plainId(m.resolvedModel ?? m.value) === resolved
    )
    const isDefault = resolvedDefault !== null && resolved === resolvedDefault
    rows.push({
      option: {
        id: model.id,
        label: model.name,
        resolved,
        ...effortsFrom(version, alias, isDefault ? fallback : undefined, family)
      },
      model: resolved,
      gloss,
      isDefault
    })
  }
  for (const model of cli) {
    if (isDefaultClaudeAlias(model.value) || findClaudeModel(model.resolvedModel ?? model.value))
      continue
    const resolved = plainId(model.resolvedModel ?? model.value)
    rows.push({
      option: {
        id: model.value,
        label: claudeModelName(model.resolvedModel ?? model.value) ?? model.displayName,
        ...(model.resolvedModel ? { resolved: model.resolvedModel } : {}),
        ...cliEfforts(model)
      },
      model: resolved,
      gloss: model.description,
      isDefault: resolvedDefault !== null && resolved === resolvedDefault
    })
  }
  const earlier = earlierClaudeIds(rows.map((row) => row.model))
  return rows.map(({ option, model, gloss, isDefault }) => {
    const hint = isDefault ? defaultHint : earlier.has(model) ? 'Earlier version' : gloss
    return hint ? { ...option, hint } : option
  })
}

export class ClaudeAdapter implements SessionAdapter {
  readonly id = 'claude-chat'
  readonly provider = 'claude'
  readonly transports = ['events'] as const
  readonly images = true
  private handles = new Map<string, Live>()
  private contexts = new Map<string, PtySpawnOptions>()
  private cwds = new Map<string, string>()
  /** Main-only launch/account context; never part of the Session record or wire. */
  configure(id: string, context: PtySpawnOptions): void {
    this.contexts.set(id, context)
  }
  /** The last message the reader sent this session, prepared as the provider
   *  got it; undefined before the first one or for a session not here. */
  lastUserMessage(id: string): UserMessageInput | undefined {
    return this.handles.get(id)?.lastUserMessage
  }
  async spawn(spec: SpawnSpec): Promise<SessionHandle> {
    if (process.platform === 'win32')
      throw new Error('Claude chat sessions are not supported on Windows')
    if (this.handles.has(spec.id)) throw new Error(`Claude session already exists: ${spec.id}`)
    const options = optionsSchema.parse(spec.options ?? {})
    const context = this.contexts.get(spec.id) ?? {}
    this.contexts.delete(spec.id)
    this.cwds.set(spec.id, spec.cwd)
    const sessionId = options.resume ?? context.claudeSessionId ?? randomUUID()
    if (!isValidClaudeSessionId(sessionId)) throw new Error('Invalid Claude session id')
    if (options.model && !isValidModelName(options.model)) throw new Error('Invalid model name')
    const profile =
      context.launchProfile ??
      launchProfileManager.resolve('claude', context.workspaceId, context.launchProfileId)
    // Clave's own launch mode wins (the CLI takes the last --permission-mode);
    // else the profile's, which the CLI obeys all the same.
    const profilePermissions = claudeProfilePermissions(profile)
    const launchMode = options.permissionMode ?? profilePermissions.mode
    // The account's token, read now (the store answers asynchronously) and
    // held in this closure until the process starts, never on the record.
    const oauthToken = await accountTokenForSpawn('claude', context.claudeProfileId)
    const emitter = new EventEmitter()
    const emit = (event: SessionEvent): void => {
      if (event.type === 'permission_mode') live.permissionMode = event.mode
      if (event.type === 'session_meta') {
        live.initialized = true
        // The model the session runs on, as the CLI last said it (its init
        // frame, a confirmed switch): what the default's resolution at ready
        // must not overwrite when it lands late (PRDCT-4256).
        if (event.model) live.model = event.model
        if (live.translator.commands) {
          lastCommandsByCwd.set(spec.cwd, live.translator.commands)
          lastCommandsAnywhere = live.translator.commands
        }
        if (event.providerSessionId && event.providerSessionId !== sessionId)
          emit({
            type: 'error',
            message: `Claude reported session ${event.providerSessionId}, but this session was launched as ${sessionId}; keeping the launch identity.`,
            fatal: false
          })
      }
      for (const listener of emitter.listeners('stream')) {
        try {
          listener({ kind: 'event', event })
        } catch (error) {
          console.error('Claude consumer failed', error)
        }
      }
    }
    const live: Live = {
      handle: { id: spec.id },
      emitter,
      translator: new ClaudeStreamTranslator(emit),
      ended: false,
      initialized: false,
      ready: false,
      initialPrompt: context.initialPrompt,
      initialInput: context.initialInput,
      model: options.model ?? null,
      permissionMode: runningMode(launchMode ?? 'default'),
      resume: options.resume
        ? { id: options.resume, cwd: spec.cwd, configDir: context.configDir }
        : undefined,
      commandError:
        context.initialCommand !== undefined || context.autoExecute === true
          ? 'initialCommand and autoExecute are not supported by Claude chat sessions; use a terminal session for shell commands.'
          : undefined,
      emit,
      finish: (code) => {
        if (live.ended) return
        live.ended = true
        live.translator.permissions.clear()
        for (const request of live.translator.listRequests.values())
          request.reject(new Error('Claude session has ended'))
        live.translator.listRequests.clear()
        live.translator.clearBackground()
        lazyTerminalPorts.mcpConfig.remove(spec.id)
        emit({ type: 'state_change', state: 'ended' })
        for (const listener of emitter.listeners('exit')) {
          try {
            listener(code)
          } catch (error) {
            console.error('Claude exit consumer failed', error)
          }
        }
      },
      // Started at ready (a consumer is bound) or by the first input, whichever
      // comes first; either way no init frame can precede a listener.
      start: () => {
        // The session's `--mcp-config` is the MCP config port's (the shell
        // wires its MCP server in; a server with none answers null and the
        // flag is omitted), the same port the terminal backend writes through.
        const mcpConfigPath = lazyTerminalPorts.mcpConfig.write(spec.id) ?? undefined
        const argv = buildAgentArgv({
          kind: 'claude',
          profile,
          sessionId,
          resumeSessionId: options.resume,
          model: options.model,
          claudeSettings: buildClaudeHookSettingsArg(spec.id) ?? undefined,
          mcpConfigPath: mcpConfigPath ?? undefined
        })
        argv.push(
          '-p',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          '--include-partial-messages',
          '--permission-prompts',
          'host',
          '--permission-prompt-tool',
          'stdio'
        )
        if (options.permissionMode) argv.push('--permission-mode', options.permissionMode)
        // A chat resumed in another mode keeps bypass reachable when its
        // launch had it: the CLI offers the switch without starting in it.
        if (options.allowDangerous && options.permissionMode !== 'bypassPermissions')
          argv.push('--allow-dangerously-skip-permissions')
        // A model that takes no effort (Haiku) runs at none whatever this says.
        if (options.effort) argv.push('--effort', options.effort)
        // ADR 0004: a routine run's contract skill and its one-line system
        // prompt, from the spawn's own context; a tab's launch carries none.
        if (context.pluginDir) argv.push('--plugin-dir', context.pluginDir)
        if (context.appendSystemPrompt)
          argv.push('--append-system-prompt', context.appendSystemPrompt)
        const env: Record<string, string> = {
          ...buildSpawnEnv(getLoginShellEnv(), {
            configDir: context.configDir,
            oauthToken
          }),
          CLAVE_SESSION_ID: spec.id
        }
        // The binary found on the login environment's own PATH starts directly;
        // the login-shell wrapper is only for a command that PATH cannot place.
        const executable = findExecutable(argv[0], env.PATH)
        const launch = executable
          ? { file: executable, args: argv.slice(1) }
          : resolvePosixShellLaunch(getUserShell(), `exec ${argv.map(shellSingleQuote).join(' ')}`)
        const child = spawn(launch.file, launch.args, {
          cwd: spec.cwd,
          env,
          stdio: 'pipe',
          detached: process.platform !== 'win32'
        })
        const lines = new NdjsonLines((line) => live.translator.line(line))
        const onStdout = (chunk: Buffer): void => lines.push(chunk)
        child.stdout.on('data', onStdout)
        child.stderr.on('data', (chunk: Buffer) =>
          emit({
            type: 'provider_event',
            provider: 'claude',
            payload: { type: 'stderr', text: chunk.toString('utf8') }
          })
        )
        child.stdin.on('error', (error) =>
          emit({ type: 'error', message: error.message, fatal: false })
        )
        child.on('error', (error) => {
          emit({ type: 'error', message: error.message, fatal: true })
          live.finish(1)
        })
        let finished = false
        const finishProcess = (code: number | null): void => {
          if (finished) return
          finished = true
          // A detached descendant may keep stdout open after our process exits.
          // Drain buffered bytes once, including the last unterminated frame,
          // then release only our local pipe ends rather than waiting for EOF.
          child.stdout.off('data', onStdout)
          let chunk: Buffer | null
          while ((chunk = child.stdout.read()) !== null) lines.push(chunk)
          lines.end()
          child.stdin.destroy()
          child.stdout.destroy()
          child.stderr.destroy()
          live.finish(code ?? 1)
        }
        child.on('exit', finishProcess)
        // Failed spawns may close without an exit event.
        child.on('close', finishProcess)
        return child
      }
    }
    if (
      launchMode === 'bypassPermissions' ||
      profilePermissions.bypassAvailable ||
      options.allowDangerous === true
    )
      live.translator.modes = [...PERMISSION_MODES, BYPASS_MODE]
    live.translator.requestSettings = () => {
      if (!live.process || live.ended) return
      const requestId = randomUUID()
      live.translator.settingsRequests.add(requestId)
      live.process.stdin.write(
        `${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'get_settings' } })}\n`
      )
    }
    live.translator.requestContext = () => {
      if (!live.process || live.ended) return
      const requestId = randomUUID()
      live.translator.contextRequests.add(requestId)
      live.process.stdin.write(
        `${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'get_context_usage' } })}\n`
      )
    }
    this.handles.set(spec.id, live)
    return live.handle
  }
  async attach(id: string): Promise<SessionHandle> {
    return this.live({ id }).handle
  }
  ready(handle: SessionHandle): void {
    const live = this.live(handle)
    if (live.ready || live.ended) return
    if (live.commandError) live.emit({ type: 'error', message: live.commandError, fatal: false })
    // The session has a model from the moment it is looked at: the one it was
    // launched on, or null until the CLI says which model its default is
    // (below). The `default` alias itself never goes out: a chip reading
    // "Default" names no model (PRDCT-4256). Sent past live.emit on purpose:
    // only the CLI's own init marks initialized.
    const launched = isDefaultClaudeAlias(live.model) ? null : live.model
    live.emitter.emit('stream', {
      kind: 'event',
      event: { type: 'session_meta', model: launched, providerSessionId: null }
    })
    // Its mode too, the launch's until the CLI reports one.
    live.translator.publishMode(live.permissionMode)
    // Read before the process starts, as the replay always was: the ids of
    // the past's tool calls must be known before the CLI's first frame.
    this.loadHistory(live)
    // The process starts here, the moment a consumer is bound, so its boot
    // (login shell, CLI, plugins, MCP servers: seconds) overlaps the reader's
    // typing instead of following their Enter. Nothing is lost by it: the
    // CLI's init frame only follows the first message. A start that throws
    // leaves readiness unconsumed, so the next subscribe retries it.
    live.process ??= live.start()
    // The effort it starts at, in the CLI's own word: the launch's, else the
    // user's settings, else the model's default.
    live.translator.requestSettings()
    // The window of the model it runs on, in the CLI's own word: a resumed
    // conversation's count comes from its replay, and nothing before a turn's
    // result named the window of a model Clave's table does not list
    // (PRDCT-4456).
    live.translator.requestContext()
    // A chat launched on no model, or on the `default` alias, runs on whatever
    // the CLI resolves that to: the settings answer above names it
    // (`applied.model`); a CLI whose answer names none is asked which model
    // its default is (initialize, no turn, no token). Either way the chip
    // names the model before the first message instead of after its init
    // frame, and the frame still refines it later.
    if (launched === null) this.resolveDefault(live)
    const initialInput = live.initialInput
    const initialPrompt = live.initialPrompt
    if (initialInput !== undefined) {
      const acceptance = this.write(handle, initialInput)
      if (acceptance)
        void acceptance.catch(() =>
          live.emit({
            type: 'error',
            message: 'The initial message delivery could not be confirmed.',
            fatal: false
          })
        )
    } else if (initialPrompt !== undefined)
      this.write(handle, { type: 'user_message', text: initialPrompt })
    live.initialInput = undefined
    live.initialPrompt = undefined
    live.ready = true
  }
  /** The resumed conversation's past; empty for a fresh one. */
  history(handle: SessionHandle): HistoryItem[] {
    return this.loadHistory(this.live(handle))
  }
  private loadHistory(live: Live): HistoryItem[] {
    const resume = live.resume
    if (!resume) return []
    if (resume.history) return resume.history
    resume.history = []
    const path = findTranscript(resume.id, resume.cwd, resume.configDir)
    try {
      if (path) resume.history = live.translator.replay(readFileSync(path, 'utf8').split('\n'))
    } catch (error) {
      live.emit({
        type: 'error',
        message: `Could not replay the conversation: ${String(error)}`,
        fatal: false
      })
    }
    return resume.history
  }
  write(handle: SessionHandle, raw: Uint8Array | SessionInput): void | Promise<void> {
    if (raw instanceof Uint8Array)
      throw new Error('Claude events adapter accepts SessionInput, not raw bytes')
    const input = SessionInputSchema.parse(raw)
    // The person's typing into a form is the host's (request-aware-host.ts),
    // never the CLI's; the chain below ends in an interrupt (PRDCT-4210).
    if (input.type === 'permission_draft') return
    const live = this.live(handle)
    if (live.ended) throw new Error('Claude session has ended')
    if (input.type === 'set_model' && input.model !== null && !isValidModelName(input.model))
      throw new Error('Invalid model name')
    // The menu selects the model the default resolves to, by its id; the
    // alias itself is never sent, since the CLI echoes it back as the model and
    // the chip then reads "Default" for good (PRDCT-4256).
    if (input.type === 'set_model' && isDefaultClaudeAlias(input.model))
      throw new Error('Pick a model by its id; the default alias names none')
    // A model can be chosen before the first message, as /model can in the
    // TUI: the switch starts the process, which accepts it before any turn.
    if (input.type === 'set_model' || input.type === 'set_effort') live.process ??= live.start()
    if (input.type !== 'user_message' && !live.process)
      throw new Error('Claude session has not started')
    const send = (payload: unknown): void => {
      live.process!.stdin.write(`${JSON.stringify(payload)}\n`)
    }
    if (input.type === 'user_message') {
      live.process ??= live.start()
      live.translator.interrupted = false
      live.lastUserMessage = input
      if (input.clientMessageId === undefined) live.emit(userMessageEvent(input))
      // The pane works from the moment a message is sent, the first one
      // included: before this the CLI's init frame, seconds after the first
      // Enter, was the first word that anything was happening. A queued
      // prompt must not hide a permission that still needs an answer.
      if (!live.translator.permissions.size)
        live.emitter.emit('stream', {
          kind: 'event',
          event: { type: 'state_change', state: 'working' }
        })
      // Attached images ride as image content blocks beside the text, the
      // shape the SDK's stream-json input takes; a message without any keeps
      // the plain string the fixtures were recorded with.
      const prompt = providerPrompt(input)
      const content = prompt.images.length
        ? [
            ...(prompt.text ? [{ type: 'text', text: prompt.text }] : []),
            ...prompt.images.map((image) => ({
              type: 'image',
              source: { type: 'base64', media_type: image.mimeType, data: image.data }
            }))
          ]
        : prompt.text
      const payload = { type: 'user', message: { role: 'user', content } }
      if (input.clientMessageId !== undefined)
        return new Promise<void>((resolve, reject) => {
          live.process!.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
            if (error) {
              reject(new UnconfirmedSessionWrite(handle.id, input.clientMessageId!))
              return
            }
            live.emit(userMessageEvent(input))
            resolve()
          })
        })
      send(payload)
    } else if (input.type === 'permission_response') {
      send(live.translator.response(input.id, input.optionId, flattenAnswers(input.answers)))
      if (!live.translator.permissions.size)
        live.emitter.emit('stream', {
          kind: 'event',
          event: { type: 'state_change', state: 'working' }
        })
    } else if (input.type === 'set_model') {
      const requestId = randomUUID()
      live.translator.modelRequests.set(requestId, input.model)
      send({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'set_model', model: input.model }
      })
    } else if (input.type === 'set_effort') {
      // Applied to the session only, as /effort does in the TUI: the user's
      // settings file is never written.
      const requestId = randomUUID()
      live.translator.effortRequests.set(requestId, input.effort)
      send({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'apply_flag_settings', settings: { effortLevel: input.effort } }
      })
    } else if (input.type === 'stop_task') {
      const requestId = randomUUID()
      live.translator.stopRequests.set(requestId, input.taskId)
      send({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'stop_task', task_id: input.taskId }
      })
    } else if (input.type === 'set_permission_mode') {
      const mode = runningMode(input.mode)
      if (!live.translator.modes.some((m) => m.id === mode))
        throw new Error(`Unknown permission mode: ${input.mode}`)
      const requestId = randomUUID()
      live.translator.modeRequests.set(requestId, mode)
      send({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'set_permission_mode', mode }
      })
    } else {
      live.translator.interrupted = true
      send({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })
    }
  }
  /** The commands the CLI offers this folder (skills included, with what each
   *  does), asked of the session's own process like the models, so a first
   *  message can be a command. The host's own come first. Should the CLI not
   *  answer, the last list an init frame named stands in. */
  async commands(handle: SessionHandle): Promise<CommandOption[]> {
    const live = this.live(handle)
    const cwd = this.cwds.get(handle.id) ?? ''
    const fallback = (): CommandOption[] =>
      toCommands(live.translator.commands ?? lastCommandsByCwd.get(cwd) ?? lastCommandsAnywhere)
    let listed: CommandOption[]
    try {
      const commands = z
        .array(z.object({ name: z.string(), description: z.string().optional() }))
        .parse((await this.initialize(live)).commands)
      listed = commands.map((command) => ({
        name: command.name,
        ...(command.description ? { description: command.description } : {}),
        insert: `/${command.name} `
      }))
    } catch {
      listed = fallback()
    }
    return [
      ...HOST_COMMANDS,
      ...listed.filter((c) => !HOST_COMMANDS.some((h) => h.name === c.name))
    ]
  }
  /** The models this session can be put on, asked of the session's own
   *  process (started if the session has not spoken yet). The CLI lists its
   *  aliases ("Opus", "Fable"); the menu lists versions (`CLAUDE_MODELS`), each
   *  with the gloss the CLI gives its family, and keeps anything the CLI
   *  offers that the list does not know yet, so a model shipped after this
   *  build still shows. */
  async models(handle: SessionHandle): Promise<ModelOption[]> {
    const models = cliModels.safeParse((await this.initialize(this.live(handle))).models)
    if (!models.success) throw new Error('Claude did not list its models')
    return claudeModelOptions(models.data)
  }
  /** The models the CLI offers with no session of it open (PRDCT-4300): the
   *  menu's other-provider list. A short-lived process on the machine login
   *  answers one initialize (no turn, no token) and is killed; the list is
   *  the same whatever account a session would run on. */
  async listModels(cwd: string): Promise<ModelOption[]> {
    const handle = await this.spawn({
      id: randomUUID(),
      provider: this.provider,
      adapterId: this.id,
      transport: 'events',
      cwd,
      windowKey: '',
      state: 'idle',
      createdAt: Date.now(),
      title: ''
    })
    try {
      return await this.models(handle)
    } finally {
      await this.kill(handle)
    }
  }
  /** Which model the CLI's default is, asked of the session's own process at
   *  ready and announced as the session's model (PRDCT-4256): the fallback
   *  for a CLI whose settings answer names no model, since the account's
   *  default is not the model a session with a user model setting runs on.
   *  Nothing is said when the CLI's own word came first (the settings answer,
   *  its init frame, a switch it took), when the session ended meanwhile, or
   *  when the CLI cannot say. */
  private resolveDefault(live: Live): void {
    const before = live.model
    void this.initialize(live)
      .then((answer) => {
        if (live.ended || live.initialized || live.model !== before) return
        const models = cliModels.safeParse(answer.models)
        const model = models.success ? resolvedDefaultModel(models.data) : null
        if (!model) return
        live.model = model
        live.emitter.emit('stream', {
          kind: 'event',
          event: { type: 'session_meta', model, providerSessionId: null }
        })
      })
      .catch(() => {
        // The CLI did not answer in time, or refused: the chip waits for the
        // init frame as it always did.
      })
  }
  /** The CLI's initialize answer (commands, models, account), asked of the
   *  session's own process, started if the session has not spoken yet. No turn
   *  is sent and no token spent; the CLI answers it any number of times. */
  private initialize(live: Live): Promise<Record<string, unknown>> {
    return this.request(live, { subtype: 'initialize' }, INITIALIZE_TIMEOUT_MS, 'initialize')
  }
  /** Send the session's provider one control request from the closed set a
   *  view may ask (the MCP servers, the plugins) and answer the CLI's own
   *  response. Started like initialize if the session has not spoken yet. */
  async control(handle: SessionHandle, request: SessionControl): Promise<Record<string, unknown>> {
    return this.request(this.live(handle), controlBody(request), CONTROL_TIMEOUT_MS, request.type)
  }
  /** One control request to the session's own process, its answer matched by
   *  request id; `what` names it in the errors. */
  private request(
    live: Live,
    body: Record<string, unknown>,
    timeoutMs: number,
    what: string
  ): Promise<Record<string, unknown>> {
    if (live.ended) return Promise.reject(new Error('Claude session has ended'))
    live.process ??= live.start()
    const requestId = randomUUID()
    const { translator } = live
    const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        translator.listRequests.delete(requestId)
        reject(new Error(`Claude did not answer ${what} in time`))
      }, timeoutMs)
      const settle =
        <T>(done: (value: T) => void) =>
        (value: T): void => {
          clearTimeout(timer)
          done(value)
        }
      translator.listRequests.set(requestId, {
        resolve: settle(resolve),
        reject: settle(reject),
        what
      })
    })
    live.process.stdin.write(
      `${JSON.stringify({ type: 'control_request', request_id: requestId, request: body })}\n`
    )
    return answer
  }
  async kill(handle: SessionHandle): Promise<void> {
    const live = this.handles.get(handle.id)
    if (!live) return
    const child = live.process
    if (child && child.exitCode == null && child.signalCode == null && !live.ended) {
      const signal = (sig: NodeJS.Signals): void => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig)
          else child.kill(sig)
        } catch {
          /* already exited */
        }
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => signal('SIGKILL'), 1000)
        // 'close' waits for inherited pipes, including detached descendants.
        // The owned process exiting is the shutdown boundary.
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
        signal('SIGTERM')
      })
    }
    child?.stdin.destroy()
    child?.stdout.destroy()
    child?.stderr.destroy()
    live.finish(child?.exitCode ?? 0)
    this.handles.delete(handle.id)
    live.emitter.removeAllListeners()
  }
  on<K extends keyof SessionAdapterEvents>(
    handle: SessionHandle,
    event: K,
    callback: (value: SessionAdapterEvents[K]) => void
  ): Unsubscribe {
    const emitter = this.live(handle).emitter
    emitter.on(event, callback)
    return () => {
      emitter.off(event, callback)
    }
  }
  private live(handle: SessionHandle): Live {
    const live = this.handles.get(handle.id)
    if (!live) throw new Error(`Unknown Claude session: ${handle.id}`)
    return live
  }
}
