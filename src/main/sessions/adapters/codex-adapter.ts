import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { isQuestionAnswerKey } from '../../../../packages/server/src/requests/question-key'
import { codexRoot, findCodexRollout } from '../../session-history/codex'
import { replayCodexHistory } from './codex-history'
import { codexProfilePolicy, type LaunchProfile } from '../../../shared/agent-launch'
import {
  SessionInputSchema,
  userMessageEvent,
  providerPrompt,
  type BackgroundTask,
  type PreparedPrompt,
  type SessionInput,
  type SessionEvent,
  type HistoryItem,
  type ModelOption,
  type CommandOption
} from '../../../shared/session-model'
import type {
  SessionAdapter,
  SessionAdapterEvents,
  SessionHandle,
  SpawnSpec,
  Unsubscribe
} from '../adapter'
import {
  CodexRpcError,
  object,
  spawnCodexAppServer,
  type CodexCallbacks,
  type CodexConnection,
  type RpcNotification,
  type RpcRequest,
  type RpcId
} from './codex-app-server'
import { effortLabel, isValidEffort } from '../../../shared/effort'
import { lazyTerminalPorts } from '../../ports/terminals'
import type { McpConfigPort } from '../../ports/mcp-config'

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
/** The efforts a model/list row says its model takes, with Codex's gloss. */
const codexEfforts = (row: Record<string, unknown>): { id: string; hint: string }[] =>
  (Array.isArray(row.supportedReasoningEfforts) ? row.supportedReasoningEfforts : []).flatMap(
    (entry) => {
      const id = text(object(entry).reasoningEffort)
      return isValidEffort(id) ? [{ id, hint: text(object(entry).description) }] : []
    }
  )
/** Did this completed item fail? The server says so structurally and never in
 *  prose: a command by its exit status, anything else by carrying an `error`.
 *  `undefined` means the item gave no word either way, which is not success. */
const failed = (item: Record<string, unknown>): boolean | undefined => {
  if (text(item.type) === 'commandExecution') {
    const code = item.exitCode
    if (typeof code === 'number' && Number.isFinite(code)) return code !== 0
    // No exit status: a command that never ran says so with `error` instead, and
    // reading only the status dropped a failure the server had stated outright.
  }
  if (item.error === undefined || item.error === null) return undefined
  return text(item.error) !== '' || typeof item.error === 'object'
}
interface Approval {
  rpcId: RpcId
  turnId: string
  responses: Map<string, unknown>
  questions?: Array<{ id: string; question: string }>
}
// Installed Codex 0.163.0 ToolRequestUserInputParams. The provider's question
// IDs identify answers across the connection, shared form and replay boundary.
const nativeQuestions = z.object({
  isBlocking: z.boolean(),
  itemId: z.string(),
  threadId: z.string(),
  turnId: z.string(),
  questions: z
    .array(
      z.object({
        id: z.string().min(1),
        question: z.string().min(1),
        header: z.string(),
        isOther: z.boolean().default(false),
        isSecret: z.boolean().default(false),
        options: z.array(z.object({ label: z.string(), description: z.string() })).nullish()
      })
    )
    .min(1)
    .max(20)
})
/** How full a thread's context is after its last call, off a tokenUsage frame:
 *  what that call read and wrote, less the reasoning, which the next call does
 *  not carry. Raw tokens, like the Claude meter: Codex's own status line also
 *  drops a fixed baseline, so its percentage reads a few points apart by
 *  design. Null when the frame names no usable count. */
const contextOf = (p: Record<string, unknown>): { used: number; window: number | null } | null => {
  const usage = object(p.tokenUsage)
  const last = object(usage.last)
  const reasoning = last.reasoningOutputTokens
  const used =
    typeof last.totalTokens === 'number'
      ? last.totalTokens - (typeof reasoning === 'number' ? reasoning : 0)
      : NaN
  if (!Number.isFinite(used) || used <= 0) return null
  const window = usage.modelContextWindow
  return { used, window: typeof window === 'number' && window > 0 ? window : null }
}
/** The states in which a v1 collaboration agent no longer runs, and those in
 *  which it runs (again). */
const AGENT_ENDED = new Set(['completed', 'errored', 'shutdown', 'notFound', 'interrupted'])
const AGENT_RUNNING = new Set(['pendingInit', 'running'])
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '') : []
/** A command as Codex parsed it ("sleep 30 && echo done"), else as it ran
 *  (the login-shell wrapper included). */
const commandOf = (item: Record<string, unknown>): string => {
  const actions = Array.isArray(item.commandActions) ? item.commandActions.map(object) : []
  return (actions.length === 1 && text(actions[0].command)) || text(item.command)
}

