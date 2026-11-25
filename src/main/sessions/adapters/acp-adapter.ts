import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  SessionInputSchema,
  userMessageEvent,
  type CommandOption,
  type HistoryItem,
  type ModelOption,
  type SessionEvent,
  type SessionInput,
  type UserMessage,
  type WaitingMessage
} from '../../../shared/session-model'
import { isFileAttachment } from '../../../shared/attachments'
import { splitModelLevel } from '../../../shared/antigravity'
import { isAntigravityMode, stricterMode } from '../../../shared/antigravity-mode'
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
import { lastWords, startRefusal } from './start-refusal'
import { splitUnsent } from './unsent'
import { connectionHandover } from '../../connection-handover'
import { lazyTerminalPorts } from '../../ports/terminals'
import { readClaveMcpEndpoint, withOpencodeClaveTools } from '../../clave-tools-launch'
import { OPENCODE_CONFIG_ENV } from '../../provider-injection'
import { STYLE_SUPPORT, styleAsFirstMessage } from '../../../shared/writing-styles'
import type { LauncherFamily } from '../../../shared/agent-launch'

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
  /** PRDCT-4507: hand every chat Clave's own tools in OpenCode's inline
   *  configuration (`opencode`, the app's OpenCode chat); none otherwise. */
  claveTools?: 'opencode'
  /** The agent's `mode` option is its permission ladder and its
   *  `thought_level` option the model's effort, as `agy acp`'s are: the chat
   *  shows and switches both. Off for OpenCode, whose modes are its agents. */
  sessionOptions?: boolean
}
export interface AcpLaunch {
  command: string[]
  env: NodeJS.ProcessEnv
  cwd?: string
  initialPrompt?: string
  /** A stored connection's own variables in `env`, carried past a login
   *  profile when the agent is started through the shell (PRDCT-4496). */
  connectionVariables?: readonly string[]
  /** A writing style's text (PRDCT-5166) for an agent that takes no
   *  instructions at launch (`STYLE_SUPPORT`'s `first-message`, Antigravity):
   *  sent with the first message of a conversation this spawn opens. An
   *  agent on another road (OpenCode's instruction file) never reads it. */
  styleText?: string
}
export interface AcpSpawnOptions {
  resume?: string
  model?: string
  /** The rung of the agent's own ladder the session starts on, a value of
   *  its `mode` config option (Antigravity's `accept-edits`, `plan`, …). */
  mode?: string
  /** The rung when the launch asks none: set where the agent offers it, left
   *  in silence where it does not (no Auto on a business account). */
  defaultMode?: string
  /** The rung somebody picked, when `mode` is one: what `chosenMode` starts
   *  on. A default is never a pick. */
  pickedMode?: string
  /** The level of the model's `thought_level` to start on, where it takes it. */
  effort?: string
  autoApprove?: boolean
  initialPrompt?: string
}
export interface AcpSessionSummary {
  sessionId: string
  cwd?: string
  updatedAt?: string
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
/** A prompt with the writing style before the person's text: its first text
 *  block carries `styleAsFirstMessage`, or one is put first when there is
 *  none. The other blocks (an attachment's link) are kept as they are. */
function withStyleFirst(prompt: unknown[], style: string): unknown[] {
  const at = prompt.findIndex((block) => object(block).type === 'text')
  if (at < 0) return [{ type: 'text', text: styleAsFirstMessage(style, '') }, ...prompt]
  const block = object(prompt[at])
  return prompt.map((entry, index) =>
    index === at ? { ...block, text: styleAsFirstMessage(style, text(block.text)) } : entry
  )
}
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

/** A message written to the chat, on its way to its own turn (PRDCT-4566). */
interface Outgoing {
  id: string
  /** What the conversation draws once the agent takes it. */
  event: UserMessage
  /** What the agent is sent. */
  prompt: unknown[]
  /** Withdrawn, or handed back by a stop or an end: its turn never goes. */
  dropped: boolean
  /** The switches written before it, and the failures known by then. */
  after: Promise<void>
  failedBefore: number
  stopsBefore: number
}
/** Why messages that waited leave unsent. */
type Returned = 'withdrawn' | 'stopped' | 'ended'
const waitingOf = (message: Outgoing): WaitingMessage => ({
  id: message.id,
  text: message.event.text,
  ...(message.event.attachments?.length ? { attachments: message.event.attachments } : {}),
  // The ledger keeps an identified message pending while it waits, and
  // records it rejected when it is handed back (`session-events.ts`).
  ...(message.event.clientMessageId !== undefined
    ? { clientMessageId: message.event.clientMessageId }
    : {})
})

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
  /** The mode and the level last said to the chat; unset until the handshake
   *  settles, so the agent's opening values never read as a switch. */
  said?: { mode?: string; effort: string | null }
  /** The mode picked: the launch's or the chip's. Never the default. */
  chosen?: string
  /** The mode the session settled on, what a step of the agent's own is
   *  measured from while nothing was picked. */
  base?: string
  /** A stricter mode the agent stepped to on its own (`/plan`), for as long
   *  as it stays in it. */
  step?: string
  /** The chip's switch on its way to the agent. */
  picking?: string
  /** The switches, one after another: agy handles requests at once and
   *  answers them out of order. A prompt waits for those written before it. */
  switches: Promise<void>
  /** Counts the stricter switches that failed: what was written behind one
   *  is not sent. */
  failedSwitches: number
  /** Counts the stops: what was written before one, and not yet sent, stays. */
  stops: number
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
  /** Prompts chained and not yet over, the running one included: a message
   *  written while there is one waits for its own turn (PRDCT-4566). */
  prompts: number
  /** The messages that wait for their turn, in the order written: outside
   *  the conversation until their prompt goes (PRDCT-4566). */
  waiting: Outgoing[]
  /** The last id given to a written message. */
  written: number
  /** A `session/prompt` awaiting its answer. */
  turnRunning: boolean
  /** The agent's text of the current message, streamed but not closed. */
  textOpen: boolean
  /** Tool calls already shown, by `toolCallId`. */
  toolCalls: Set<string>
  /** The input each shown call was shown with (its JSON), PRDCT-4507: OpenCode
   *  2.3.0 opens a call with `rawInput: {}` and sends what it runs (its
   *  `execute` script) in a later `tool_call_update`, so the card is told
   *  again when the input arrives or changes. */
  toolInputs: Map<string, { name: string; json: string }>
  permissions: Map<string, PendingPermission>
  initialPrompt?: string
  /** The writing style still owed to the agent (PRDCT-5166): set when the
   *  handshake opened a new conversation (`session/new`), taken by the first
   *  `session/prompt`. Never set on a conversation loaded back. */
  styleOwed?: string
  /** The exit code to report, when the adapter ended the session itself. */
  exitCode?: number
  /** PRDCT-4507: the tab's credential for Clave's tools was issued at this
   *  spawn, and is let go of when the process ends. */
  claveTools?: boolean
  ended: boolean
  closing: boolean
}

