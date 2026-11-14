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
import { PiRpcConnection, record, type PiRpcEvent } from './pi-rpc-client'
import { startRefusal } from './start-refusal'
import { connectionHandover } from '../../connection-handover'

/**
 * A chat with Pi over its rpc mode (`pi --mode rpc`, Pi 1.5): one Pi process
 * per session, driven through `PiRpcConnection`. The handshake reads the
 * state, settles the model, replays a resumed conversation from
 * `get_messages` and lists the commands; a message is a `prompt` (a `steer`
 * while a run is going), and Pi's event stream becomes Clave's session
 * events, the run's end being `agent_settled`. The command line is the
 * manager's (`pi --mode rpc --session-id <id>` or `--session <id>`, with the
 * profile's flags): this adapter runs what it is given.
 */

export interface PiRpcAgentSpec {
  id: string
  provider: string
  label: string
}
export interface PiRpcLaunch {
  command: string[]
  env: NodeJS.ProcessEnv
  cwd?: string
  initialPrompt?: string
  /** The stored connection the chat runs on (PRDCT-4496): its Pi provider,
   *  the only one the chat offers and lets Pi run on, and the names of its
   *  own variables in `env`, carried past a login profile when Pi is started
   *  through the shell (`connectionHandover`). */
  connection?: { provider: string; variables: readonly string[] }
}
export interface PiRpcSpawnOptions {
  resume?: string
  model?: string
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** The `text` blocks of a content list joined by newlines; a string content
 *  as it is. */
function blocksText(content: unknown): string {
  if (typeof content === 'string') return content
  return array(content)
    .flatMap((block) => {
      const b = record(block)
      return b.type === 'text' && typeof b.text === 'string' ? [b.text] : []
    })
    .join('\n')
}
/** A Pi Model object as `provider/id`; null when there is none. */
function modelName(model: unknown): string | null {
  const m = record(model)
  const id = text(m.id)
  if (!id) return null
  const provider = text(m.provider)
  return provider ? `${provider}/${id}` : id
}

/** What Pi does with a model name it does not have (PRDCT-4427), in one
 *  sentence: it sends the name to the provider as it is. */
export function piUnknownModel(label: string, model: string, provider: string | undefined): string {
  return `${label} does not know the model ${model}${provider ? ` of ${provider}` : ''}: it sends that name to the provider as it is, and the provider may refuse it.`
}

/** Pi's `get_available_models` answer as the chat's menu lists it: each
 *  model as `provider/id` (what the session reports and `set_model` splits)
 *  and by its name. Pi lists every provider it finds a credential for, the
 *  connection's or not (checked on 1.5.2): a chat on a stored connection
 *  passes its provider, and only that provider's models are listed
 *  (PRDCT-4496). */
export function piModelOptions(data: unknown, provider?: string): ModelOption[] {
  const seen = new Set<string>()
  return array(record(data).models).flatMap((raw) => {
    const id = modelName(raw)
    if (!id || seen.has(id)) return []
    if (provider !== undefined && text(record(raw).provider) !== provider) return []
    seen.add(id)
    return [{ id, label: text(record(raw).name) || text(record(raw).id) }]
  })
}

/** A pick of another provider's model in a chat on a connection, refused in
 *  one sentence (PRDCT-4496). */
export function piForeignModelRefused(
  label: string,
  wanted: string,
  provider: string,
  current: string | null
): string {
  return `${label} stays on ${current ?? 'no model'}: this chat runs on its connection, whose provider is ${provider}, and ${wanted} is not one of its models.`
}

/** Pi reported a model of another provider than the connection's, and the
 *  chat put it back on one of the connection's (PRDCT-4496). */
export function piBackOnConnection(
  label: string,
  foreign: string,
  provider: string,
  model: string
): string {
  return `${label} was on ${foreign}, which is not a model of its connection's provider ${provider}: the chat put it back on ${model}.`
}

/** Pi reported a model of another provider than the connection's and could
 *  not be put back: the turn ends unsent (PRDCT-4496). */
export function piOffConnection(label: string, foreign: string, provider: string): string {
  return `${label} is on ${foreign}, which is not a model of its connection's provider ${provider}, and could not be put back on one: nothing was sent.`
}

/** A resumed conversation's messages as the history a view pages through. */
export function piHistory(messages: unknown): HistoryItem[] {
  const items: HistoryItem[] = []
  for (const raw of array(messages)) {
    const message = record(raw)
    const at = typeof message.timestamp === 'number' ? { at: message.timestamp } : {}
    switch (message.role) {
      case 'user':
        items.push({ event: { type: 'user_message', text: blocksText(message.content) }, ...at })
        break
      case 'assistant': {
        const said = blocksText(message.content)
        if (said) items.push({ event: { type: 'assistant_text', delta: said, final: true }, ...at })
        for (const block of array(message.content)) {
          const b = record(block)
          if (b.type !== 'toolCall' || !text(b.id)) continue
          items.push({
            event: { type: 'tool_call', id: text(b.id), name: text(b.name), input: b.arguments },
            ...at
          })
        }
        break
      }
      case 'toolResult':
        items.push({
          event: {
            type: 'tool_result',
            id: text(message.toolCallId),
            output: blocksText(message.content),
            error: message.isError === true
          },
          ...at
        })
        break
      default:
        // system, bashExecution, custom, branchSummary, compactionSummary and
        // any newer role: nothing a chat replays.
        break
    }
  }
  return items
}

const DIALOGS = new Set(['select', 'confirm', 'input', 'editor'])
const ABORT_TIMEOUT_MS = 60_000
const KILL_ABORT_TIMEOUT_MS = 5_000
/** How long a steer answered with no run going waits for one to start. */
const STEER_SETTLE_MS = 200

type Queued = {
  [K in keyof SessionAdapterEvents]: { event: K; value: SessionAdapterEvents[K] }
}[keyof SessionAdapterEvents]

interface HandleState {
  spec: SpawnSpec
  launch: PiRpcLaunch
  options: PiRpcSpawnOptions
  emitter: EventEmitter
  connection?: PiRpcConnection
  sessionId?: string
  sessionFile?: string
  /** The model as `provider/id`; null when Pi has none. */
  model: string | null
  /** The bare id and the provider of that model. */
  modelId?: string
  modelProvider?: string
  /** The last model Pi reported on the connection's provider, by its bare
   *  id: where the chat puts Pi back (PRDCT-4496). */
  connectionModelId?: string
  commands: CommandOption[]
  history: HistoryItem[]
  /** Events emitted before `ready`, when no consumer is bound yet. */
  queue: Queued[] | null
  /** The handshake, from `get_state` to `session_meta`. */
  started?: Promise<void>
  /** True until the handshake has finished: a death then is a refusal. */
  starting: boolean
  /** Sends one at a time, in the order the reader wrote them. */
  sends: Promise<void>
  /** A run Pi has started, or a prompt sent for one, not yet settled: the
   *  state shown, and what `kill` and `interrupt` go by. */
  turnRunning: boolean
  /** A run Pi itself has started (`agent_start`) and not yet settled; only
   *  Pi's events set it. What decides `prompt` or `steer`, at send time. */
  runActive: boolean
  /** The `agent_start`s seen, to tell whether a run began after a steer. */
  runsStarted: number
  /** `state_change working` went out for the running turn. */
  working: boolean
  /** The agent's text of the current message, streamed but not closed. */
  textOpen: boolean
  /** Tool calls already shown in this run, by id. */
  toolCalls: Set<string>
  /** Pi's thinking levels for the session, asked once. */
  levels?: Promise<string[]>
  /** Pi's answer to `get_available_models` for the session, asked once. */
  available?: Promise<unknown>
  /** `parse` failures Pi reported for frames this adapter sent. */
  parseFailures: number
  initialPrompt?: string
  /** The exit code to report, when the adapter ended the session itself. */
  exitCode?: number
  ended: boolean
  closing: boolean
}

/** The child under the launch's environment: directly when its command is on
 *  the environment's PATH, through the login shell otherwise (as the ACP
 *  adapter starts its own). */
function spawnPi(launch: PiRpcLaunch, cwd: string): ChildProcessWithoutNullStreams {
  const [program, ...args] = launch.command
  if (!program) throw new Error('The Pi launch names no command')
  const executable = findExecutable(program, launch.env.PATH)
  // Through the login shell, a profile runs before Pi: a connection's
  // variables cross it under Clave's private names (PRDCT-4496).
  const handover =
    !executable && launch.connection
      ? connectionHandover(launch.connection.variables, launch.env)
      : null
  const env = handover ? { ...launch.env, ...handover.env } : launch.env
  const file = executable
    ? { file: executable, args }
    : resolvePosixShellLaunch(
        env.SHELL || process.env.SHELL || '/bin/zsh',
        `${handover?.command ?? ''}exec ${launch.command.map(shellSingleQuote).join(' ')}`
      )
  return spawn(file.file, file.args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
}

export class PiRpcAdapter implements SessionAdapter {
  readonly id: string
  readonly provider: string
  readonly label: string
  readonly transports = ['events'] as const
  readonly images = false
  private handles = new Map<string, HandleState>()
  private launches = new Map<string, PiRpcLaunch>()

  constructor(spec: PiRpcAgentSpec) {
    this.id = spec.id
    this.provider = spec.provider
    this.label = spec.label
  }

  /** The spawn's command and environment, handed by the manager before the
   *  spawn; main-only, never part of the Session record or the wire. */
  configure(sessionId: string, launch: PiRpcLaunch): void {
    this.launches.set(sessionId, launch)
  }

  async spawn(spec: SpawnSpec): Promise<SessionHandle> {
    if (this.handles.has(spec.id))
      throw new Error(`${this.label} session already exists: ${spec.id}`)
    const launch = this.launches.get(spec.id)
    if (!launch) throw new Error(`${this.label} session was not configured: ${spec.id}`)
    this.launches.delete(spec.id)
    const options = record(spec.options)
    const state: HandleState = {
      spec,
      launch,
      options: {
        ...(text(options.resume) ? { resume: text(options.resume) } : {}),
        ...(text(options.model) ? { model: text(options.model) } : {})
      },
      emitter: new EventEmitter(),
      model: null,
      commands: [],
      history: [],
      queue: [],
      starting: true,
      sends: Promise.resolve(),
      turnRunning: false,
      runActive: false,
      runsStarted: 0,
      working: false,
      textOpen: false,
      toolCalls: new Set(),
      parseFailures: 0,
      ...(launch.initialPrompt !== undefined ? { initialPrompt: launch.initialPrompt } : {}),
      ended: false,
      closing: false
    }
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawnPi(launch, spec.cwd)
    } catch (error) {
      this.launches.set(spec.id, launch)
      throw error
    }
    this.handles.set(spec.id, state)
    state.connection = new PiRpcConnection(child, {
      event: (frame) => this.event(state, frame),
      error: (error) => this.notice(state, error.message),
      exit: (code, stderrTail) => this.exited(state, code, stderrTail)
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
        state.working = true
        // Pi takes images only, and this adapter sends none: a file goes as
        // its path, for the agent to read.
        const lines = (value.attachments ?? []).flatMap((file) =>
          isFileAttachment(file) ? [`Attached file: ${file.path}`] : []
        )
        const message = [value.text, ...lines].join('\n')
        // Prompt or steer is decided at send time, from Pi's own events.
        state.turnRunning = true
        state.sends = state.sends.then(() => this.send(state, message))
        return
      }
      case 'interrupt':
        void this.interrupt(state)
        return
      case 'set_model':
        if (value.model === null) {
          this.emitMeta(state)
          return
        }
        void this.setModel(state, value.model).then(() => {
          if (!state.ended && !state.closing) this.emitMeta(state)
        })
        return
      case 'set_effort':
        void this.setEffort(state, value.effort)
        return
      default:
        // permission_response (Pi asks no permission), set_permission_mode,
        // stop_task, permission_draft: nothing Pi takes.
        return
    }
  }

  history(handle: SessionHandle): HistoryItem[] {
    return this.require(handle).history
  }

  async commands(handle: SessionHandle): Promise<CommandOption[]> {
    return this.require(handle).commands
  }

  /** The models Pi offers, asked once the handshake is over; a failed
   *  question is asked again at the next look. */
  async models(handle: SessionHandle): Promise<ModelOption[]> {
    const state = this.require(handle)
    if (state.started) await state.started.catch(() => {})
    const connection = state.connection
    if (!connection || connection.closed || state.ended) return []
    try {
      return await this.available(state, connection)
    } catch (error) {
      state.available = undefined
      throw error
    }
  }

  /** The models the chat offers, asked of Pi once: on a stored connection,
   *  that connection's provider's alone (PRDCT-4496). With `all`, every
   *  model Pi lists, whatever its provider: what tells whether Pi knows a
   *  name at all. */
  private available(
    state: HandleState,
    connection: PiRpcConnection,
    all = false
  ): Promise<ModelOption[]> {
    const provider = all ? undefined : state.launch.connection?.provider
    state.available ??= connection.command('get_available_models')
    return state.available.then((data) => piModelOptions(data, provider))
  }

  async kill(handle: SessionHandle): Promise<void> {
    const state = this.handles.get(handle.id)
    if (!state) return
    const connection = state.connection
    if (state.turnRunning && connection && !connection.closed)
      await connection
        .command('abort', undefined, { timeout: KILL_ABORT_TIMEOUT_MS })
        .catch(() => {})
    state.closing = true
    if (connection) await connection.close()
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

  private async handshake(state: HandleState): Promise<void> {
    const connection = state.connection!
    try {
      let data: Record<string, unknown>
      try {
        data = record(await connection.command('get_state'))
      } catch (error) {
        this.refuse(state, error)
        return
      }
      state.sessionId = text(data.sessionId) || undefined
      state.sessionFile = text(data.sessionFile) || undefined
      if (data.isStreaming === true) state.turnRunning = state.runActive = true
      this.takeModel(state, data.model)
      if (!state.model)
        this.notice(
          state,
          `${this.label} has no model configured; pick one in Pi (pi --list-models) or in the profile.`
        )
      const wanted = state.options.model
      if (wanted && wanted !== state.model && wanted !== state.modelId)
        await this.setModel(state, wanted)
      // A name Pi does not have for that provider: Pi 1.5.2 keeps it as a
      // custom model id (a warning on its stderr alone) and `get_state`
      // names it as asked, so the chat would read as fine until the
      // provider refuses the first message. Said once, kept in the past
      // for a pane drawn after the handshake (PRDCT-4427).
      else if (wanted && state.model) await this.sayUnknownModel(state)
      // A chat on a connection never names it while Pi runs elsewhere (a
      // resumed session on another provider's model, PRDCT-4496).
      await this.keepOnConnection(state, 'start')
      if (state.ended || state.closing) return
      if (state.options.resume) {
        try {
          state.history = piHistory(record(await connection.command('get_messages')).messages)
        } catch (error) {
          if (state.ended || state.closing) return
          this.notice(
            state,
            `${this.label} could not read the resumed conversation: ${errorMessage(error)}`
          )
        }
      }
      try {
        state.commands = array(record(await connection.command('get_commands')).commands).flatMap(
          (raw) => {
            const command = record(raw)
            const name = text(command.name)
            if (!name) return []
            const description = text(command.description)
            return [{ name, ...(description ? { description } : {}), insert: `/${name} ` }]
          }
        )
      } catch {
        // No commands to offer under "/": the chat works without them.
      }
      if (state.ended || state.closing) return
      this.emitMeta(state)
    } finally {
      state.starting = false
    }
  }

  /** Pi would not start (a state it would not give, a session it could not
   *  open): its word, then the session ends with code 1. */
  private refuse(state: HandleState, error: unknown): void {
    if (state.ended || state.closing) return
    this.startNotice(state, `${this.label} could not start: ${errorMessage(error)}`)
    state.exitCode = 1
    if (state.connection && !state.connection.closed) void state.connection.close()
    else this.exited(state, 1)
  }

  /** The session's model is not among those Pi lists: one sentence. A list
   *  Pi does not give, or gives empty, says nothing. */
  private async sayUnknownModel(state: HandleState): Promise<void> {
    const connection = state.connection
    if (!connection || connection.closed) return
    let listed: ModelOption[]
    try {
      listed = await this.available(state, connection, true)
    } catch {
      state.available = undefined
      return
    }
    if (state.ended || state.closing || listed.length === 0) return
    if (listed.some((m) => m.id === state.model)) return
    this.startNotice(
      state,
      piUnknownModel(this.label, state.modelId ?? state.model ?? '', state.modelProvider)
    )
  }

  private takeModel(state: HandleState, model: unknown): void {
    const m = record(model)
    state.model = modelName(model)
    state.modelId = text(m.id) || undefined
    state.modelProvider = text(m.provider) || undefined
    if (state.modelId && state.modelProvider === state.launch.connection?.provider)
      state.connectionModelId = state.modelId
  }

  /** Whether Pi is on a model of another provider than the chat's
   *  connection's; never on a chat on no connection. */
  private offConnection(state: HandleState): boolean {
    const provider = state.launch.connection?.provider
    return !!provider && !!state.modelProvider && state.modelProvider !== provider
  }

  /** On a stored connection, Pi on another provider's model (by whatever
   *  road: a resumed session, something typed) is put back on one of the
   *  connection's: the last it ran, the one the chat started on, else the
   *  first the connection's provider lists (PRDCT-4496). False when it could
   *  not be: the caller sends nothing, and the reader is told. */
  private async keepOnConnection(state: HandleState, when: 'start' | 'send'): Promise<boolean> {
    const provider = state.launch.connection?.provider
    const connection = state.connection
    if (!provider || !this.offConnection(state)) return true
    if (!connection || connection.closed) return false
    const foreign = state.model ?? ''
    const started = state.options.model
    const startedId =
      started && started.startsWith(`${provider}/`)
        ? started.slice(provider.length + 1)
        : started && !started.includes('/')
          ? started
          : undefined
    let listed: ModelOption[] = []
    try {
      listed = await this.available(state, connection)
    } catch {
      state.available = undefined
    }
    const candidates = [
      ...new Set(
        [
          state.connectionModelId,
          startedId,
          ...listed.map((m) => m.id.slice(provider.length + 1))
        ].filter((id): id is string => !!id)
      )
    ]
    for (const modelId of candidates) {
      if (state.ended || state.closing || connection.closed) return false
      try {
        this.takeModel(state, await connection.command('set_model', { provider, modelId }))
      } catch {
        continue
      }
      if (this.offConnection(state)) continue
      const said = piBackOnConnection(this.label, foreign, provider, state.model ?? modelId)
      if (when === 'start') this.startNotice(state, said)
      else this.notice(state, said)
      this.emitMeta(state)
      return true
    }
    const said = piOffConnection(this.label, foreign, provider)
    if (when === 'start') this.startNotice(state, said)
    else this.notice(state, said)
    return false
  }

  /** `provider/id` split on its first slash; a bare id takes the session's
   *  provider, else the first model Pi lists under that id. On a stored
   *  connection a model of another provider is refused before Pi is asked
   *  (PRDCT-4496). */
  private async setModel(state: HandleState, wanted: string): Promise<void> {
    const connection = state.connection
    if (!connection || connection.closed) return
    const slash = wanted.indexOf('/')
    const confined = state.launch.connection?.provider
    let provider = slash >= 0 ? wanted.slice(0, slash) : (confined ?? state.modelProvider)
    const modelId = slash >= 0 ? wanted.slice(slash + 1) : wanted
    if (confined && provider !== confined) {
      this.notice(state, piForeignModelRefused(this.label, wanted, confined, state.model))
      return
    }
    try {
      if (!provider) {
        const models = array(record(await connection.command('get_available_models')).models)
        provider = text(record(models.find((raw) => text(record(raw).id) === modelId)).provider)
      }
      if (!provider) {
        this.notice(
          state,
          `${this.label} does not offer the model ${wanted}; the session stays on ${state.model ?? 'no model'}`
        )
        return
      }
      this.takeModel(state, await connection.command('set_model', { provider, modelId }))
    } catch (error) {
      if (state.ended || state.closing) return
      this.notice(
        state,
        `${this.label} could not switch to ${wanted}: ${errorMessage(error)}; the session stays on ${state.model ?? 'no model'}`
      )
    }
  }

  private async setEffort(state: HandleState, level: string): Promise<void> {
    const connection = state.connection
    if (!connection || connection.closed) return
    try {
      state.levels ??= connection
        .command('get_available_thinking_levels')
        .then((data) => array(record(data).levels).map(text).filter(Boolean))
      const levels = await state.levels
      if (!levels.includes(level)) {
        this.notice(
          state,
          `${this.label} does not offer the thinking level ${level}${levels.length ? ` (it offers ${levels.join(', ')})` : ''}`
        )
        return
      }
      await connection.command('set_thinking_level', { level })
    } catch (error) {
      // A failed question is asked again next time.
      state.levels = undefined
      if (state.ended || state.closing) return
      this.notice(
        state,
        `${this.label} could not set the thinking level ${level}: ${errorMessage(error)}`
      )
    }
  }

  /** One message to Pi, after the previous send and the handshake: a `steer`
   *  while a run Pi started is going (Pi takes it up after the current tool
   *  call), a `prompt` otherwise. A prompt refused as streaming goes once
   *  more as a steer; a steer answered while no run goes, and none starts
   *  within 200 ms, goes once more as a prompt. */
  private async send(
    state: HandleState,
    message: string,
    retry?: 'prompt' | 'steer'
  ): Promise<void> {
    if (state.started) await state.started.catch(() => {})
    const connection = state.connection
    if (state.ended || state.closing || !connection || connection.closed) return
    const retried = retry !== undefined
    const steer = retried ? retry === 'steer' : state.runActive
    // On a stored connection nothing goes to Pi, prompt, steer or either one
    // re-sent, while Pi is on another provider's model: Pi's model is read
    // first, and one of another provider's (something typed changed it, or
    // an extension during a run) is put back, Pi taking the change mid-run
    // too, or the message is not sent (PRDCT-4496, PRDCT-4427). A run going
    // ends its turn itself.
    if (!(await this.confirmOnConnection(state, connection))) {
      if (state.ended || state.closing) return
      if (!state.runActive) {
        state.turnRunning = false
        this.endTurn(state, false)
      }
      return
    }
    if (state.ended || state.closing || connection.closed) return
    const runsBefore = state.runsStarted
    let data: Record<string, unknown>
    try {
      data = record(await connection.command(steer ? 'steer' : 'prompt', { message }))
    } catch (error) {
      if (state.ended || state.closing) return
      if (!steer && !retried && /streaming/i.test(errorMessage(error)))
        return this.send(state, message, 'steer')
      this.notice(state, `${this.label}: ${errorMessage(error)}`)
      if (!steer && !state.runActive) {
        state.turnRunning = false
        this.endTurn(state, false)
      }
      return
    }
    // An extension command ran at once: no run, so no agent_settled.
    if (!steer && data.disposition === 'handled' && !state.runActive) {
      state.turnRunning = false
      this.endTurn(state, false)
      return
    }
    if (steer && !retried && !state.runActive) {
      await new Promise((resolve) => setTimeout(resolve, STEER_SETTLE_MS))
      if (state.ended || state.closing) return
      if (!state.runActive && state.runsStarted === runsBefore)
        return this.send(state, message, 'prompt')
    }
  }

  /** Pi's model as it says it now, kept on the connection's provider
   *  (`keepOnConnection`); always true on no connection. A state Pi does not
   *  give is not taken as a model on the connection: nothing is sent. */
  private async confirmOnConnection(
    state: HandleState,
    connection: PiRpcConnection
  ): Promise<boolean> {
    if (!state.launch.connection) return true
    try {
      const data = record(await connection.command('get_state'))
      const before = state.model
      this.takeModel(state, data.model)
      if (state.model !== before && !this.offConnection(state)) this.emitMeta(state)
    } catch (error) {
      if (state.ended || state.closing) return false
      this.notice(state, `${this.label}: ${errorMessage(error)}`)
      return false
    }
    return this.keepOnConnection(state, 'send')
  }

  /** Esc: the queue cleared first (an abort leaves queued messages to run),
   *  then the abort; the run ends on `agent_settled { aborted: true }`. */
  private async interrupt(state: HandleState): Promise<void> {
    const connection = state.connection
    if (!state.turnRunning || !connection || connection.closed) return
    try {
      await connection.command('clear_queue')
      await connection.command('abort', undefined, { timeout: ABORT_TIMEOUT_MS })
    } catch (error) {
      if (state.ended || state.closing) return
      this.notice(state, `${this.label} could not stop the turn: ${errorMessage(error)}`)
    }
  }

  /** The turn's end as the ACP chat says it: the open text closed,
   *  `turn_interrupted` for an aborted run, then `done`. */
  private endTurn(state: HandleState, aborted: boolean): void {
    state.runActive = false
    this.closeText(state)
    state.toolCalls.clear()
    state.working = false
    if (aborted) this.emit(state, { type: 'turn_interrupted' })
    this.emit(state, { type: 'state_change', state: 'done' })
  }

  private async contextUsage(state: HandleState): Promise<void> {
    const connection = state.connection
    if (!connection || connection.closed) return
    try {
      const usage = record(record(await connection.command('get_session_stats')).contextUsage)
      if (state.ended || state.closing) return
      const tokens = usage.tokens
      if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return
      const window = usage.contextWindow
      this.emit(state, {
        type: 'context_usage',
        used: tokens,
        window: typeof window === 'number' && window > 0 ? window : null
      })
    } catch {
      // The gauge waits for the next turn.
    }
  }

  private event(state: HandleState, frame: PiRpcEvent): void {
    if (state.ended) return
    switch (frame.type) {
      case 'agent_start':
        state.turnRunning = true
        state.runActive = true
        state.runsStarted++
        if (!state.working) {
          state.working = true
          this.emit(state, { type: 'state_change', state: 'working' })
        }
        return
      case 'message_update':
        this.messageUpdate(state, record(frame.assistantMessageEvent))
        return
      case 'message_end': {
        const message = record(frame.message)
        if (message.role !== 'assistant') return
        this.closeText(state)
        if (message.stopReason === 'error')
          this.notice(state, `${this.label}: ${text(message.errorMessage) || 'the model failed'}`)
        return
      }
      case 'tool_execution_start': {
        const id = text(frame.toolCallId)
        if (!id || state.toolCalls.has(id)) return
        state.toolCalls.add(id)
        this.closeText(state)
        this.emit(state, {
          type: 'tool_call',
          id,
          name: text(frame.toolName) || 'tool',
          input: frame.args ?? {}
        })
        return
      }
      case 'tool_execution_end': {
        const id = text(frame.toolCallId)
        if (!id) return
        this.emit(state, {
          type: 'tool_result',
          id,
          output: blocksText(record(frame.result).content),
          error: frame.isError === true
        })
        return
      }
      case 'agent_settled':
        state.turnRunning = false
        state.runActive = false
        this.endTurn(state, frame.aborted === true)
        void this.contextUsage(state)
        return
      case 'auto_retry_start': {
        const delay = typeof frame.delayMs === 'number' ? frame.delayMs / 1000 : 0
        this.notice(
          state,
          `${this.label} retries in ${delay} s (attempt ${String(frame.attempt)} of ${String(frame.maxAttempts)}): ${text(frame.errorMessage)}`
        )
        return
      }
      case 'extension_ui_request':
        this.extensionRequest(state, frame)
        return
      case 'response':
        if (frame.command === 'parse') state.parseFailures++
        return
      default:
        // turn_start, turn_end, agent_end, message_start, queue_update,
        // entry_appended, session_info_changed, thinking_level_changed,
        // tool_execution_update, compaction_*, auto_retry_end,
        // summarization_*, extension_error and anything newer: nothing shown.
        return
    }
  }

  private messageUpdate(state: HandleState, update: Record<string, unknown>): void {
    switch (update.type) {
      case 'text_delta': {
        const delta = text(update.delta)
        if (!delta) return
        state.textOpen = true
        this.emit(state, { type: 'assistant_text', delta, final: false })
        return
      }
      case 'text_end':
        this.closeText(state)
        return
      case 'toolcall_end': {
        const call = record(update.toolCall)
        const id = text(call.id)
        this.closeText(state)
        if (!id || state.toolCalls.has(id)) return
        state.toolCalls.add(id)
        this.emit(state, {
          type: 'tool_call',
          id,
          name: text(call.name) || 'tool',
          input: call.arguments ?? {}
        })
        return
      }
      default:
        // text_start, thinking_* (the model has no thinking event),
        // toolcall_start and toolcall_delta (partial JSON, never parsed).
        return
    }
  }

  /** A dialog would block Pi until answered: it is cancelled at once and the
   *  reader told; a notify is a notice; the rest draws Pi's own TUI. */
  private extensionRequest(state: HandleState, frame: PiRpcEvent): void {
    const method = text(frame.method)
    if (DIALOGS.has(method)) {
      const connection = state.connection
      if (connection && !connection.closed) {
        try {
          connection.send({ type: 'extension_ui_response', id: frame.id, cancelled: true })
        } catch {
          // The connection closed under us: nothing waits any more.
        }
      }
      this.notice(
        state,
        `${this.label} asked « ${text(frame.title)} »; answer it in a Pi terminal, this chat cannot yet.`
      )
      return
    }
    if (method === 'notify' && text(frame.message)) this.notice(state, text(frame.message))
  }

  /** The live message in progress is whole: an empty final delta, as the ACP
   *  chat closes its own. */
  private closeText(state: HandleState): void {
    if (!state.textOpen) return
    state.textOpen = false
    this.emit(state, { type: 'assistant_text', delta: '', final: true })
  }

  private emitMeta(state: HandleState): void {
    this.emit(state, {
      type: 'session_meta',
      // A chat on a connection never names another provider's model as the
      // one it runs on (it sends nothing on one, `keepOnConnection`).
      model: this.offConnection(state) ? null : state.model,
      providerSessionId: state.sessionId ?? null
    })
  }

  /** The adapter's word to the reader, never fatal. */
  private notice(state: HandleState, message: string): void {
    if (state.ended) return
    this.emit(state, { type: 'error', message, fatal: false })
  }

  /** Why Pi would not start (PRDCT-4427): said live, and kept in the
   *  session's past. The live word reaches only the views subscribed when the
   *  queue is let go, and the first subscriber lets it go: a pane that opens
   *  after it (another view of the window subscribed first, a server's push
   *  subscription shared) reads the past and nothing else, and saw only
   *  "Session ended". The view drops the past's copy of a notice it already
   *  shows. */
  private startNotice(state: HandleState, message: string): void {
    if (state.ended) return
    this.notice(state, message)
    state.history.push({ event: { type: 'error', message, fatal: false }, at: Date.now() })
  }

  private exited(state: HandleState, code: number, stderrTail?: string): void {
    if (state.ended) return
    if (state.starting && !state.closing && state.exitCode === undefined) {
      // Pi died before it gave its state: a refusal, said as one, in Pi's
      // own last words and with its status (PRDCT-4427).
      this.startNotice(state, startRefusal(this.label, code, stderrTail, state.launch.env))
      state.exitCode = code || 1
    } else if (state.turnRunning && !state.closing)
      this.notice(state, `${this.label} stopped during the turn (exit code ${code})`)
    state.ended = true
    state.turnRunning = false
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