/** State belongs to this connection, never to terminal titles or body heuristics. */
export class CodexTranslator {
  threadId = ''
  turnId = ''
  completedTurnId = ''
  model: string | null = null
  /** The effort the thread reply named: what a turn with none runs at. */
  threadEffort: string | null = null
  readonly approvals = new Map<string, Approval>()
  private metadataEmitted = false
  private streamed = new Map<string, string>()
  /** What runs past the turn, by id: a subagent by its own thread, a command
   *  by its item. A subagent's thread is listed here, which is how its frames
   *  are told from a stranger's; both kinds stay off the transcript. */
  private readonly background = new Map<string, BackgroundTask>()
  /** The main thread's commands running now, by item id. Codex says nothing
   *  when a command is left running mid-turn; a turn that completes while one
   *  is still in progress is its word that the command outlives the turn. */
  private readonly running = new Map<string, { turnId: string; task: BackgroundTask }>()
  /** Every subagent this connection has seen, by thread, listed or not: an
   *  agent given more work after it finished runs again on the same thread,
   *  and Codex's follow-up names neither its path nor its model. */
  private readonly agents = new Map<string, Pick<BackgroundTask, 'description' | 'model'>>()
  constructor(private emit: (event: SessionEvent) => void) {}

  /** Publish the background list whole; a snapshot replaces the last. */
  private publishBackground(): void {
    this.emit({ type: 'background_tasks', tasks: [...this.background.values()] })
  }
  /** Nothing outlives the app-server: its exit empties the list, once. */
  clearBackground(): void {
    this.running.clear()
    this.agents.clear()
    if (!this.background.size) return
    this.background.clear()
    this.publishBackground()
  }
  private listAgent(thread: string, description: string, model: string): boolean {
    if (!thread || this.background.has(thread)) return false
    this.agents.set(thread, { description, ...(model ? { model } : {}) })
    return this.relist(thread)
  }
  /** List a known subagent for a run of its own, as it was first named. */
  private relist(thread: string): boolean {
    const known = this.agents.get(thread)
    if (!known || this.background.has(thread)) return false
    this.background.set(thread, { id: thread, kind: 'agent', ...known, startedAt: Date.now() })
    return true
  }
  /** A frame of a subagent's own thread. Its usage reads under its row; its
   *  text, tools and turns are its own and never the conversation's, so they
   *  stay provider events. False for a thread no listed subagent runs on. */
  private childFrame(frame: RpcNotification, thread: string): boolean {
    // A known agent's thread starting a turn is its next run: work sent to
    // it after it finished (Codex 0.162.1 says `interacted`, then this).
    if (frame.method === 'turn/started' && this.relist(thread)) {
      this.publishBackground()
      return true
    }
    const task = this.background.get(thread)
    if (task?.kind !== 'agent') return false
    const p = object(frame.params)
    if (frame.method === 'thread/tokenUsage/updated') {
      const context = contextOf(p)
      if (!context) return false
      this.emit({ type: 'context_usage', used: context.used, window: null, parent: thread })
      return true
    }
    if (frame.method === 'thread/closed') {
      this.background.delete(thread)
      this.publishBackground()
      return true
    }
    return false
  }
  /** The v2 multi-agent lifecycle: Codex's own record of a subagent starting
   *  and ending, on the parent thread. False when it changes nothing. */
  private subAgentActivity(item: Record<string, unknown>): boolean {
    const thread = text(item.agentThreadId)
    const kind = text(item.kind)
    if (kind === 'started') {
      const name = text(item.agentPath).split('/').filter(Boolean).at(-1) ?? ''
      return this.listAgent(thread, name || thread, text(item.model))
    }
    if (kind === 'completed' || kind === 'interrupted') return this.background.delete(thread)
    return false
  }
  /** The v1 collaboration tools: a completed spawn lists its agents, a
   *  completed close ends them, and any call's last known states end those
   *  no longer running and list again a known one running anew (a resumed
   *  or re-tasked agent). False when it changes nothing. */
  private collabCall(item: Record<string, unknown>, completed: boolean): boolean {
    let changed = false
    const done = completed && text(item.status) === 'completed'
    const receivers = strings(item.receiverThreadIds)
    if (done && text(item.tool) === 'spawnAgent')
      for (const thread of receivers)
        changed = this.listAgent(thread, text(item.prompt) || thread, text(item.model)) || changed
    if (done && text(item.tool) === 'closeAgent')
      for (const thread of receivers) changed = this.background.delete(thread) || changed
    for (const [thread, state] of Object.entries(object(item.agentsStates))) {
      const status = text(object(state).status)
      if (AGENT_ENDED.has(status)) changed = this.background.delete(thread) || changed
      else if (AGENT_RUNNING.has(status)) changed = this.relist(thread) || changed
    }
    return changed
  }