/** The text of a list of ACP ToolContent items: content blocks' text, and a
 *  diff as its path, then the old text and the new. */
/** A tool call's input that says something: a non-empty object, or a value
 *  that is not one (an array, a string). `{}` and nothing say nothing. */
function hasInput(input: unknown): boolean {
  if (input === undefined || input === null) return false
  if (typeof input === 'object' && !Array.isArray(input)) return Object.keys(input).length > 0
  return true
}

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
const modeOption = (state: HandleState): ConfigOption | undefined =>
  state.configOptions.find((option) => option.category === 'mode')
const levelOption = (state: HandleState): ConfigOption | undefined =>
  state.configOptions.find((option) => option.category === 'thought_level')
const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** A chat that opened on another model than the one asked, in one sentence
 *  naming both (PRDCT-4427). */
export function modelMismatch(label: string, asked: string, current: string | undefined): string {
  return `${label} does not have the model ${asked}: this chat runs on ${current || `the model ${label} picks`}.`
}

/** The name of the retry notice: the latest stands for the ones before. */
const RETRY_NOTICE = 'retry'

/** OpenCode's retry (`_meta["opencode/retry"]` of a `session_info_update`,
 *  opencode 2.3.0: `{ attempt, nextRetryAt, error: { message, retryAfterMs } }`)
 *  in one sentence, in the Pi chat's words for its own: when, which attempt,
 *  and the provider's words, any credential value of `env` masked in them
 *  (`lastWords`). Null when the value names no retry (OpenCode sends null
 *  once the retry went out). */
