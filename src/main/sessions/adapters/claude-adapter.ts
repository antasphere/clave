import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import {
  SessionInputSchema,
  userMessageEvent,
  providerPrompt,
  AgentQuestionSchema,
  type SessionInput,
  type SessionEvent,
  type BackgroundTask,
  type HistoryItem,
  type ModelOption,
  type CommandOption
} from '../../../shared/session-model'
import { buildAgentArgv } from '../../../shared/agent-launch'
import { isValidModelName } from '../../../shared/model-name'
import type {
  SessionAdapter,
  SessionAdapterEvents,
  SessionHandle,
  SpawnSpec,
  Unsubscribe
} from '../adapter'
import { findExecutable, resolvePosixShellLaunch } from '../../shell-launch'
import { launchProfileManager } from '../../launch-profile-manager'
import { getMcpRuntime, writeSessionMcpConfig, deleteSessionMcpConfig } from '../../mcp/mcp-runtime'
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

const object = z.record(z.string(), z.unknown())
const envelope = object.and(z.object({ type: z.string() }))
const optionsSchema = z.object({
  resume: z.string().optional(),
  model: z.string().optional(),
  permissionMode: z
    .enum(['manual', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'])
    .optional()
})
type Permission = { input: unknown; suggestions: unknown[] }

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
}
/** How long a menu waits on the CLI's initialize answer before calling it unavailable. */
const INITIALIZE_TIMEOUT_MS = 20_000
/** The host's own commands, offered before the CLI's: the chat view acts on
 *  them itself rather than sending them to the agent. */
export const HOST_COMMANDS: CommandOption[] = [
  { name: 'resume', description: 'Resume a past conversation from this folder', insert: '/resume' }
]
/** What a transcript's human line says, the way the reader typed it: a slash
 *  command as "/name args", the CLI's own wrappers (command output, caveats,
 *  reminders) as nothing. */
/** The CLI's own acknowledgement of an interrupt, written into the
 *  conversation as a user text block: "[Request interrupted by user]", or
 *  "[Request interrupted by user for tool use]" when a tool was running. */
function isInterruptNotice(text: unknown): boolean {
  return typeof text === 'string' && /^\[Request interrupted by user/.test(text.trim())
}
function spokenText(text: string): string {
  const command = /<command-name>([^<]*)<\/command-name>/.exec(text)
  if (command) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(text)?.[1] ?? ''
    return `${command[1].trim()} ${args.trim()}`.trim()
  }
  if (text.trimStart().startsWith('<') || text.startsWith('Caveat:')) return ''
  return text
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
  /** request_id → the caller waiting on an initialize control request's answer. */
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
  constructor(private readonly emit: (event: SessionEvent) => void) {}
  /** Publish the background list whole; a snapshot replaces the last. */
  private publishBackground(): void {
    this.emit({ type: 'background_tasks', tasks: [...this.background.values()] })
  }
  /** Nothing outlives the CLI: its exit empties the list, once. */
  clearBackground(): void {
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
      const tool = toolUseId ?? known?.toolUseId
      const outputFile = known?.outputFile ?? (tool ? this.outputFiles.get(tool) : undefined)
      this.background.set(id, {
        id,
        kind: known?.kind ?? kindOf(type),
        description:
          typeof description === 'string' && description ? description : (known?.description ?? id),
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
      for (const t of tasks) track(t.task_id, t.task_type, t.description)
    } else if (p.subtype === 'task_started') {
      // A foreground task (a subagent the turn waits on) is the turn's own
      // work, already on screen as its tool call.
      if (p.is_backgrounded === false || typeof p.task_id !== 'string') return true
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
      if (!this.background.delete(p.task_id)) return true
    } else if (p.subtype === 'task_notification') {
      if (typeof p.task_id !== 'string' || !this.background.delete(p.task_id)) return true
    } else return false
    this.publishBackground()
    return true
  }
  /** A control_response answering one of our initialize requests; false for any other. */
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
    else request.reject(new Error(response.data.error ?? 'Claude did not answer initialize'))
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
    if (response.data.subtype === 'success')
      this.emit({ type: 'session_meta', model, providerSessionId: null })
    else
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
   *  at a time (`sessions:history`), the newest first. Subagent lines, meta
   *  lines and the CLI's own wrappers stay out; a call the transcript never
   *  answered is closed, not left spinning. */
  replay(lines: Iterable<string>): HistoryItem[] {
    const items: HistoryItem[] = []
    const open = new Set<string>()
    const close = (): void => {
      for (const id of open) items.push({ event: { type: 'tool_result', id, output: undefined } })
      open.clear()
    }
    const block = z.object({ type: z.string() }).passthrough()
    for (const line of lines) {
      let frame: Record<string, unknown>
      try {
        frame = object.parse(JSON.parse(line))
      } catch {
        continue
      }
      if (frame.isSidechain === true || frame.isMeta === true) continue
      const content = object.safeParse(frame.message).data?.content
      const time = typeof frame.timestamp === 'string' ? Date.parse(frame.timestamp) : NaN
      const push = (event: SessionEvent): void => {
        // The reader spoke again: whatever the turn before left unanswered is
        // over. Closed here rather than at the end of the transcript, so a
        // call that never got its result does not tie every later turn to it
        // and a page can still begin at each of them.
        if (event.type === 'user_message') close()
        items.push(Number.isFinite(time) ? { event, at: time } : { event })
      }
      if (frame.type === 'user') {
        if (typeof content === 'string') {
          if (isInterruptNotice(content)) push({ type: 'turn_interrupted' })
          else if (spokenText(content)) push({ type: 'user_message', text: spokenText(content) })
          continue
        }
        for (const item of z.array(block).catch([]).parse(content)) {
          if (item.type === 'text' && isInterruptNotice(item.text)) {
            push({ type: 'turn_interrupted' })
          } else if (item.type === 'tool_result' && typeof item.tool_use_id === 'string') {
            open.delete(item.tool_use_id)
            push({
              type: 'tool_result',
              id: item.tool_use_id,
              output: item.content,
              ...(item.is_error === true ? { error: true } : {})
            })
          } else if (item.type === 'text' && typeof item.text === 'string') {
            const text = spokenText(item.text)
            if (text) push({ type: 'user_message', text })
          }
        }
      } else if (frame.type === 'assistant') {
        for (const item of z.array(block).catch([]).parse(content)) {
          if (item.type === 'text' && typeof item.text === 'string' && item.text.trim())
            push({ type: 'assistant_text', delta: item.text, final: true })
          else if (
            item.type === 'tool_use' &&
            typeof item.id === 'string' &&
            !this.tools.has(item.id)
          ) {
            this.tools.add(item.id)
            open.add(item.id)
            push({
              type: 'tool_call',
              id: item.id,
              name: typeof item.name === 'string' ? item.name : 'Tool',
              input: item.input
            })
          }
        }
      }
    }
    close()
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
      this.emit({ type: 'state_change', state: 'working' })
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
      for (const block of message.content) {
        if (block.type === 'text' && p.type === 'user' && isInterruptNotice(block.text)) {
          this.interrupted = true
        } else if (block.type === 'text' && p.type === 'assistant' && !this.streamed) {
          this.emit({ type: 'assistant_text', delta: z.string().parse(block.text), final: false })
        } else if (block.type === 'tool_use') {
          const tool = z
            .object({ id: z.string(), name: z.string(), input: z.unknown() })
            .parse(block)
          if (!this.tools.has(tool.id)) {
            this.tools.add(tool.id)
            this.emit({ type: 'tool_call', ...tool })
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
            error: z.boolean().optional().catch(undefined).parse(block.is_error)
          })
        }
      }
      // Preserve usage, thinking, attachments, and unknown content without duplicate text.
      fallback()
    } else if (p.type === 'control_response' && (this.modelRequest(p) || this.listRequest(p))) {
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
      this.permissions.delete(z.string().parse(p.request_id))
      this.questionRequests.delete(z.string().parse(p.request_id))
      fallback()
      if (!this.permissions.size) this.emit({ type: 'state_change', state: 'working' })
    } else if (p.type === 'result') {
      this.finish()
      this.permissions.clear()
      this.questionRequests.clear()
      this.tools.clear()
      if (p.is_error && this.interrupted) this.emit({ type: 'turn_interrupted' })
      else if (p.is_error)
        this.emit({
          type: 'error',
          message: typeof p.result === 'string' ? p.result : 'Claude turn failed',
          fatal: false
        })
      this.interrupted = false
      fallback()
      this.emit({ type: 'state_change', state: 'done' })
      this.streamed = false
      this.finished = false
    } else fallback()
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
    if (!pending) throw new Error(`Unknown Claude permission request: ${id}`)
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
  commandError?: string
  /** The conversation this session resumes. Its past is read from the
   *  transcript once and kept here for as long as the session lives, so a
   *  view asks for it a page at a time, and asks again after a remount. */
  resume?: { id: string; cwd: string; configDir?: string; history?: HistoryItem[] }
  /** The model the session was launched on; the CLI's init frame refines it. */
  model: string | null
  emit: (event: SessionEvent) => void
  finish: (code: number) => void
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
    const profile = launchProfileManager.resolve(
      'claude',
      context.workspaceId,
      context.launchProfileId
    )
    const emitter = new EventEmitter()
    const emit = (event: SessionEvent): void => {
      if (event.type === 'session_meta') {
        live.initialized = true
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
      model: options.model ?? null,
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
        deleteSessionMcpConfig(spec.id)
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
        const mcpConfigPath = getMcpRuntime() ? writeSessionMcpConfig(spec.id) : undefined
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
        const env: Record<string, string> = {
          ...buildSpawnEnv(getLoginShellEnv(), {
            configDir: context.configDir,
            oauthToken: accountTokenForSpawn('claude', context.claudeProfileId)
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
    // launched on, or the CLI's default until its init frame names it. Sent
    // past live.emit on purpose: only the CLI's own init marks initialized.
    live.emitter.emit('stream', {
      kind: 'event',
      event: { type: 'session_meta', model: live.model, providerSessionId: null }
    })
    // Read before the process starts, as the replay always was: the ids of
    // the past's tool calls must be known before the CLI's first frame.
    this.loadHistory(live)
    // The process starts here, the moment a consumer is bound, so its boot
    // (login shell, CLI, plugins, MCP servers: seconds) overlaps the reader's
    // typing instead of following their Enter. Nothing is lost by it: the
    // CLI's init frame only follows the first message. A start that throws
    // leaves readiness unconsumed, so the next subscribe retries it.
    live.process ??= live.start()
    const initialPrompt = live.initialPrompt
    if (initialPrompt !== undefined)
      this.write(handle, { type: 'user_message', text: initialPrompt })
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
  write(handle: SessionHandle, raw: Uint8Array | SessionInput): void {
    if (raw instanceof Uint8Array)
      throw new Error('Claude events adapter accepts SessionInput, not raw bytes')
    const input = SessionInputSchema.parse(raw)
    const live = this.live(handle)
    if (live.ended) throw new Error('Claude session has ended')
    if (input.type === 'set_model' && input.model !== null && !isValidModelName(input.model))
      throw new Error('Invalid model name')
    // A model can be chosen before the first message, as /model can in the
    // TUI: the switch starts the process, which accepts it before any turn.
    if (input.type === 'set_model') live.process ??= live.start()
    if (input.type !== 'user_message' && !live.process)
      throw new Error('Claude session has not started')
    const send = (payload: unknown): void => {
      live.process!.stdin.write(`${JSON.stringify(payload)}\n`)
    }
    if (input.type === 'user_message') {
      live.process ??= live.start()
      live.translator.interrupted = false
      live.emit(userMessageEvent(input))
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
      send({ type: 'user', message: { role: 'user', content } })
    } else if (input.type === 'permission_response') {
      send(live.translator.response(input.id, input.optionId, input.answers))
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
  /** The models the CLI itself offers this account, asked of the session's own
   *  process (started if the session has not spoken yet): no list is kept here,
   *  so a new or retired model shows the moment the CLI knows of it. */
  async models(handle: SessionHandle): Promise<ModelOption[]> {
    const models = z
      .array(
        z.object({
          value: z.string(),
          displayName: z.string(),
          description: z.string().optional(),
          resolvedModel: z.string().optional()
        })
      )
      .safeParse((await this.initialize(this.live(handle))).models)
    if (!models.success) throw new Error('Claude did not list its models')
    return models.data.map((model) => ({
      id: model.value,
      label: model.displayName,
      ...(model.description ? { hint: model.description } : {}),
      ...(model.resolvedModel ? { resolved: model.resolvedModel } : {})
    }))
  }
  /** The CLI's initialize answer (commands, models, account), asked of the
   *  session's own process, started if the session has not spoken yet. No turn
   *  is sent and no token spent; the CLI answers it any number of times. */
  private initialize(live: Live): Promise<Record<string, unknown>> {
    if (live.ended) return Promise.reject(new Error('Claude session has ended'))
    live.process ??= live.start()
    const requestId = randomUUID()
    const { translator } = live
    const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        translator.listRequests.delete(requestId)
        reject(new Error('Claude did not answer initialize in time'))
      }, INITIALIZE_TIMEOUT_MS)
      const settle =
        <T>(done: (value: T) => void) =>
        (value: T): void => {
          clearTimeout(timer)
          done(value)
        }
      translator.listRequests.set(requestId, { resolve: settle(resolve), reject: settle(reject) })
    })
    live.process.stdin.write(
      `${JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'initialize' } })}\n`
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