  metadata(result: unknown): void {
    const r = object(result)
    this.threadId = text(object(r.thread).id) || this.threadId
    this.model = text(r.model) || text(object(r.thread).model) || this.model
    if (this.metadataEmitted) return
    this.metadataEmitted = true
    this.emit({ type: 'session_meta', model: this.model, providerSessionId: this.threadId || null })
    // The thread's effort as the app-server resolved it (the config's, else
    // the model's default); absent on a server too old to say.
    if ('reasoningEffort' in r) {
      this.threadEffort = text(r.reasoningEffort) || null
      this.emit({ type: 'effort', effort: this.threadEffort })
    }
  }
  notification(frame: RpcNotification): void {
    const p = object(frame.params)
    const item = object(p.item)
    const id = text(item.id)
    const fallback = (): void =>
      this.emit({ type: 'provider_event', provider: 'codex', payload: frame })
    const threadId = text(p.threadId) || text(object(p.thread).id)
    if (this.threadId && threadId && threadId !== this.threadId) {
      if (!this.childFrame(frame, threadId)) fallback()
      return
    }
    switch (frame.method) {
      case 'thread/started':
        // The start/resume reply owns the complete model metadata. Preserve the
        // notification, but emit session_meta only once from that reply.
        this.threadId = text(object(p.thread).id) || this.threadId
        fallback()
        return
      case 'thread/settings/updated': {
        // The app-server's word on the thread's effort, when it gives one;
        // 0.159 sends none for a per-turn effort (checked 2026-09-30).
        const settings = object(p.threadSettings)
        if ('effort' in settings)
          this.emit({ type: 'effort', effort: text(settings.effort) || null })
        else fallback()
        return
      }
      case 'turn/started':
        this.turnId = text(object(p.turn).id)
        this.emit({ type: 'state_change', state: 'working' })
        return
      case 'item/agentMessage/delta': {
        const delta = text(p.delta)
        const itemId = text(p.itemId)
        this.streamed.set(itemId, (this.streamed.get(itemId) ?? '') + delta)
        this.emit({ type: 'assistant_text', delta, final: false })
        return
      }
      case 'item/started':
      case 'item/completed': {
        const completed = frame.method === 'item/completed'
        if (item.type === 'agentMessage' && completed) {
          const previous = this.streamed.get(id) ?? ''
          const full = text(item.text)
          // Some servers send only completed items; don't duplicate streamed text.
          const delta = full.startsWith(previous) ? full.slice(previous.length) : ''
          this.streamed.delete(id)
          this.emit({ type: 'assistant_text', delta, final: true })
          return
        }
        if (item.type === 'subAgentActivity' || item.type === 'collabAgentToolCall') {
          const changed =
            item.type === 'subAgentActivity'
              ? this.subAgentActivity(item)
              : this.collabCall(item, completed)
          if (changed) this.publishBackground()
          else fallback()
          return
        }
        if (item.type === 'commandExecution') {
          // A poll of a running process is not a process of its own: the
          // command that started it is the one listed.
          if (!completed && item.source !== 'unifiedExecInteraction')
            this.running.set(id, {
              turnId: text(p.turnId) || this.turnId,
              task: {
                id,
                kind: 'shell',
                description: commandOf(item),
                toolUseId: id,
                startedAt: Date.now()
              }
            })
          if (completed) {
            this.running.delete(id)
            if (this.background.delete(id)) this.publishBackground()
          }
        }
        if (['commandExecution', 'fileChange', 'mcpToolCall'].includes(text(item.type))) {
          if (!completed)
            this.emit({
              type: 'tool_call',
              id,
              name:
                item.type === 'mcpToolCall'
                  ? `${text(item.server)}/${text(item.tool)}`
                  : text(item.type),
              input: item
            })
          else
            this.emit({
              type: 'tool_result',
              id,
              output:
                item.type === 'commandExecution'
                  ? // A command that never ran has no aggregated output, and its
                    // reason is the only thing there is to show.
                    (item.aggregatedOutput ?? item.error)
                  : item.type === 'fileChange'
                    ? item.changes
                    : (item.result ?? item.error),
              error: failed(item)
            })
          return
        }
        fallback()
        return
      }
      case 'turn/completed': {
        const turn = object(p.turn)
        const stale = !!(this.turnId && text(turn.id) && text(turn.id) !== this.turnId)
        // What the turn left running is listed before the turn says it ended,
        // so the view never shows a moment with the work unlisted.
        let promoted = false
        for (const [id, work] of this.running) {
          if (stale && work.turnId !== text(turn.id)) continue
          this.background.set(id, work.task)
          this.running.delete(id)
          promoted = true
        }
        if (promoted) this.publishBackground()
        if (turn.status === 'interrupted') {
          // An interruption marker belongs to the current transcript turn.
          if (stale) fallback()
          else this.emit({ type: 'turn_interrupted' })
        } else if (turn.error)
          this.emit({
            type: 'error',
            message: text(object(turn.error).message) || 'Codex turn failed',
            fatal: false
          })
        for (const [id, approval] of this.approvals)
          if (approval.turnId === text(turn.id)) this.approvals.delete(id)
        this.completedTurnId = text(turn.id)
        // Keep the old turn's outcome and cleanup without resetting the new
        // active turn or clearing its streamed text.
        if (stale) return
        this.turnId = ''
        this.streamed.clear()
        this.emit({ type: 'state_change', state: 'done' })
        return
      }
      case 'thread/tokenUsage/updated': {
        // After every call: `last` is that call, `total` the thread's sum.
        const context = contextOf(p)
        if (!context) {
          fallback()
          return
        }
        this.emit({ type: 'context_usage', used: context.used, window: context.window })
        return
      }
      case 'serverRequest/resolved': {
        this.approvals.delete(JSON.stringify(p.requestId))
        fallback()
        if (!this.approvals.size && this.turnId)
          this.emit({ type: 'state_change', state: 'working' })
        return
      }
      case 'error':
        this.emit({
          type: 'error',
          message: text(object(p.error).message) || 'Codex protocol error',
          fatal: p.willRetry === false
        })
        return
      default:
        fallback()
    }
  }