export function retryNotice(
  label: string,
  value: unknown,
  env?: Readonly<Record<string, string | undefined>>,
  now = Date.now()
): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const retry = value as Record<string, unknown>
  const error = object(retry.error)
  const attempt =
    typeof retry.attempt === 'number' && Number.isFinite(retry.attempt) ? retry.attempt : null
  const waitMs =
    typeof error.retryAfterMs === 'number'
      ? error.retryAfterMs
      : Date.parse(text(retry.nextRetryAt)) - now
  const seconds = Number.isFinite(waitMs) && waitMs >= 500 ? Math.round(waitMs / 1000) : null
  const words = lastWords(text(error.message), env)
  return `${label} retries${seconds !== null ? ` in ${seconds} s` : ''}${attempt !== null ? ` (attempt ${attempt})` : ''}${words ? `: ${words}` : ''}`
}

/** The child under the launch's environment: directly when its command is on
 *  the environment's PATH, through the login shell otherwise (as the Claude
 *  and Codex adapters start theirs). */
function spawnAgent(launch: AcpLaunch, cwd: string): ChildProcessWithoutNullStreams {
  const [program, ...args] = launch.command
  if (!program) throw new Error('The agent launch names no command')
  const executable = findExecutable(program, launch.env.PATH)
  // Through the login shell, a profile runs before the agent: a stored
  // connection's variables cross it under Clave's private names (PRDCT-4496).
  const handover =
    !executable && launch.connectionVariables?.length
      ? connectionHandover(launch.connectionVariables, launch.env)
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

export class AcpAdapter implements SessionAdapter {
  readonly id: string
  readonly provider: string
  readonly label: string
  readonly transports = ['events'] as const
  readonly images = false
  private handles = new Map<string, HandleState>()
  private launches = new Map<string, AcpLaunch>()

  private readonly claveTools: 'opencode' | undefined
  private readonly sessionOptions: boolean

  constructor(spec: AcpAgentSpec) {
    this.id = spec.id
    this.provider = spec.provider
    this.label = spec.label
    this.claveTools = spec.claveTools
    this.sessionOptions = spec.sessionOptions === true
  }

  /** The spawn's command and environment, handed by the manager before the
   *  spawn; main-only, never part of the Session record or the wire. */
  configure(sessionId: string, launch: AcpLaunch): void {
    this.launches.set(sessionId, launch)
  }

  /** Whether this agent takes a writing style with its first message
   *  (`STYLE_SUPPORT`, PRDCT-5166): Antigravity's chat, never OpenCode's,
   *  which shares this adapter and reads its style from a file. */
  private styleByFirstMessage(): boolean {
    const support = STYLE_SUPPORT[this.provider as LauncherFamily] as
      | (typeof STYLE_SUPPORT)[LauncherFamily]
      | undefined
    return support?.chat === 'first-message'
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
        ...(text(options.mode) ? { mode: text(options.mode) } : {}),
        ...(text(options.defaultMode) ? { defaultMode: text(options.defaultMode) } : {}),
        ...(text(options.effort) ? { effort: text(options.effort) } : {}),
        ...(text(options.pickedMode) ? { pickedMode: text(options.pickedMode) } : {}),
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
      switches: Promise.resolve(),
      failedSwitches: 0,
      stops: 0,
      prompts: 0,
      waiting: [],
      written: 0,
      turnRunning: false,
      textOpen: false,
      toolCalls: new Set(),
      toolInputs: new Map(),
      permissions: new Map(),
      ended: false,
      closing: false
    }
    state.chosen = state.options.pickedMode
    state.initialPrompt = state.options.initialPrompt ?? launch.initialPrompt
    let child: ChildProcessWithoutNullStreams
    try {
      // The launch as run, the token's variable included, is the one every
      // mask of the agent's last words reads.
      state.launch = this.withClaveTools(state, launch)
      child = spawnAgent(state.launch, spec.cwd)
    } catch (error) {
      this.letGoOfClaveTools(state)
      this.launches.set(spec.id, launch)
      throw error
    }
    this.handles.set(spec.id, state)
    state.connection = new AcpConnection(child, {
      notification: (frame) => this.notification(state, frame),
      request: (frame) => this.request(state, frame),
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
        const prompt: unknown[] = [{ type: 'text', text: value.text }]
        for (const file of value.attachments ?? [])
          if (isFileAttachment(file))
            prompt.push({ type: 'resource_link', uri: `file://${file.path}`, name: file.name })
        const message: Outgoing = {
          id: `waiting-${++state.written}`,
          event: userMessageEvent(value),
          prompt,
          dropped: false,
          after: state.switches,
          failedBefore: state.failedSwitches,
          stopsBefore: state.stops
        }
        // The agent runs one prompt at a time and takes a message only once
        // the turns before it are over: written while one runs, it waits
        // outside the conversation and enters it as its own turn starts, so
        // each answer is drawn under the message it answers (PRDCT-4566).
        if (state.prompts > 0) {
          state.waiting.push(message)
          this.emitWaiting(state)
        } else {
          this.emit(state, message.event)
          this.emit(state, { type: 'state_change', state: 'working' })
        }
        state.prompts++
        state.turns = state.turns.then(() => this.prompt(state, message))
        return
      }
      case 'withdraw_message':
        this.withdraw(state, value.id)
        return
      case 'permission_response':
        this.answerPermission(state, value.id, value.optionId)
        return
      case 'interrupt':
        // A stop starts nothing by itself: what waited goes back to the
        // composer, unsent (PRDCT-4566).
        this.handBack(state, 'stopped')
        // A message held behind a switch is no turn to cancel yet.
        if (this.sessionOptions) state.stops++
        this.cancel(state)
        return
      case 'set_model':
        if (value.model === null) {
          this.emitMeta(state)
          return
        }
        {
          const { model } = value
          if (this.sessionOptions) this.inTurn(state, () => this.setModel(state, model))
          else void this.setModel(state, model)
        }
        return
      case 'set_permission_mode':
        if (this.sessionOptions) {
          const { mode } = value
          this.inTurn(state, () => this.switchMode(state, mode))
        }
        return
      case 'set_effort':
        if (this.sessionOptions) {
          const { effort } = value
          this.inTurn(state, () => this.switchEffort(state, effort))
        }
        return
      default:
        // stop_task, permission_draft: the protocol carries neither.
        return
    }
  }

  /** The mode picked in this chat, what its record keeps; undefined while it
   *  runs on the default. */
  chosenMode(id: string): string | undefined {
    const state = this.handles.get(id)
    return state?.step ?? state?.chosen
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
    const option = modelOption(state)
    const models = modelChoices(option)
    if (!this.sessionOptions) return models
    // The agent says the levels of the model the session is on, and no other's.
    const efforts = (levelOption(state)?.choices ?? []).map((choice) => ({
      id: choice.value,
      label: choice.name || choice.value
    }))
    return models.map((model) =>
      efforts.length && model.id === option?.currentValue ? { ...model, efforts } : model
    )
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
            await connection.request(
              'session/load',
              { sessionId: resume, cwd: state.spec.cwd, mcpServers: [] },
              { onResult: (result) => this.takeOptions(state, result) }
            )
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
          state.toolInputs.clear()
        }
      }
      if (!opened) {
        try {
          opened = object(
            await connection.request(
              'session/new',
              { cwd: state.spec.cwd, mcpServers: [] },
              { onResult: (result) => this.takeOptions(state, result) }
            )
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
        // A new conversation, the launch's style owed to its first message
        // (PRDCT-5166); a loaded one already had it at its own start.
        if (state.launch.styleText && this.styleByFirstMessage())
          state.styleOwed = state.launch.styleText
      }
      this.emitMeta(state)
      // The model asked for against the one the session opened on. OpenCode
      // opens on a model of its own, silently, when its configuration names
      // one it does not have (2.3.0): said once, and kept in the past, since
      // a pane drawn after the handshake (a tab opened in the background, the
      // separate server's queue let go first) reads only that.
      const asked = state.options.model
      const option = modelOption(state)
      const variant =
        this.sessionOptions && asked && option && !option.values.includes(asked)
          ? splitModelLevel(asked, option.values)
          : null
      const wanted = variant?.model ?? asked
      if (wanted && wanted !== option?.currentValue) {
        if (option?.values.includes(wanted)) await this.setModel(state, wanted)
        else this.notice(state, modelMismatch(this.label, wanted, option?.currentValue))
      }
      // After the model, whose change puts the level back on that model's own.
      if (this.sessionOptions) await this.setStartEffort(state, variant?.level)
      await this.setStartMode(state)
      if (this.sessionOptions && !(await this.heldTheMode(state))) return
      if (this.sessionOptions && !state.ended && !state.closing) {
        state.said = { effort: null }
        state.base = modeOption(state)?.currentValue
        this.sayOptions(state, true)
      }
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

  /** The rung the launch asked for, else the default, set through the
   *  agent's `mode` config option once the session is open and before any
   *  prompt goes. A rung asked for that the agent does not offer is said
   *  once; the session stays on its own. */
  private async setStartMode(state: HandleState): Promise<void> {
    const { mode, defaultMode } = state.options
    const wanted = mode ?? defaultMode
    if (!wanted || !state.connection || !state.sessionId) return
    const option = modeOption(state)
    if (option?.currentValue === wanted) return
    if (!option?.values.includes(wanted)) {
      // An agy with no ladder at all runs in Ask: nothing to say of a mode
      // that is Ask or looser (a stricter one ends the chat, `heldTheMode`).
      const unsaid = this.sessionOptions && !option && mode !== 'plan'
      if (mode && !unsaid)
        this.notice(state, `${this.label} has no mode ${mode}; the session starts in its own`)
      return
    }
    try {
      await this.setOption(state, option, wanted)
    } catch (error) {
      if (!state.ended && !state.closing)
        this.notice(
          state,
          `${this.label} could not start in mode ${wanted}: ${errorMessage(error)}`
        )
    }
  }

  /** The level to start on: the one the model's id named, else the one asked
   *  or last picked. One the model does not take is dropped in silence, as
   *  Codex drops it: the last pick was another model's. */
  private async setStartEffort(state: HandleState, named?: string): Promise<void> {
    const wanted = named ?? state.options.effort
    const option = levelOption(state)
    if (!wanted || !option?.values.includes(wanted) || option.currentValue === wanted) return
    try {
      await this.setOption(state, option, wanted)
    } catch (error) {
      if (!state.ended && !state.closing)
        this.notice(state, `${this.label} could not start at ${wanted}: ${errorMessage(error)}`)
    }
  }

  /** One switch at a time, each reading the options the one before left. */
  private inTurn(state: HandleState, change: () => Promise<void>): void {
    state.switches = state.switches
      .then(async () => {
        await state.started?.catch(() => {})
        if (!state.ended && !state.closing) await change()
      })
      .catch((error) => console.error(`${this.label} switch failed:`, error))
  }

  /** The chip's switch, mid-turn too. Whatever happens, the chat is told the
   *  mode the session is really on, and a failed move to a stricter one
   *  holds what was written behind it. */
  private async switchMode(state: HandleState, mode: string): Promise<void> {
    const option = modeOption(state)
    try {
      if (option?.values.includes(mode) && option.currentValue === mode) {
        // Already on it: now it is a pick, and is said as one.
        const known = state.chosen === mode && state.step === undefined
        state.chosen = mode
        state.step = undefined
        if (!known) this.sayOptions(state, true)
        return
      }
      if (!option?.values.includes(mode)) {
        this.notice(
          state,
          `${this.label} has no mode ${mode}; the session stays on ${option?.currentValue || 'its own'}`
        )
      } else {
        state.picking = mode
        await this.setOption(state, option, mode)
        this.sayOptions(state)
        return
      }
    } catch (error) {
      if (state.ended || state.closing) return
      this.notice(state, `${this.label} could not switch to ${mode}: ${errorMessage(error)}`)
    } finally {
      state.picking = undefined
    }
    const current = modeOption(state)?.currentValue || 'default'
    if (isAntigravityMode(mode) && stricterMode(current, mode) !== current) state.failedSwitches++
    this.sayOptions(state, true)
  }

  private async switchEffort(state: HandleState, effort: string): Promise<void> {
    const option = levelOption(state)
    try {
      if (option?.values.includes(effort)) await this.setOption(state, option, effort)
      else this.notice(state, `${this.label} does not run this model at ${effort}`)
    } catch (error) {
      if (state.ended || state.closing) return
      this.notice(state, `${this.label} could not switch to ${effort}: ${errorMessage(error)}`)
    }
    this.sayOptions(state)
  }

  private async setOption(state: HandleState, option: ConfigOption, value: string): Promise<void> {
    await state.connection!.request(
      'session/set_config_option',
      { sessionId: state.sessionId, configId: option.id, value },
      {
        onResult: (answer) => {
          const { configOptions } = object(answer)
          if (Array.isArray(configOptions)) state.configOptions = parseConfigOptions(configOptions)
          else option.currentValue = value
          if (option.category !== 'mode' || state.picking !== value) return
          state.chosen = value
          state.step = undefined
        }
      }
    )
  }

  /** The options a session opened with, taken in wire order. */
  private takeOptions(state: HandleState, answer: unknown): void {
    state.configOptions = parseConfigOptions(object(answer).configOptions)
  }

  /** An update of the agent's own options, live or behind a load's answer.
   *  A step of its own toward asking more is kept while it lasts and let go
   *  when it leaves it; one toward asking less never becomes the pick. */
  private agentOptions(state: HandleState, update: Record<string, unknown>): void {
    const before = modeOption(state)?.currentValue
    if (update.sessionUpdate === 'current_mode_update') {
      const option = modeOption(state)
      const mode = text(update.currentModeId)
      if (!option?.values.includes(mode)) return
      option.currentValue = mode
    } else if (Array.isArray(update.configOptions)) {
      state.configOptions = parseConfigOptions(update.configOptions)
    } else return
    const now = modeOption(state)?.currentValue
    if (now && now !== before && state.said) {
      if (now === state.picking) {
        // The switch's own change, ahead of its answer (`config_option_update`
        // is a late snapshot): chosen before it is said, or the write-back
        // records the pick before it and is never corrected.
        state.chosen = now
        state.step = undefined
      } else {
        const held = state.chosen ?? state.base
        state.step = held && now !== held && stricterMode(now, held) === now ? now : undefined
      }
    }
    this.sayOptions(state)
  }

  /** Whether the session is no looser than the mode it was to start in. One
   *  that is ends before its first prompt: Plan asked and not set is never a
   *  turn run in Ask. */
  private async heldTheMode(state: HandleState): Promise<boolean> {
    const wanted = state.options.mode ?? state.options.defaultMode
    if (!isAntigravityMode(wanted) || state.ended || state.closing) return true
    const current = modeOption(state)?.currentValue || 'default'
    if (stricterMode(current, wanted) === current) return true
    this.notice(
      state,
      `${this.label} could not start in ${wanted}, so nothing was sent: the chat will not run in a mode that asks less`
    )
    state.exitCode = 1
    await state.connection?.close()
    return false
  }

  /** The mode, with the ladder the agent offers, and the level, as they now
   *  stand: each only when it changed, or both when `force`. */
  private sayOptions(state: HandleState, force = false): void {
    const said = state.said
    if (!said) return
    const mode = modeOption(state)
    if (mode && (force || said.mode !== mode.currentValue)) {
      said.mode = mode.currentValue
      this.emit(state, {
        type: 'permission_mode',
        mode: mode.currentValue,
        modes: mode.choices.map((choice) => ({
          id: choice.value,
          label: choice.name || choice.value
        }))
      })
    }
    const effort = levelOption(state)?.currentValue || null
    if (force || said.effort !== effort) {
      said.effort = effort
      this.emit(state, { type: 'effort', effort })
    }
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
      await state.connection.request(
        'session/set_config_option',
        { sessionId: state.sessionId, configId: option.id, value: model },
        {
          onResult: (answer) => {
            const { configOptions } = object(answer)
            if (Array.isArray(configOptions))
              state.configOptions = parseConfigOptions(configOptions)
            else option.currentValue = model
          }
        }
      )
      this.emitMeta(state)
      this.sayOptions(state)
    } catch (error) {
      if (!state.ended && !state.closing)
        this.notice(state, `${this.label} could not switch to ${model}: ${errorMessage(error)}`)
    }
  }

  private async prompt(state: HandleState, message: Outgoing): Promise<void> {
    try {
      await this.turn(state, message)
    } finally {
      state.prompts--
    }
  }

  private async turn(state: HandleState, message: Outgoing): Promise<void> {
    if (state.started) await state.started.catch(() => {})
    await message.after
    if (message.dropped) return
    if (state.ended || state.closing || !state.connection || !state.sessionId) return
    // A message that waited enters the conversation now, at the start of its
    // own turn: after the answer before it, never under it (PRDCT-4566).
    const waited = state.waiting.indexOf(message)
    if (waited >= 0) {
      state.waiting.splice(waited, 1)
      this.emitWaiting(state)
      this.emit(state, message.event)
      this.emit(state, { type: 'state_change', state: 'working' })
    }
    if (message.stopsBefore !== state.stops) {
      this.endTurn(state, true)
      return
    }
    if (message.failedBefore !== state.failedSwitches) {
      this.notice(
        state,
        `${this.label} could not take the stricter mode picked before this message, so it was not sent`
      )
      this.endTurn(state, false)
      return
    }
    state.turnRunning = true
    let stopReason = ''
    // The style goes with the conversation's first prompt, once, in the text
    // the agent is sent; the message the views were streamed stays the one
    // the person wrote (PRDCT-5166).
    const style = state.styleOwed
    state.styleOwed = undefined
    const prompt = style ? withStyleFirst(message.prompt, style) : message.prompt
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

  /** The person takes back a message that still waits (PRDCT-4566): it
   *  leaves the list and its turn never goes. One the agent has taken is
   *  part of the conversation already: nothing to take back. */
  private withdraw(state: HandleState, id: string): void {
    const index = state.waiting.findIndex((message) => message.id === id)
    if (index < 0) return
    const [message] = state.waiting.splice(index, 1)
    message.dropped = true
    this.letGo(state, 'withdrawn', [message])
  }

  /** Every message that still waits leaves unsent, back to the composer: the
   *  person stopped the turn, or the session ended (PRDCT-4566). */
  private handBack(state: HandleState, why: Exclude<Returned, 'withdrawn'>): void {
    if (!state.waiting.length) return
    const returned = state.waiting.splice(0)
    for (const message of returned) message.dropped = true
    this.letGo(state, why, returned)
  }

  /** Messages that left the list unsent (PRDCT-4566): the person's own back
   *  to the composer as `why`; another tab's never, dropped with one quiet
   *  line in the conversation naming its tab. */
  private letGo(state: HandleState, why: Returned, messages: Outgoing[]): void {
    const { own, notices } = splitUnsent(messages, (message) => message.event.text)
    this.emitWaiting(state, own.length ? why : undefined, own)
    for (const line of notices) this.quietNotice(state, line)
  }

  /** What waits for its turn, whole (PRDCT-4566): the agent takes a message
   *  once the running turn has ended. */
  private emitWaiting(state: HandleState, why?: Returned, returned: Outgoing[] = []): void {
    this.emit(state, {
      type: 'waiting_messages',
      messages: state.waiting.map(waitingOf),
      takes: 'turn',
      ...(why ? { returned: { why, messages: returned.map(waitingOf) } } : {})
    })
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
          this.emitToolCall(state, id, update)
        }
        this.toolEnd(state, id, update)
        return
      }
      case 'tool_call_update': {
        const id = text(update.toolCallId)
        // What the call runs, arrived after the call was shown (OpenCode
        // 2.3.0's `execute` script comes with its `in_progress` update).
        if (id && state.toolCalls.has(id)) this.toolInputArrived(state, id, update)
        this.toolEnd(state, id, update)
        return
      }
      case 'available_commands_update':
        this.storeCommands(state, update)
        return
      case 'config_option_update':
        if (Array.isArray(update.configOptions)) {
          const before = modelOption(state)?.currentValue
          if (this.sessionOptions) this.agentOptions(state, update)
          else state.configOptions = parseConfigOptions(update.configOptions)
          if (modelOption(state)?.currentValue !== before) this.emitMeta(state)
        }
        return
      case 'current_mode_update':
        // The agent's own change (its plan step, `/plan`), and the echo of ours.
        if (this.sessionOptions) this.agentOptions(state, update)
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
      case 'session_info_update': {
        // OpenCode's word that it retries a refused call (a rate limit, its
        // `_meta["opencode/retry"]`), else the chat reads "working" as a
        // hang. One notice, the latest standing for the ones before; null
        // (the retry went out) changes nothing on screen.
        const retry = retryNotice(
          this.label,
          object(update._meta)['opencode/retry'],
          state.launch.env
        )
        if (retry) this.notice(state, retry, RETRY_NOTICE)
        return
      }
      default:
        // user_message_chunk (we emitted the message ourselves),
        // agent_thought_chunk (the chat view shows no model's reasoning, a
        // Claude's or a Codex's included: there is no thinking event to
        // carry it), plan, modes and anything newer: nothing to show.
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

  /** A call shown with the input it carries, remembered for a later one. */
  private emitToolCall(state: HandleState, id: string, update: Record<string, unknown>): void {
    const input = update.rawInput ?? {}
    const name = text(update.title) || text(update.kind) || 'tool'
    state.toolInputs.set(id, { name, json: JSON.stringify(input) })
    this.emit(state, { type: 'tool_call', id, name, input })
  }

  /** A shown call whose input arrived or changed since (PRDCT-4507): shown
   *  again under the same id, the card taking the new input. An empty input
   *  never replaces one already shown. */
  private toolInputArrived(state: HandleState, id: string, update: Record<string, unknown>): void {
    const input = update.rawInput
    if (!hasInput(input)) return
    const json = JSON.stringify(input)
    const shown = state.toolInputs.get(id)
    if (shown?.json === json) return
    const name = text(update.title) || shown?.name || text(update.kind) || 'tool'
    state.toolInputs.set(id, { name, json })
    this.emit(state, { type: 'tool_call', id, name, input })
  }

  /** A completed or failed call becomes its result. */
  private toolEnd(state: HandleState, id: string, update: Record<string, unknown>): void {
    const status = text(update.status)
    if (!id || (status !== 'completed' && status !== 'failed')) return
    if (!state.toolCalls.has(id)) {
      state.toolCalls.add(id)
      this.emitToolCall(state, id, update)
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
      // An input that arrives later (PRDCT-4507) is the call's input.
      else if (hasInput(update.rawInput)) {
        const shown = history.find(
          (item) => item.event.type === 'tool_call' && item.event.id === id
        )
        if (shown?.event.type === 'tool_call')
          shown.event = { ...shown.event, input: update.rawInput }
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
    if (this.sessionOptions && (kind === 'current_mode_update' || kind === 'config_option_update'))
      this.agentOptions(state, update)
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
   *  Codex chat reports a resume it could not replay. Said live and nowhere
   *  else, a refusal at start included: the session's timeline holds every
   *  word said since the spawn, heard or not, so a pane that binds after the
   *  queue was let go reads it there. Kept in the past as well (PRDCT-4427),
   *  a start notice stood twice in the conversation (PRDCT-4664). */
  private notice(state: HandleState, message: string, notice?: string): void {
    if (state.ended) return
    this.emit(state, { type: 'error', message, fatal: false, ...(notice ? { notice } : {}) })
  }

  /** A plain fact of the turn the person caused, where nothing failed
   *  (PRDCT-4566): the notice marked `quiet`, a quiet line of the
   *  conversation rather than a failure. */
  private quietNotice(state: HandleState, message: string): void {
    if (state.ended) return
    this.emit(state, { type: 'error', message, fatal: false, quiet: true })
  }

  /** PRDCT-4507: the launch with Clave's own tools: the tab's MCP config file
   *  from the one issuer, its address as `mcp.servers.clave` in OpenCode's
   *  inline configuration (`opencode acp` reads it, checked on 2.3.0) and
   *  its token under a variable of its own, carried past a login profile
   *  with the connection's. No file: the launch as it was. */
  private withClaveTools(state: HandleState, launch: AcpLaunch): AcpLaunch {
    if (this.claveTools !== 'opencode') return launch
    const endpoint = readClaveMcpEndpoint(lazyTerminalPorts.mcpConfig.write(state.spec.id))
    state.claveTools = true
    if (!endpoint) return launch
    const base: Record<string, string> = {}
    if (launch.env[OPENCODE_CONFIG_ENV]) base[OPENCODE_CONFIG_ENV] = launch.env[OPENCODE_CONFIG_ENV]
    const added = withOpencodeClaveTools(base, endpoint) ?? {}
    return {
      ...launch,
      env: { ...launch.env, ...added },
      connectionVariables: [
        ...new Set([...(launch.connectionVariables ?? []), ...Object.keys(added)])
      ]
    }
  }

  private letGoOfClaveTools(state: HandleState): void {
    if (!state.claveTools) return
    state.claveTools = false
    lazyTerminalPorts.mcpConfig.remove(state.spec.id)
  }

  private exited(state: HandleState, code: number, stderrTail?: string): void {
    if (state.ended) return
    this.letGoOfClaveTools(state)
    if (!state.sessionId && !state.closing && state.exitCode === undefined) {
      // The agent died before it opened a session: a refusal, said as one,
      // in its own last words and with its status (PRDCT-4427). Its pending
      // request fails after this, and the handshake finds the session ended.
      this.notice(state, startRefusal(this.label, code, stderrTail, state.launch.env))
      state.exitCode = code || 1
    } else if (state.turnRunning && !state.closing)
      this.notice(state, `${this.label} stopped during the turn (exit code ${code})`)
    // Nothing that waited is lost with the process: it goes back to the
    // composer, unsent (PRDCT-4566).
    this.handBack(state, 'ended')
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
