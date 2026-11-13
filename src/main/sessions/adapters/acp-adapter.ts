import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  SessionInputSchema,
  userMessageEvent,
  type CommandOption,
  type HistoryItem,
  type ModelOption,
  type SessionEvent,
  type SessionInput
} from '../../../shared/session-model'
import { isFileAttachment } from '../../../shared/attachments'
import { findExecutable, resolvePosixShellLaunch, shellSingleQuote } from '../../shell-launch'
import type {
  SessionAdapter,
  SessionAdapterEvents,
  SessionHandle,
  SpawnSpec,
  Unsubscribe
} from '../adapter'
import {
  AcpConnection,
  JSON_RPC_METHOD_NOT_FOUND,
  object,
  type RpcId,
  type RpcNotification,
  type RpcRequest
} from './acp-client'

/**
 * A chat over the Agent Client Protocol (version 1): one agent process per
 * session (`opencode acp` in the app), driven as JSON-RPC 2.0 over its stdio
 * through `AcpConnection`. The agent's `session/update` notifications become
 * Clave's session events, its `session/request_permission` the permission
 * card, and a resumed session's `session/load` replay its history.
 */

export interface AcpAgentSpec {
  id: string
  provider: string
  label: string
}
export interface AcpLaunch {
  command: string[]
  env: NodeJS.ProcessEnv
  cwd?: string
  initialPrompt?: string
}
export interface AcpSpawnOptions {
  resume?: string
  model?: string
  autoApprove?: boolean
  initialPrompt?: string
}
export interface AcpSessionSummary {
  sessionId: string
  cwd?: string
  updatedAt?: string
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

interface ConfigChoice {
  value: string
  name: string
  description: string
}
interface ConfigOption {
  id: string
  category: string
  currentValue: string
  values: string[]
  /** The same values with the names the agent gives them. */
  choices: ConfigChoice[]
}
interface AuthMethod {
  id: string
  name: string
  description: string
}
interface PendingPermission {
  rpcId: RpcId
  options: { optionId: string; kind: string }[]
}
type Queued = {
  [K in keyof SessionAdapterEvents]: { event: K; value: SessionAdapterEvents[K] }
}[keyof SessionAdapterEvents]

interface HandleState {
  spec: SpawnSpec
  launch: AcpLaunch
  options: AcpSpawnOptions
  emitter: EventEmitter
  connection?: AcpConnection
  sessionId?: string
  agentCapabilities: Record<string, unknown>
  authMethods: AuthMethod[]
  configOptions: ConfigOption[]
  commands: CommandOption[]
  history: HistoryItem[]
  /** True while `session/load` replays the conversation into `history`. */
  loading: boolean
  /** Events emitted before `ready`, when no consumer is bound yet. */
  queue: Queued[] | null
  /** The handshake (initialize, then load or new). */
  started?: Promise<void>
  /** Serializes prompts: ACP runs one at a time per session. */
  turns: Promise<void>
  /** A `session/prompt` awaiting its answer. */
  turnRunning: boolean
  /** The agent's text of the current message, streamed but not closed. */
  textOpen: boolean
  /** Tool calls already shown, by `toolCallId`. */
  toolCalls: Set<string>
  permissions: Map<string, PendingPermission>
  initialPrompt?: string
  /** The exit code to report, when the adapter ended the session itself. */
  exitCode?: number
  ended: boolean
  closing: boolean
}

/** The text of a list of ACP ToolContent items: content blocks' text, and a
 *  diff as its path, then the old text and the new. */
function toolOutput(content: unknown): string {
  return array(content)
    .map((item) => {
      const entry = object(item)
      if (entry.type === 'content') return blockText(entry.content)
      if (entry.type === 'diff') {
        const old = typeof entry.oldText === 'string' ? entry.oldText : ''
        return [text(entry.path), old, text(entry.newText)].join('\n')
      }
      if (entry.type === 'terminal') return `terminal ${text(entry.terminalId)}`
      return ''
    })
    .filter((part) => part !== '')
    .join('\n')
}
function blockText(block: unknown): string {
  const b = object(block)
  if (b.type === 'text') return text(b.text)
  if (b.type === 'resource_link') return text(b.name) || text(b.uri)
  if (b.type === 'resource') return text(object(b.resource).text) || text(object(b.resource).uri)
  return ''
}
function parseConfigOptions(value: unknown): ConfigOption[] {
  return array(value).flatMap((raw) => {
    const option = object(raw)
    const id = text(option.id)
    if (!id) return []
    const choice = (entry: unknown): ConfigChoice => {
      const e = object(entry)
      return { value: text(e.value), name: text(e.name), description: text(e.description) }
    }
    // Options may be flat or grouped (`{ group, options: [...] }`).
    const choices = array(option.options).flatMap((entry) => {
      const e = object(entry)
      if (Array.isArray(e.options)) return e.options.map(choice)
      return [choice(e)]
    })
    return [
      {
        id,
        category: text(option.category),
        currentValue: text(option.currentValue),
        values: choices.map((c) => c.value),
        choices
      }
    ]
  })
}
/** The models an agent's model option offers, as the chat's menu lists
 *  them: its value as the id (OpenCode's `provider/model`, what the session
 *  reports and `session/set_config_option` takes) and its name without the
 *  `provider/` OpenCode puts in front ("kimi-code-plan-global/Kimi K3" reads
 *  "Kimi K3"). */
function modelChoices(option: ConfigOption | undefined): ModelOption[] {
  return (option?.choices ?? []).flatMap((c) => {
    if (!c.value) return []
    const slash = c.value.indexOf('/')
    const prefix = slash > 0 ? `${c.value.slice(0, slash)}/` : ''
    const name = prefix && c.name.startsWith(prefix) ? c.name.slice(prefix.length) : c.name
    return [
      { id: c.value, label: name || c.value, ...(c.description ? { hint: c.description } : {}) }
    ]
  })
}
function parseAuthMethods(value: unknown): AuthMethod[] {
  return array(value).map((raw) => {
    const method = object(raw)
    return {
      id: text(method.id),
      name: text(method.name),
      description: text(method.description)
    }
  })
}
const findModelOption = (options: ConfigOption[]): ConfigOption | undefined =>
  options.find((option) => option.id === 'model') ??
  options.find((option) => option.category === 'model')
const modelOption = (state: HandleState): ConfigOption | undefined =>
  findModelOption(state.configOptions)
/** The models a `configOptions` answer offers, as the chat's menu lists them. */
export const acpModelOptions = (configOptions: unknown): ModelOption[] =>
  modelChoices(findModelOption(parseConfigOptions(configOptions)))
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** The child under the launch's environment: directly when its command is on
 *  the environment's PATH, through the login shell otherwise (as the Claude
 *  and Codex adapters start theirs). */