  request(frame: RpcRequest): boolean {
    const p = object(frame.params)
    const responses = new Map<string, unknown>()
    let questions: z.infer<typeof nativeQuestions>['questions'] | undefined
    if (
      frame.method === 'item/commandExecution/requestApproval' ||
      frame.method === 'item/fileChange/requestApproval'
    ) {
      const decisions = Array.isArray(p.availableDecisions)
        ? p.availableDecisions
        : ['accept', 'acceptForSession', 'decline', 'cancel']
      for (const decision of decisions) {
        const id = typeof decision === 'string' ? decision : JSON.stringify(decision)
        responses.set(id, { decision })
      }
    } else if (frame.method === 'execCommandApproval' || frame.method === 'applyPatchApproval') {
      for (const decision of ['approved', 'approved_for_session', 'abort'])
        responses.set(decision, { decision })
    } else if (frame.method === 'item/permissions/requestApproval') {
      // Option ids serialize the protocol's real response, not invented decisions.
      for (const response of [
        { permissions: {}, scope: 'turn' },
        {
          permissions: Object.fromEntries(
            Object.entries(object(p.permissions)).filter(([, value]) => value != null)
          ),
          scope: 'turn'
        }
      ])
        responses.set(JSON.stringify(response), response)
    } else if (frame.method === 'item/tool/requestUserInput') {
      const decoded = nativeQuestions.safeParse(frame.params)
      if (!decoded.success) return false
      questions = decoded.data.questions
      if (questions.some((q) => !isQuestionAnswerKey(q.id))) return false
      if (new Set(questions.map((q) => q.id)).size !== questions.length) return false
      responses.set('answer', undefined)
      responses.set('deny', { answers: {} })
    } else if (frame.method === 'mcpServer/elicitation/request') {
      // v1 has choices, not a form editor: decline/cancel are always valid.
      for (const action of ['decline', 'cancel'])
        responses.set(action, { action, content: null, _meta: null })
    } else {
      this.emit({ type: 'provider_event', provider: 'codex', payload: frame })
      this.emit({
        type: 'error',
        message: `Unsupported Codex server request: ${frame.method}`,
        fatal: false
      })
      return false
    }
    const id = JSON.stringify(frame.id)
    this.approvals.set(id, {
      rpcId: frame.id,
      turnId: text(p.turnId) || this.turnId,
      responses,
      ...(questions && { questions })
    })
    this.emit({
      type: 'permission_request',
      id,
      description:
        questions?.length === 1
          ? questions[0].question
          : questions
            ? `Codex asks ${questions.length} questions`
            : text(p.reason) || text(p.message) || text(p.command) || frame.method,
      options: [...responses.keys()].map((id, index) => ({
        id,
        label: questions
          ? id === 'answer'
            ? 'Submit'
            : 'Skip'
          : frame.method === 'item/permissions/requestApproval'
            ? index === 0
              ? 'Deny extra permissions'
              : 'Allow for this turn'
            : id
      })),
      toolName: frame.method,
      input: frame.params,
      ...(questions && {
        questions: questions.map((q) => ({
          id: q.id,
          question: q.question,
          header: q.header,
          options: q.options ?? []
        }))
      })
    })
    this.emit({ type: 'state_change', state: 'blocked' })
    return true
  }
  answer(
    id: string,
    optionId: string,
    connection: CodexConnection,
    answers?: Record<string, string>
  ): void {
    const approval = this.approvals.get(id)
    if (!approval || !approval.responses.has(optionId))
      throw new Error('Unknown or expired Codex approval option')
    let response = approval.responses.get(optionId)
    if (approval.questions && optionId === 'answer') {
      if (
        !answers ||
        Object.keys(answers).length !== approval.questions.length ||
        approval.questions.some(
          (q) =>
            !Object.hasOwn(answers, q.id) ||
            typeof answers[q.id] !== 'string' ||
            !answers[q.id].trim()
        )
      )
        throw new Error('An answer is required for each Codex question')
      response = {
        answers: Object.fromEntries(
          approval.questions.map((q) => [q.id, { answers: [answers[q.id]] }])
        )
      }
    }
    connection.respond(approval.rpcId, response)
    this.approvals.delete(id)
    if (!this.approvals.size && this.turnId) this.emit({ type: 'state_change', state: 'working' })
  }
}

