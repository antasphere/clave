import { EventEmitter } from 'node:events'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  SessionInputSchema,
  type SessionInput,
  type SessionEvent,
  type ModelOption,
  type CommandOption
} from '../../../shared/session-model'
import { buildAgentArgv } from '../../../shared/agent-launch'
import type {
  SessionAdapter,
  SessionAdapterEvents,
  SessionHandle,
  SpawnSpec,
  Unsubscribe
} from '../adapter'
import { resolvePosixShellLaunch } from '../../shell-launch'
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
  isValidModelName,
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
export class ClaudeStreamTranslator {
  readonly permissions = new Map<string, Permission>()
  /** The slash commands (skills included) the CLI named at init. */
  commands: string[] | null = null
  /** request_id → the model a set_model control request asked for. */
  readonly modelRequests = new Map<string, string | null>()
  private streamed = false
  private finished = false
  private tools = new Set<string>()
  constructor(private readonly emit: (event: SessionEvent) => void) {}
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
        message: response.data.error ?? `Claude refused to switch to ${model ?? 'the default model'}`,
        fatal: false
      })
    return true
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
        if (block.type === 'text' && p.type === 'assistant' && !this.streamed) {
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
    } else if (p.type === 'control_response' && this.modelRequest(p)) {
      // Answered above: the switch either took, or the CLI said why not.
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
      this.emit({
        type: 'permission_request',
        id,
        description: r.description
          ? `Allow ${r.tool_name}: ${r.description}`
          : `Allow ${r.tool_name}?`,
        toolName: r.tool_name,
        input: r.input,
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
      fallback()
      if (!this.permissions.size) this.emit({ type: 'state_change', state: 'working' })
    } else if (p.type === 'result') {
      this.finish()
      this.permissions.clear()
      this.tools.clear()
      if (p.is_error)
        this.emit({
          type: 'error',
          message: typeof p.result === 'string' ? p.result : 'Claude turn failed',
          fatal: false
        })
      fallback()
      this.emit({ type: 'state_change', state: 'done' })
      this.streamed = false
      this.finished = false
    } else fallback()
  }
  private finish(): void {
    if (this.finished) return
    this.finished = true
    this.emit({ type: 'assistant_text', delta: '', final: true })
  }
  response(id: string, optionId: string): unknown {
    const pending = this.permissions.get(id)
    if (!pending) throw new Error(`Unknown Claude permission request: ${id}`)
    if (
      !['allow-once', 'allow-always', 'deny'].includes(optionId) ||
      (optionId === 'allow-always' && !pending.suggestions.length)
    )
      throw new Error('Invalid Claude permission option')
    this.permissions.delete(id)
    return {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: id,
        response:
          optionId === 'deny'
            ? { behavior: 'deny', message: 'Denied by user' }
            : {
                behavior: 'allow',
                updatedInput: pending.input,
                ...(optionId === 'allow-always' ? { updatedPermissions: pending.suggestions } : {})
              }
      }
    }
  }
}

/** The CLI's own notion: 'default' is the model it picks for the account. */
export const CLAUDE_DEFAULT_MODEL = 'default'
export const CLAUDE_MODELS: ModelOption[] = [
  { id: CLAUDE_DEFAULT_MODEL, label: 'Default', hint: "Claude Code's recommended model" },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-opus-5', label: 'Opus 5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }
]

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
  /** The model the session was launched on; the CLI's init frame refines it. */
  model: string | null
  emit: (event: SessionEvent) => void
  finish: (code: number) => void
}

export class ClaudeAdapter implements SessionAdapter {
  readonly id = 'claude-chat'
  readonly provider = 'claude'
  readonly transports = ['events'] as const
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
      commandError:
        context.initialCommand !== undefined || context.autoExecute === true
          ? 'initialCommand and autoExecute are not supported by Claude chat sessions; use a terminal session for shell commands.'
          : undefined,
      emit,
      finish: (code) => {
        if (live.ended) return
        live.ended = true
        live.translator.permissions.clear()
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
      // Start on first input, so subscribe-before-write cannot lose init frames.
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
        const launch = resolvePosixShellLaunch(
          getUserShell(),
          `exec ${argv.map(shellSingleQuote).join(' ')}`
        )
        const child = spawn(launch.file, launch.args, {
          cwd: spec.cwd,
          env: {
            ...buildSpawnEnv(getLoginShellEnv(), {
              configDir: context.configDir,
              oauthToken: accountTokenForSpawn('claude', context.claudeProfileId)
            }),
            CLAVE_SESSION_ID: spec.id
          },
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
    const initialPrompt = live.initialPrompt
    if (initialPrompt !== undefined)
      this.write(handle, { type: 'user_message', text: initialPrompt })
    live.initialPrompt = undefined
    live.ready = true
  }
  write(handle: SessionHandle, raw: Uint8Array | SessionInput): void {
    if (raw instanceof Uint8Array)
      throw new Error('Claude events adapter accepts SessionInput, not raw bytes')
    const input = SessionInputSchema.parse(raw)
    const live = this.live(handle)
    if (live.ended) throw new Error('Claude session has ended')
    if (input.type !== 'user_message' && !live.process)
      throw new Error('Claude session has not started')
    const send = (payload: unknown): void => {
      live.process!.stdin.write(`${JSON.stringify(payload)}\n`)
    }
    if (input.type === 'user_message') {
      live.process ??= live.start()
      live.emit(input)
      // A queued prompt must not hide a permission that still needs an answer.
      if (live.initialized && !live.translator.permissions.size)
        live.emitter.emit('stream', {
          kind: 'event',
          event: { type: 'state_change', state: 'working' }
        })
      send({ type: 'user', message: { role: 'user', content: input.text } })
    } else if (input.type === 'permission_response') {
      send(live.translator.response(input.id, input.optionId))
      if (!live.translator.permissions.size)
        live.emitter.emit('stream', {
          kind: 'event',
          event: { type: 'state_change', state: 'working' }
        })
    } else if (input.type === 'set_model') {
      if (input.model !== null && !isValidModelName(input.model))
        throw new Error('Invalid model name')
      const requestId = randomUUID()
      live.translator.modelRequests.set(requestId, input.model)
      send({
        type: 'control_request',
        request_id: requestId,
        request: { subtype: 'set_model', model: input.model }
      })
    } else
      send({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })
  }
  async commands(handle: SessionHandle): Promise<CommandOption[]> {
    const live = this.live(handle)
    const cwd = this.cwds.get(handle.id) ?? ''
    return toCommands(
      live.translator.commands ?? lastCommandsByCwd.get(cwd) ?? lastCommandsAnywhere
    )
  }
  /** The CLI has no model listing; this is the current family, full ids the CLI accepts. */
  async models(): Promise<ModelOption[]> {
    return CLAUDE_MODELS
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