function spawnAgent(launch: AcpLaunch, cwd: string): ChildProcessWithoutNullStreams {
  const [program, ...args] = launch.command
  if (!program) throw new Error('The agent launch names no command')
  const env = launch.env
  const executable = findExecutable(program, env.PATH)
  const file = executable
    ? { file: executable, args }
    : resolvePosixShellLaunch(
        env.SHELL || process.env.SHELL || '/bin/zsh',
        `exec ${launch.command.map(shellSingleQuote).join(' ')}`
      )
  return spawn(file.file, file.args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
}

export class AcpAdapter implements SessionAdapter {
  readonly id: string
  readonly provider: string
  readonly label: string
  readonly transports = ['events'] as const
  readonly images = false
  private handles = new Map<string, HandleState>()
  private launches = new Map<string, AcpLaunch>()

  constructor(spec: AcpAgentSpec) {
    this.id = spec.id
    this.provider = spec.provider
    this.label = spec.label
  }

  /** The spawn's command and environment, handed by the manager before the
   *  spawn; main-only, never part of the Session record or the wire. */
  configure(sessionId: string, launch: AcpLaunch): void {
    this.launches.set(sessionId, launch)
  }

  async spawn(spec: SpawnSpec): Promise<SessionHandle> {
    if (this.handles.has(spec.id))
      throw new Error(`${this.label} session already exists: ${spec.id}`)
    const launch = this.launches.get(spec.id)
    if (!launch) throw new Error(`${this.label} session was not configured: ${spec.id}`)
    this.launches.delete(spec.id)
    const options = object(spec.options)
    const state: HandleState = {
      spec,
      launch,
      options: {
        ...(text(options.resume) ? { resume: text(options.resume) } : {}),
        ...(text(options.model) ? { model: text(options.model) } : {}),
        ...(options.autoApprove === true ? { autoApprove: true } : {}),
        ...(text(options.initialPrompt) ? { initialPrompt: text(options.initialPrompt) } : {})
      },
      emitter: new EventEmitter(),
      agentCapabilities: {},
      authMethods: [],
      configOptions: [],
      commands: [],
      history: [],
      loading: false,
      queue: [],
      turns: Promise.resolve(),
      turnRunning: false,
      textOpen: false,
      toolCalls: new Set(),
      permissions: new Map(),
      ended: false,
      closing: false
    }
    state.initialPrompt = state.options.initialPrompt ?? launch.initialPrompt
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnAgent(launch, spec.cwd)
    } catch (error) {
      this.launches.set(spec.id, launch)
      throw error
    }
    this.handles.set(spec.id, state)
    state.connection = new AcpConnection(child, {
      notification: (frame) => this.notification(state, frame),
      request: (frame) => this.request(state, frame),
      error: (error) => this.notice(state, error.message),
      exit: (code) => this.exited(state, code)
    })
    state.started = this.handshake(state)
    await state.started
    return { id: spec.id }
  }

  async attach(id: string): Promise<SessionHandle> {
    this.require({ id })
    return { id }
  }

  /** The events held since the spawn reach the consumers bound now, then the
   *  launch's prompt goes as the first message, once. */
  ready(handle: SessionHandle): void {
    const state = this.require(handle)
    const queued = state.queue
    state.queue = null
    for (const item of queued ?? []) state.emitter.emit(item.event, item.value)
    if (state.ended || state.closing) return
    const prompt = state.initialPrompt
    if (prompt === undefined) return
    state.initialPrompt = undefined
    this.write(handle, { type: 'user_message', text: prompt })
  }

  write(handle: SessionHandle, input: Uint8Array | SessionInput): void {
    // An events adapter: terminal bytes have nowhere to go.
    if (input instanceof Uint8Array) return
    const value = SessionInputSchema.parse(input)
    const state = this.require(handle)
    if (state.ended || state.closing) throw new Error(`${this.label} session has ended`)
    switch (value.type) {
      case 'user_message': {
        this.emit(state, userMessageEvent(value))
        this.emit(state, { type: 'state_change', state: 'working' })
        const prompt: unknown[] = [{ type: 'text', text: value.text }]
        for (const file of value.attachments ?? [])
          if (isFileAttachment(file))
            prompt.push({ type: 'resource_link', uri: `file://${file.path}`, name: file.name })
        state.turns = state.turns.then(() => this.prompt(state, prompt))
        return
      }
      case 'permission_response':
        this.answerPermission(state, value.id, value.optionId)
        return
      case 'interrupt':
        this.cancel(state)
        return
      case 'set_model':
        if (value.model === null) {
          this.emitMeta(state)
          return
        }
        void this.setModel(state, value.model)
        return
      default:
        // set_effort, set_permission_mode, stop_task, permission_draft: the
        // protocol carries none of them.
        return
    }
  }

  history(handle: SessionHandle): HistoryItem[] {
    return this.require(handle).history
  }

  async commands(handle: SessionHandle): Promise<CommandOption[]> {
    return this.require(handle).commands
  }

  /** The models the agent's model option offers: under a stored connection,
   *  that connection's provider's alone (`enabled_providers`). */
  async models(handle: SessionHandle): Promise<ModelOption[]> {
    const state = this.require(handle)
    if (state.started) await state.started.catch(() => {})
    return modelChoices(modelOption(state))
  }

  async kill(handle: SessionHandle): Promise<void> {
    const state = this.handles.get(handle.id)
    if (!state) return
    if (state.turnRunning && state.sessionId && state.connection && !state.connection.closed)
      state.connection.notify('session/cancel', { sessionId: state.sessionId })
    state.closing = true
    if (state.connection) await state.connection.close()
    this.handles.delete(handle.id)
    state.emitter.removeAllListeners()
  }

  on<K extends keyof SessionAdapterEvents>(
    handle: SessionHandle,
    event: K,
    callback: (value: SessionAdapterEvents[K]) => void
  ): Unsubscribe {
    const emitter = this.require(handle).emitter
    const safe = (value: SessionAdapterEvents[K]): void => {
      try {
        callback(value)
      } catch (error) {
        console.error(`${this.label} consumer failed:`, error)
      }
    }
    emitter.on(event, safe)
    return () => {
      emitter.off(event, safe)
    }
  }

  /** The agent's past sessions for a folder, read by a throwaway process:
   *  initialize, session/list (every page), close. */
  async listSessions(cwd: string, launch: AcpLaunch): Promise<AcpSessionSummary[]> {
    const child = spawnAgent(launch, launch.cwd ?? cwd)
    const connection = new AcpConnection(child, {
      notification: () => {},
      request: (frame) =>
        connection.reject(frame.id, JSON_RPC_METHOD_NOT_FOUND, 'Method not found'),
      error: () => {},
      exit: () => {}
    })
    try {
      await connection.request('initialize', initializeParams)
      const sessions: AcpSessionSummary[] = []
      const seen = new Set<string>()
      let cursor: string | undefined
      // OpenCode 2.3.0 answers a `nextCursor` even on its only page, so the
      // walk also stops on a page that adds no session it had not listed.
      for (let page = 0; page < 50; page++) {
        const result = object(
          await connection.request('session/list', { cwd, ...(cursor ? { cursor } : {}) })
        )
        const before = seen.size
        for (const raw of array(result.sessions)) {
          const row = object(raw)
          const sessionId = text(row.sessionId) || text(row.id)
          if (!sessionId || seen.has(sessionId)) continue
          seen.add(sessionId)
          const updated = row.updatedAt
          sessions.push({
            sessionId,
            ...(text(row.cwd) ? { cwd: text(row.cwd) } : {}),
            ...(typeof updated === 'string' && updated
              ? { updatedAt: updated }
              : typeof updated === 'number' && Number.isFinite(updated)
                ? { updatedAt: new Date(updated).toISOString() }
                : {})
          })
        }
        const next = text(result.nextCursor) || undefined
        if (!next || next === cursor || seen.size === before) break
        cursor = next
      }
      return sessions
    } finally {
      await connection.close()
    }
  }

  private async handshake(state: HandleState): Promise<void> {
    const connection = state.connection!
    try {
      const init = object(await connection.request('initialize', initializeParams))
      state.agentCapabilities = object(init.agentCapabilities)
      state.authMethods = parseAuthMethods(init.authMethods)
      const resume = state.options.resume
      let opened: Record<string, unknown> | undefined
      if (resume && state.agentCapabilities.loadSession === true) {
        state.loading = true
        try {
          opened = object(
            await connection.request('session/load', {
              sessionId: resume,
              cwd: state.spec.cwd,
              mcpServers: []
            })
          )
          state.sessionId = resume
        } catch (error) {
          if (state.ended || state.closing) return
          state.history = []
          this.notice(
            state,
            `Could not resume the ${this.label} session (${errorMessage(error)}); a new one was started`
          )
        } finally {
          this.closeLoadedText(state)
          state.loading = false
          state.toolCalls.clear()
        }
      }
      if (!opened) {
        try {
          opened = object(
            await connection.request('session/new', { cwd: state.spec.cwd, mcpServers: [] })
          )
        } catch (error) {
          if (state.ended || state.closing) return
          this.refuse(state, error)
          return
        }
        state.sessionId = text(opened.sessionId)
        if (!state.sessionId) {
          this.refuse(state, new Error(`${this.label} returned no session id`))
          return
        }
      }
      state.configOptions = parseConfigOptions(opened.configOptions)
      this.emitMeta(state)
      const wanted = state.options.model
      if (wanted && wanted !== modelOption(state)?.currentValue) await this.setModel(state, wanted)
    } catch (error) {
      if (state.ended || state.closing) return
      this.refuse(state, error)
    }
  }

  /** The agent would not open a session (a sign-in it lacks, a protocol it
   *  does not speak): its word, the way to sign in when it names one, then
   *  the session ends with code 1. */
  private refuse(state: HandleState, error: unknown): void {
    const auth = state.authMethods.find((method) => method.description)
    this.notice(
      state,
      `${this.label} could not start a session: ${errorMessage(error)}${auth ? `. ${auth.description}` : ''}`
    )
    state.exitCode = 1
    if (state.connection && !state.connection.closed) void state.connection.close()
    else this.exited(state, 1)
  }

  private async setModel(state: HandleState, model: string): Promise<void> {
    const option = modelOption(state)
    if (!option || !option.values.includes(model)) {
      this.notice(
        state,
        `${this.label} does not offer the model ${model}; the session stays on ${option?.currentValue || 'its own'}`
      )
      return
    }
    if (!state.connection || !state.sessionId) return
    try {
      const result = object(
        await state.connection.request('session/set_config_option', {
          sessionId: state.sessionId,
          configId: option.id,
          value: model
        })
      )
      if (Array.isArray(result.configOptions))
        state.configOptions = parseConfigOptions(result.configOptions)
      else option.currentValue = model
      this.emitMeta(state)
    } catch (error) {
      if (!state.ended && !state.closing)
        this.notice(state, `${this.label} could not switch to ${model}: ${errorMessage(error)}`)
    }
  }

  private async prompt(state: HandleState, prompt: unknown[]): Promise<void> {
    if (state.started) await state.started.catch(() => {})
    if (state.ended || state.closing || !state.connection || !state.sessionId) return
    state.turnRunning = true
    let stopReason = ''
    try {
      const result = object(
        await state.connection.request(
          'session/prompt',
          { sessionId: state.sessionId, prompt },
          { timeout: null }
        )
      )
      stopReason = text(result.stopReason)
    } catch (error) {
      if (state.ended || state.closing) return
      this.notice(state, `${this.label} turn failed: ${errorMessage(error)}`)
    } finally {
      state.turnRunning = false
    }
    if (state.ended || state.closing) return
    this.endTurn(state, stopReason === 'cancelled')
  }

  /** The turn's end as the Codex chat says it: the open text closed, any
   *  card the agent left unanswered withdrawn, `turn_interrupted` for a
   *  cancelled turn, then `done`. */
  private endTurn(state: HandleState, cancelled: boolean): void {
    this.closeText(state)
    for (const id of state.permissions.keys())
      this.emit(state, { type: 'permission_withdrawn', id })
    state.permissions.clear()
    if (cancelled) this.emit(state, { type: 'turn_interrupted' })
    this.emit(state, { type: 'state_change', state: 'done' })
  }

  private cancel(state: HandleState): void {
    if (!state.turnRunning || !state.connection || !state.sessionId || state.connection.closed)
      return
    // The protocol asks the client to settle its open permission requests
    // as cancelled once it cancels the turn.
    for (const [id, pending] of state.permissions) {
      state.connection.respond(pending.rpcId, { outcome: { outcome: 'cancelled' } })
      this.emit(state, { type: 'permission_withdrawn', id })
    }
    state.permissions.clear()
    state.connection.notify('session/cancel', { sessionId: state.sessionId })
  }

  private answerPermission(state: HandleState, id: string, answer: string): void {
    const pending = state.permissions.get(id)
    if (!pending || !state.connection) return
    const byKind = (kind: string): string | undefined =>
      pending.options.find((option) => option.kind === kind)?.optionId
    const optionId = pending.options.some((option) => option.optionId === answer)
      ? answer
      : answer === 'allow' || answer === 'allow-once' || answer === 'allow_once'
        ? byKind('allow_once')
        : answer === 'allow-always' || answer === 'allow_always'
          ? (byKind('allow_always') ?? byKind('allow_once'))
          : answer === 'deny' || answer === 'reject' || answer === 'reject_once'
            ? byKind('reject_once')
            : undefined
    if (!optionId) return
    state.permissions.delete(id)
    state.connection.respond(pending.rpcId, { outcome: { outcome: 'selected', optionId } })
    if (!state.permissions.size && state.turnRunning)
      this.emit(state, { type: 'state_change', state: 'working' })
  }

  private request(state: HandleState, frame: RpcRequest): void {
    const connection = state.connection
    if (!connection || connection.closed) return
    if (frame.method !== 'session/request_permission' || state.ended) {
      connection.reject(frame.id, JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${frame.method}`)
      return
    }
    const p = object(frame.params)
    const toolCall = object(p.toolCall)
    const options = array(p.options).map((raw) => {
      const option = object(raw)
      return { optionId: text(option.optionId), name: text(option.name), kind: text(option.kind) }
    })
    if (state.options.autoApprove) {
      const chosen =
        options.find((option) => option.kind === 'allow_always') ??
        options.find((option) => option.kind === 'allow_once')
      connection.respond(
        frame.id,
        chosen
          ? { outcome: { outcome: 'selected', optionId: chosen.optionId } }
          : { outcome: { outcome: 'cancelled' } }
      )
      return
    }
    const id = JSON.stringify(frame.id)
    state.permissions.set(id, { rpcId: frame.id, options })
    this.closeText(state)
    const title = text(toolCall.title)
    const kind = text(toolCall.kind)
    this.emit(state, {
      type: 'permission_request',
      id,
      description: title || kind || 'Permission requested',
      options: options.map((option) => ({
        id: option.optionId,
        label: option.name || option.optionId
      })),
      ...(kind ? { toolName: kind } : {}),
      ...(toolCall.rawInput !== undefined ? { input: toolCall.rawInput } : {})
    })
    this.emit(state, { type: 'state_change', state: 'blocked' })
  }

  private notification(state: HandleState, frame: RpcNotification): void {
    if (frame.method !== 'session/update' || state.ended) return
    const p = object(frame.params)
    // Another session's update is not this chat's (a replay comes before
    // `sessionId` is set, so the load is exempt).
    if (!state.loading && state.sessionId && text(p.sessionId) !== state.sessionId) return
    const update = object(p.update)
    const kind = text(update.sessionUpdate)
    if (state.loading) {
      this.replay(state, kind, update)
      return
    }
    switch (kind) {
      case 'agent_message_chunk': {
        const delta = blockText(update.content)
        if (!delta) return
        state.textOpen = true
        this.emit(state, { type: 'assistant_text', delta, final: false })
        return
      }
      case 'tool_call': {
        const id = text(update.toolCallId)
        if (!id) return
        if (!state.toolCalls.has(id)) {
          state.toolCalls.add(id)
          this.closeText(state)
          this.emit(state, {
            type: 'tool_call',
            id,
            name: text(update.title) || text(update.kind) || 'tool',
            input: update.rawInput ?? {}
          })
        }
        this.toolEnd(state, id, update)
        return
      }
      case 'tool_call_update':
        this.toolEnd(state, text(update.toolCallId), update)
        return
      case 'available_commands_update':
        this.storeCommands(state, update)
        return
      case 'config_option_update':
        if (Array.isArray(update.configOptions)) {
          const before = modelOption(state)?.currentValue
          state.configOptions = parseConfigOptions(update.configOptions)
          if (modelOption(state)?.currentValue !== before) this.emitMeta(state)
        }
        return
      case 'usage_update': {
        const used = update.used
        const size = update.size
        if (typeof used !== 'number' || !Number.isFinite(used)) return
        this.emit(state, {
          type: 'context_usage',
          used,
          window: typeof size === 'number' && size > 0 ? size : null
        })
        return
      }
      default:
        // user_message_chunk (we emitted the message ourselves),
        // agent_thought_chunk (the model has no thinking event), plan, modes
        // and anything newer: nothing to show.
        return
    }
  }

  private storeCommands(state: HandleState, update: Record<string, unknown>): void {
    state.commands = array(update.availableCommands).flatMap((raw) => {
      const command = object(raw)
      const name = text(command.name)
      if (!name) return []
      const description = text(command.description)
      return [{ name, ...(description ? { description } : {}), insert: `/${name} ` }]
    })
  }

  /** A completed or failed call becomes its result. */
  private toolEnd(state: HandleState, id: string, update: Record<string, unknown>): void {
    const status = text(update.status)
    if (!id || (status !== 'completed' && status !== 'failed')) return
    if (!state.toolCalls.has(id)) {
      state.toolCalls.add(id)
      this.emit(state, {
        type: 'tool_call',
        id,
        name: text(update.title) || text(update.kind) || 'tool',
        input: update.rawInput ?? {}
      })
    }
    this.emit(state, {
      type: 'tool_result',
      id,
      output: toolOutput(update.content),
      ...(status === 'failed' ? { error: true } : {})
    })
  }

  /** One replayed update into the history, shaped as `toHistoryItems` shapes
   *  a bridge replay: the person's messages, the agent's text closed per
   *  message, the tool calls and their results. */
  private replay(state: HandleState, kind: string, update: Record<string, unknown>): void {
    const history = state.history
    const last = history[history.length - 1]?.event
    if (kind === 'user_message_chunk') {
      const chunk = blockText(update.content)
      this.closeLoadedText(state)
      if (last?.type === 'user_message')
        history[history.length - 1].event = { ...last, text: last.text + chunk }
      else history.push({ event: { type: 'user_message', text: chunk } })
      return
    }
    if (kind === 'agent_message_chunk') {
      const chunk = blockText(update.content)
      if (state.textOpen && last?.type === 'assistant_text')
        history[history.length - 1].event = { ...last, delta: last.delta + chunk }
      else history.push({ event: { type: 'assistant_text', delta: chunk, final: false } })
      state.textOpen = true
      return
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const id = text(update.toolCallId)
      if (!id) return
      if (!state.toolCalls.has(id)) {
        if (kind === 'tool_call_update' && !['completed', 'failed'].includes(text(update.status)))
          return
        this.closeLoadedText(state)
        state.toolCalls.add(id)
        history.push({
          event: {
            type: 'tool_call',
            id,
            name: text(update.title) || text(update.kind) || 'tool',
            input: update.rawInput ?? {}
          }
        })
      }
      const status = text(update.status)
      if (status === 'completed' || status === 'failed')
        history.push({
          event: {
            type: 'tool_result',
            id,
            output: toolOutput(update.content),
            ...(status === 'failed' ? { error: true } : {})
          }
        })
      return
    }
    if (kind === 'available_commands_update') this.storeCommands(state, update)
  }

  /** The replayed message in progress is whole. */
  private closeLoadedText(state: HandleState): void {
    if (!state.textOpen) return
    state.textOpen = false
    const last = state.history[state.history.length - 1]
    if (last?.event.type === 'assistant_text') last.event = { ...last.event, final: true }
  }

  /** The live message in progress is whole: an empty final delta, as the
   *  Codex chat closes its own. */
  private closeText(state: HandleState): void {
    if (!state.textOpen) return
    state.textOpen = false
    this.emit(state, { type: 'assistant_text', delta: '', final: true })
  }

  private emitMeta(state: HandleState): void {
    this.emit(state, {
      type: 'session_meta',
      model: modelOption(state)?.currentValue || null,
      providerSessionId: state.sessionId ?? null
    })
  }

  /** The adapter's word to the reader: the model's non-fatal error, as the
   *  Codex chat reports a resume it could not replay. */
  private notice(state: HandleState, message: string): void {
    if (state.ended) return
    this.emit(state, { type: 'error', message, fatal: false })
  }

  private exited(state: HandleState, code: number): void {
    if (state.ended) return
    if (state.turnRunning && !state.closing)
      this.notice(state, `${this.label} stopped during the turn (exit code ${code})`)
    state.ended = true
    state.turnRunning = false
    state.permissions.clear()
    this.emit(state, { type: 'state_change', state: 'ended' })
    this.raw(state, { event: 'exit', value: state.exitCode ?? code })
  }

  private emit(state: HandleState, event: SessionEvent): void {
    this.raw(state, { event: 'stream', value: { kind: 'event', event } })
  }
  private raw(state: HandleState, item: Queued): void {
    if (state.queue) state.queue.push(item)
    else state.emitter.emit(item.event, item.value)
  }

  private require(handle: SessionHandle): HandleState {
    const state = this.handles.get(handle.id)
    if (!state) throw new Error(`Unknown ${this.label} session: ${handle.id}`)
    return state
  }
}

const initializeParams = {
  protocolVersion: 1,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
}