interface HandleState {
  spec: SpawnSpec
  history: HistoryItem[]
  /** The thread a resumed session replays, until `replayPast` has read it. */
  pastOf?: { thread: string; root: string }
  historyError?: unknown
  profile?: LaunchProfile
  env?: Record<string, string>
  mcpConfig?: McpConfigPort
  /** A model chosen after launch; every later turn/start carries it. */
  model?: string | null
  /** The effort chosen at launch or since; every later turn/start carries it
   *  while the turn's model takes it. */
  effort?: string
  /** The last model/list answer, to check that effort against the model. */
  listing?: unknown[]
  /** A model/list that failed or timed out: not asked again at every turn,
   *  only by the picker, whose answer fills the listing again. */
  listingFailed?: boolean
  /** The last effort the view was told, so that what a turn carries is said
   *  whenever it changes, and said once. Undefined until anything was. */
  announced?: string | null
  emitter: EventEmitter
  translator: CodexTranslator
  connection?: CodexConnection
  ready?: Promise<void>
  /** The launch's prompt, sent as the first message at ready and consumed
   *  then, the way the Claude adapter does it: a restart or an account move
   *  never resends it. */
  initialPrompt?: string
  /** Serializes delivery requests, not whole turns: a follow-up waits for a
   *  pending start/steer reply, then targets whichever turn is still active. */
  turnRequest?: Promise<void>
  ended: boolean
  closing: boolean
}
export class CodexAdapter implements SessionAdapter {
  readonly id = 'codex-chat'
  readonly provider = 'codex'
  readonly transports = ['events'] as const
  readonly images = true
  private handles = new Map<string, HandleState>()
  /** The past of a session whose app-server ended, kept until its tab is
   *  closed (`kill`): the tab stays open on an ended chat, and asking for its
   *  past answered an unknown session, a 500 the pane read as no past at all
   *  (PRDCT-3526). */
  private pasts = new Map<string, HistoryItem[]>()
  private profiles = new Map<
    string,
    { profile: LaunchProfile; env?: Record<string, string>; initialPrompt?: string }
  >()
  constructor(
    private connect: (
      cwd: string,
      callbacks: CodexCallbacks,
      profile?: LaunchProfile,
      env?: Record<string, string>
    ) => CodexConnection = spawnCodexAppServer
  ) {}

  /** Main-only launch context: the profile and the environment the
   *  app-server starts with (a Codex account's `CODEX_HOME`), and the
   *  launch's prompt when it has one. Never part of the Session record or
   *  the wire. */
  configure(
    id: string,
    profile: LaunchProfile,
    env?: Record<string, string>,
    initialPrompt?: string
  ): void {
    this.profiles.set(id, { profile: structuredClone(profile), env, initialPrompt })
  }

  async spawn(spec: SpawnSpec): Promise<SessionHandle> {
    if (this.handles.has(spec.id)) throw new Error(`Codex session already exists: ${spec.id}`)
    this.pasts.delete(spec.id)
    const emitter = new EventEmitter()
    const context = this.profiles.get(spec.id)
    const launchEffort = text(object(spec.options).effort)
    const state: HandleState = {
      spec,
      history: [],
      ...(launchEffort && isValidEffort(launchEffort) ? { effort: launchEffort } : {}),
      profile: context?.profile,
      env: context?.env,
      initialPrompt: context?.initialPrompt,
      emitter,
      translator: new CodexTranslator((event) => {
        if (event.type === 'effort') state.announced = event.effort
        emitter.emit('stream', { kind: 'event', event })
      }),
      ended: false,
      closing: false
    }
    // The past is replayed at the first read of the history or before the
    // process starts, whichever comes first: never inside the spawn, which a
    // launch restoring a hundred chats runs a hundred times while most of
    // them are never looked at (PRDCT-3527: a long thread cost up to 0.9 s of
    // the server's time at every restore).
    const resume = text(object(spec.options).resume)
    if (resume) state.pastOf = { thread: resume, root: codexRoot(context?.env) }
    this.profiles.delete(spec.id)
    this.handles.set(spec.id, state)
    return { id: spec.id }
  }
  async attach(id: string): Promise<SessionHandle> {
    this.require({ id })
    return { id }
  }

  /** Snapshot the conversation before the process can append new turns. The
   *  views page this past separately from the live stream, including after
   *  switching views, so it must hold only what was there at launch. */
  private replayPast(state: HandleState): void {
    const past = state.pastOf
    if (!past) return
    state.pastOf = undefined
    try {
      const path = findCodexRollout(past.thread, past.root)
      if (path) state.history = replayCodexHistory(readFileSync(path, 'utf8').split('\n'))
    } catch (error) {
      state.historyError = error
    }
  }

  history(handle: SessionHandle): HistoryItem[] {
    const past = this.handles.has(handle.id) ? undefined : this.pasts.get(handle.id)
    if (past) return past
    const state = this.require(handle)
    this.replayPast(state)
    if (state.historyError) {
      this.error(
        state,
        new Error(`Could not replay the conversation: ${String(state.historyError)}`),
        false
      )
      state.historyError = undefined
    }
    return state.history
  }

  write(handle: SessionHandle, input: Uint8Array | SessionInput): void {
    if (input instanceof Uint8Array)
      throw new Error('Codex chat accepts structured SessionInput, not raw terminal bytes')
    const value = SessionInputSchema.parse(input)
    const state = this.require(handle)
    if (state.ended || state.closing) throw new Error('Codex session has ended')
    if (value.type === 'permission_response') {
      if (!state.connection) throw new Error('Codex has no pending approval')
      state.translator.answer(value.id, value.optionId, state.connection, value.answers)
      return
    }
    if (value.type === 'interrupt') {
      void this.interrupt(state).catch((error) => this.error(state, error, false))
      return
    }
    if (value.type === 'set_model') {
      // Codex takes the model per turn, so the switch is recorded here and
      // announced now; the next turn/start is what actually carries it.
      state.model = value.model
      state.emitter.emit('stream', {
        kind: 'event',
        event: {
          type: 'session_meta',
          model: value.model ?? state.translator.model,
          providerSessionId: state.translator.threadId || null
        }
      })
      return
    }
    if (value.type === 'set_effort') {
      // Per turn, like the model: recorded and announced now, carried by the
      // next turn/start. The app-server says nothing back (0.159 sends no
      // settings notification for it), so what the view shows after a pick
      // is this record; a level the model refuses is kept off the turn below.
      state.effort = value.effort
      // Always said, even when it is the level last announced: a pick is the
      // reader's, and a view that bound after that announcement catches up.
      state.announced = undefined
      this.announce(state, value.effort)
      return
    }
    if (value.type === 'set_permission_mode')
      throw new Error('Codex chat does not offer permission modes')
    if (value.type === 'stop_task') throw new Error('Codex chat cannot stop one background task')
    const prompt = providerPrompt(value)
    state.emitter.emit('stream', { kind: 'event', event: userMessageEvent(value) })
    state.turnRequest = (state.turnRequest ?? Promise.resolve())
      .then(() => this.sendTurn(state, prompt))
      .catch((error) => this.error(state, error, !state.translator.threadId))
  }
  /** Bring the thread up as soon as the view is looking, so thread/start's
   *  reply names the model before the first message rather than after it,
   *  and send the launch's prompt as the first message, once. The prompt is
   *  not gated on `state.ready`: the model picker may have started the thread
   *  before any view subscribed, and the prompt still has to go. */
  ready(handle: SessionHandle): void {
    const state = this.require(handle)
    if (state.ended || state.closing) return
    if (!state.ready)
      this.start(state).catch(() => {
        // start() has already reported the failure on the stream.
      })
    const prompt = state.initialPrompt
    if (prompt === undefined) return
    // Only a write that accepted the prompt consumes the one-shot.
    this.write(handle, { type: 'user_message', text: prompt })
    state.initialPrompt = undefined
  }
  /** The app-server's model/list, once the connection is up; a stub that never
   *  answers must not hang the picker, hence the deadline. */
  async models(handle: SessionHandle): Promise<ModelOption[]> {
    const state = this.require(handle)
    if (state.ended || state.closing) throw new Error('Codex session has ended')
    await this.start(state)
    if (!state.connection) throw new Error('Codex is not connected')
    const rows = await this.listModels(state)
    return rows.flatMap((row) => {
      const r = object(row)
      const id = text(r.model) || text(r.id)
      if (!id || r.hidden === true) return []
      const hint = text(r.description)
      const efforts = codexEfforts(r).map((effort) => ({
        id: effort.id,
        label: effortLabel(effort.id),
        ...(effort.hint ? { hint: effort.hint } : {})
      }))
      const defaultEffort = text(r.defaultReasoningEffort)
      return [
        {
          id,
          label: text(r.displayName) || id,
          ...(hint ? { hint } : {}),
          ...(efforts.length ? { efforts } : {}),
          ...(defaultEffort ? { defaultEffort } : {})
        }
      ]
    })
  }
  /** The app-server's model/list rows, kept for the effort check; a stub that
   *  never answers must not hang the picker, hence the deadline. */
  private async listModels(state: HandleState): Promise<unknown[]> {
    const listing = state.connection!.request('model/list', {})
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Codex did not list its models in time')), 5000)
    })
    try {
      const result = object(await Promise.race([listing, deadline]))
      state.listing = Array.isArray(result.data) ? result.data : []
      state.listingFailed = false
      return state.listing
    } catch (error) {
      state.listingFailed = true
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
  /** The effort this turn carries: the chosen one, only once the model list
   *  says the turn's model takes it. The app-server forwards any level to the
   *  API, which fails the whole turn on one the model does not take ("max"
   *  on a model that stops at xhigh), so nothing unchecked goes out. A model
   *  that does not list it (a remembered Ultra on a model that stops at Max)
   *  runs at its own default, the choice forgotten. A list that cannot be had,
   *  or that does not name the model, sends no effort either, the choice kept
   *  for a model the list does name; either way the view is told what the
   *  thread runs at. */
  private async turnEffort(state: HandleState): Promise<string | undefined> {
    const effort = state.effort
    if (!effort) return undefined
    const rows =
      state.listing ??
      (state.listingFailed ? undefined : await this.listModels(state).catch(() => undefined))
    const model = state.model ?? state.translator.model
    const row = rows?.map(object).find((r) => model && (text(r.model) || text(r.id)) === model)
    if (row && codexEfforts(row).some((e) => e.id === effort)) {
      // A choice kept through a missing list goes out now: the view is told,
      // or it would still show the level announced in its place.
      this.announce(state, effort)
      return effort
    }
    if (row) state.effort = undefined
    this.announce(state, (row && text(row.defaultReasoningEffort)) || state.translator.threadEffort)
    return undefined
  }
  private announce(state: HandleState, effort: string | null): void {
    if (state.announced === effort) return
    state.announced = effort
    state.emitter.emit('stream', { kind: 'event', event: { type: 'effort', effort } })
  }

  /** The skills the app-server finds for this folder; a Codex skill is invoked
   *  by mentioning it as $name in the message. */
  async commands(handle: SessionHandle): Promise<CommandOption[]> {
    const state = this.require(handle)
    if (state.ended || state.closing) throw new Error('Codex session has ended')
    await this.start(state)
    if (!state.connection) throw new Error('Codex is not connected')
    const listing = state.connection.request('skills/list', { cwds: [state.spec.cwd] })
    const deadline = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Codex did not list its skills in time')), 5000)
    )
    const result = object(await Promise.race([listing, deadline]))
    const folders = Array.isArray(result.data) ? result.data : []
    return folders.flatMap((folder) => {
      const skills = object(folder).skills
      return (Array.isArray(skills) ? skills : []).flatMap((row) => {
        const r = object(row)
        const name = text(r.name)
        if (!name || r.enabled === false) return []
        const description = text(r.shortDescription) || text(r.description)
        return [{ name, insert: `$${name} `, ...(description ? { description } : {}) }]
      })
    })
  }
  private async sendTurn(
    state: HandleState,
    prompt: PreparedPrompt,
    recoverCompleted = true
  ): Promise<void> {
    await this.start(state)
    if (state.ended || state.closing) return
    const effort = state.translator.turnId ? undefined : await this.turnEffort(state)
    if (state.ended || state.closing) return
    // Images are input items of their own, as a data URL, the way the
    // app-server's turn/start and turn/steer take them.
    const input = [
      ...(prompt.text ? [{ type: 'text', text: prompt.text, text_elements: [] }] : []),
      ...prompt.images.map((image) => ({
        type: 'image',
        url: `data:${image.mimeType};base64,${image.data}`
      }))
    ]
    const turnId = state.translator.turnId
    if (turnId) {
      try {
        await state.connection!.request('turn/steer', {
          threadId: state.translator.threadId,
          expectedTurnId: turnId,
          input
        })
      } catch (error) {
        // Codex can finish before its completion notification reaches us.
        // This explicit precondition refusal confirms input was not consumed.
        // Unknown errors and timeouts remain visible, without replay.
        if (
          !recoverCompleted ||
          !(error instanceof CodexRpcError) ||
          error.code !== -32600 ||
          error.message !== 'no active turn to steer' ||
          (state.translator.turnId && state.translator.turnId !== turnId)
        )
          throw error
        state.translator.turnId = ''
        await this.sendTurn(state, prompt, false)
      }
      return
    }
    const result = await state.connection!.request('turn/start', {
      threadId: state.translator.threadId,
      input,
      ...(state.model ? { model: state.model } : {}),
      ...(effort ? { effort } : {})
    })
    const turn = object(object(result).turn)
    if (
      !state.translator.turnId &&
      turn.status === 'inProgress' &&
      text(turn.id) !== state.translator.completedTurnId
    )
      state.translator.turnId = text(turn.id)
  }
  private start(state: HandleState): Promise<void> {
    if (state.ready) return state.ready
    this.replayPast(state)
    state.ready = (async () => {
      const options = object(state.spec.options)
      // The launch's own choice (Clave's dangerous mode) first, then what the
      // profile's flags ask for, then the defaults; an absent sandbox leaves
      // the one Codex's config gives the folder.
      const profilePolicy = state.profile ? codexProfilePolicy(state.profile) : {}
      const launchMode = text(options.permissionMode)
      if (launchMode && !['on-request', 'never'].includes(launchMode))
        throw new Error(`Unsupported Codex permissionMode: ${launchMode}`)
      // A profile may also ask for `untrusted`, already checked by its parser.
      const permissionMode = launchMode || profilePolicy.approvalPolicy || 'on-request'
      const sandbox = text(options.sandbox) || profilePolicy.sandbox
      if (sandbox && !['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox))
        throw new Error(`Unsupported Codex sandbox: ${sandbox}`)
      // Reuse the same private per-tab credential issuer as the terminal and
      // Claude adapters. Only its environment variable name crosses JSON-RPC.
      state.mcpConfig = lazyTerminalPorts.mcpConfig
      await state.mcpConfig.ready?.()
      if (state.ended || state.closing) return
      const configPath = state.mcpConfig.write(state.spec.id)
      if (!configPath) throw new Error('Clave MCP is unavailable for this Codex session')
      let url: string
      let token: string
      try {
        const server = object(object(JSON.parse(readFileSync(configPath, 'utf8'))).mcpServers)
        const clave = object(server.clave)
        url = text(clave.url)
        const authorization = text(object(clave.headers).Authorization)
        token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
        const endpoint = new URL(url)
        if (
          endpoint.protocol !== 'http:' ||
          !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
          !token
        )
          throw new Error('Invalid Clave MCP config')
      } catch {
        throw new Error("Could not read this Codex session's private Clave MCP config")
      }
      state.env = {
        // The cached login/account snapshot is authoritative, including
        // variables it intentionally omitted from the host environment.
        ...(state.env ?? process.env),
        CLAVE_SESSION_ID: state.spec.id,
        CLAVE_CODEX_MCP_TOKEN: token
      } as Record<string, string>
      state.connection = this.connect(
        state.spec.cwd,
        {
          notification: (frame) => {
            if (!state.ended) state.translator.notification(frame)
          },
          request: (frame) => {
            if (!state.ended && !state.translator.request(frame))
              state.connection!.reject(frame.id, `Unsupported request: ${frame.method}`)
          },
          error: (error) => this.error(state, error, true),
          exit: (code, stderr) => {
            if (code !== 0 && !state.closing)
              this.error(
                state,
                new Error(
                  `Codex app-server exited with code ${code}${stderr?.trim() ? `: ${stderr.trim()}` : ''}`
                ),
                true
              )
            this.finish(state, code)
          }
        },
        state.profile,
        state.env
      )
      await state.connection.request('initialize', {
        clientInfo: { name: 'clave_chat', title: 'Clave', version: '1.0.0' }
      })
      state.connection.notify('initialized')
      const resume = text(options.resume)
      // Codex deep-merges MCP tables, even when the override supplies the
      // whole server. A fresh name keeps legacy user transport, authorization
      // headers and tool filters from contaminating this invocation's binding.
      const mcpServerName = `clave_${randomBytes(6).toString('hex')}`
      const result = await state.connection.request(resume ? 'thread/resume' : 'thread/start', {
        ...(resume ? { threadId: resume } : {}),
        cwd: state.spec.cwd,
        ...(text(options.model) ? { model: text(options.model) } : {}),
        ...(sandbox ? { sandbox } : {}),
        approvalPolicy: permissionMode,
        approvalsReviewer: profilePolicy.approvalsReviewer ?? 'user',
        // Add only this invocation's server, preserving existing user MCP
        // servers and the profile's developer instructions. Required
        // makes a failed handshake fail start/resume rather than lose tools.
        config: {
          'shell_environment_policy.set.CLAVE_SESSION_ID': state.spec.id,
          [`mcp_servers.${mcpServerName}`]: {
            url,
            bearer_token_env_var: 'CLAVE_CODEX_MCP_TOKEN',
            enabled: true,
            required: true
          }
        }
      })
      state.translator.metadata(result)
      if (!state.translator.threadId) throw new Error('Codex returned no thread id')
      // A launch effort (the one last picked) is the next turn's; announced
      // as a switch is, the thread's own word following at that turn.
      if (state.effort) this.announce(state, state.effort)
    })().catch(async (error) => {
      this.error(state, error, true)
      if (state.connection) await state.connection.close()
      else this.finish(state, 1)
      throw error
    })
    return state.ready
  }
  private async interrupt(state: HandleState): Promise<void> {
    if (state.turnRequest) await state.turnRequest
    // turn/start can still be awaiting its response; the notification normally
    // supplies the id first. If it has not, wait for that request to finish.
    if (!state.connection || !state.translator.turnId) return
    await state.connection.request('turn/interrupt', {
      threadId: state.translator.threadId,
      turnId: state.translator.turnId
    })
  }
  async kill(handle: SessionHandle): Promise<void> {
    const state = this.handles.get(handle.id)
    if (!state) {
      this.pasts.delete(handle.id)
      return
    }
    state.closing = true
    if (state.connection) await state.connection.close()
    else this.finish(state, 0)
    this.handles.delete(handle.id)
    this.pasts.delete(handle.id)
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
        console.error('Codex consumer failed:', error)
      }
    }
    emitter.on(event, safe)
    return () => {
      emitter.off(event, safe)
    }
  }
  private finish(state: HandleState, code: number): void {
    if (state.ended) return
    state.ended = true
    state.translator.approvals.clear()
    state.translator.clearBackground()
    state.mcpConfig?.remove(state.spec.id)
    state.emitter.emit('stream', { kind: 'event', event: { type: 'state_change', state: 'ended' } })
    state.emitter.emit('exit', code)
    if (this.handles.get(state.spec.id) === state) {
      this.handles.delete(state.spec.id)
      // A kill in progress takes the past with the tab; an end on its own
      // leaves the tab open on it.
      if (!state.closing) this.pasts.set(state.spec.id, state.history)
    }
    state.emitter.removeAllListeners()
  }
  private error(state: HandleState, error: unknown, fatal: boolean): void {
    if (!state.ended && !state.closing)
      state.emitter.emit('stream', {
        kind: 'event',
        event: {
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
          fatal
        }
      })
  }
  private require(handle: SessionHandle): HandleState {
    const state = this.handles.get(handle.id)
    if (!state) throw new Error(`Unknown Codex session: ${handle.id}`)
    return state
  }
}
